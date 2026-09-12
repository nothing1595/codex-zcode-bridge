#!/usr/bin/env node
"use strict";

// Parallel verification for the zcode-codex-bridge:
//   node smoke-parallel.cjs <workspace> [model] [count]       one wrapper process, N concurrent jobs
//   node smoke-parallel.cjs <workspace> [model] --multi N     N wrapper PROCESSES (simulates Codex multi-MCP), N jobs
//   node smoke-parallel.cjs <workspace> [model] --cancel      cancel mid-run; verifies no orphan session
//   node smoke-parallel.cjs <workspace> [model] --cancel-early cancel right after run_task; no session may appear
//   node smoke-parallel.cjs <workspace> [model] --one TAG     internal: one job through a fresh wrapper

const path = require("node:path");
const { spawn } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const { ZCODE_DB, partCount } = require("../desktop/zcode-desktop.cjs");

const nodeExe = process.env.ZCODE_NODE_EXE || process.execPath;
const server = path.join(__dirname, "..", "server", "zcode-worker.cjs");
const workspace = path.resolve(process.argv[2] || path.join(__dirname, ".."));
const model = process.argv[3] || "GLM-High";
const ACTIVE = new Set(["queued", "running", "needs_user_action", "cancelling", "submitting", "submitted"]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Minimal concurrent MCP client over stdio

function createMcpClient() {
  const child = spawn(nodeExe, [server], { stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
  let nextId = 1;
  let buffer = "";
  const pending = new Map();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      try {
        const message = JSON.parse(line);
        const waiter = pending.get(message.id);
        if (waiter) { pending.delete(message.id); waiter(message.result); }
      } catch { /* ignore partial noise */ }
    }
  });
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    setTimeout(() => { if (pending.delete(id)) reject(new Error(`timeout waiting for ${method}`)); }, 120_000).unref();
  });
  const initialize = () => request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke-parallel", version: "1" } })
    .then(() => child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n'));
  const call = (name, args) => request("tools/call", { name, arguments: args }).then((result) => JSON.parse(result.content[0].text));
  return { child, initialize, call, kill: () => child.kill() };
}

async function runJob(client, tag, task) {
  const started = await client.call("run_task", { workspace, task, model, mode: "plan" });
  let state;
  do {
    await sleep(1000);
    state = await client.call("get_status", { job_id: started.job_id });
  } while (ACTIVE.has(state.status));
  return { tag, ...state, client_started_at: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// Overlap proof from ZCode's own turn_usage rows (read-only)

function turnUsageRows(sessionIds) {
  if (sessionIds.filter(Boolean).length === 0) return [];
  const db = new DatabaseSync(ZCODE_DB, { readOnly: true });
  try {
    const placeholders = sessionIds.map(() => "?").join(",");
    return db.prepare(`SELECT session_id, started_at, completed_at, status FROM turn_usage WHERE session_id IN (${placeholders})`).all(...sessionIds);
  } finally { db.close(); }
}

function reportOverlap(jobs) {
  const rows = turnUsageRows(jobs.map((job) => job.session_id));
  console.log("\nturn_usage evidence (epoch ms straight from ZCode's DB):");
  for (const row of rows) console.log(`  ${row.session_id}  ${row.started_at} -> ${row.completed_at}  [${row.status}]`);
  const spans = rows.filter((row) => row.started_at && row.completed_at).sort((a, b) => a.started_at - b.started_at);
  let overlap = false;
  for (let i = 1; i < spans.length; i += 1) {
    if (spans[i].started_at < spans[i - 1].completed_at) overlap = true;
  }
  console.log(`\nexecution overlap: ${overlap ? "YES - jobs ran in parallel" : "NO - jobs were serialized"}`);
  return overlap;
}

function reportJobs(jobs) {
  console.log("\njob results:");
  for (const job of jobs) {
    console.log(`  [${job.tag}] status=${job.status} job=${job.job_id || "-"}`);
    console.log(`    session=${job.session_id || "-"} output="${(job.output || "").slice(0, 60).replace(/\n/g, " ")}"`);
    if (job.diagnostics) console.log(`    diagnostics=${(job.diagnostics || "").slice(0, 300).replace(/\n/g, " | ")}`);
  }
  const allCompleted = jobs.every((job) => job.status === "completed");
  console.log(`all completed: ${allCompleted ? "YES" : "NO"}`);
  return allCompleted;
}

// ---------------------------------------------------------------------------

async function modeSingle(count) {
  const client = createMcpClient();
  try {
    await client.initialize();
    const tasks = Array.from({ length: count }, (_, i) =>
      `Slowly write the numbers from 1 to 40, one per line, then end with the word DONE-${i + 1}. Do not use tools or modify files.`);
    const started = Date.now();
    const jobs = await Promise.all(tasks.map((task, i) => runJob(client, `single-${i + 1}`, task)));
    console.log(`wall clock: ${((Date.now() - started) / 1000).toFixed(1)}s for ${count} jobs`);
    const ok = reportJobs(jobs) && reportOverlap(jobs);
    process.exitCode = ok ? 0 : 1;
  } finally { client.kill(); }
}

async function modeOne(tag) {
  const client = createMcpClient();
  try {
    await client.initialize();
    const job = await runJob(client, tag, `Slowly write the numbers from 1 to 40, one per line, then end with the word DONE-${tag}. Do not use tools or modify files.`);
    console.log(`RESULT ${JSON.stringify({ tag, status: job.status, session_id: job.session_id })}`);
    process.exitCode = job.status === "completed" ? 0 : 1;
  } finally { client.kill(); }
}

async function modeMulti(count) {
  const children = Array.from({ length: count }, (_, i) => new Promise((resolve, reject) => {
    const child = spawn(nodeExe, [__filename, process.argv[2] || ".", model, "--one", `multi-${i + 1}`], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.on("close", (code) => {
      const line = out.split("\n").map((l) => l.trim()).find((l) => l.startsWith("RESULT "));
      if (!line) { reject(new Error(`child multi-${i + 1} produced no RESULT (exit ${code})`)); return; }
      resolve(JSON.parse(line.slice("RESULT ".length)));
    });
  }));
  const started = Date.now();
  const jobs = await Promise.all(children);
  console.log(`${count} independent wrapper processes finished in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  const ok = reportJobs(jobs) && reportOverlap(jobs);
  process.exitCode = ok ? 0 : 1;
}

async function modeCancel() {
  const client = createMcpClient();
  try {
    await client.initialize();
    const started = await client.call("run_task", {
      workspace,
      task: "Write a detailed 500-word essay about the Fourier transform. Do not use tools or modify files.",
      model,
      mode: "plan",
    });
    let state;
    do {
      await sleep(500);
      state = await client.call("get_status", { job_id: started.job_id });
    } while (ACTIVE.has(state.status) && !state.session_id);
    console.log(`cancelling job ${started.job_id} (session ${state.session_id || "unknown"}, status ${state.status})`);
    const cancelled = await client.call("cancel_task", { job_id: started.job_id });
    console.log(`cancel_task -> ${cancelled.status}`);
    do {
      await sleep(1000);
      state = await client.call("get_status", { job_id: started.job_id });
    } while (ACTIVE.has(state.status));
    console.log(`final status: ${state.status}`);

    let orphanFree = true;
    if (state.session_id) {
      const early = partCount(state.session_id);
      await sleep(5000);
      const late = partCount(state.session_id);
      orphanFree = early === late;
      console.log(`part count ${early} -> ${late} after cancel (${orphanFree ? "generation stopped, no orphan" : "STILL GENERATING - orphan!"})`);

      let usage = null;
      for (let i = 0; i < 20 && !usage; i += 1) {
        await sleep(1000);
        usage = turnUsageRows([state.session_id])[0] || null;
      }
      console.log(`turn_usage after cancel: ${usage ? `${usage.status} (${usage.started_at} -> ${usage.completed_at})` : "no row"}`);
      if (usage && usage.status !== "cancelled") orphanFree = false;
    }
    const ok = state.status === "cancelled" && orphanFree;
    console.log(`\ncancel test: ${ok ? "PASS" : "FAIL"} (status=${state.status}, orphan-free=${orphanFree})`);
    process.exitCode = ok ? 0 : 1;
  } finally { client.kill(); }
}

// Cancel immediately after run_task returns, before the submit phase has
// necessarily clicked Send. The job must settle as cancelled and no ZCode
// session carrying this job's nonce may appear afterwards.
async function modeCancelEarly() {
  const client = createMcpClient();
  try {
    await client.initialize();
    const started = await client.call("run_task", {
      workspace,
      task: "Write a detailed 500-word essay about the history of aviation. Do not use tools or modify files.",
      model,
      mode: "plan",
    });
    console.log(`immediate cancel of ${started.job_id}`);
    const cancelled = await client.call("cancel_task", { job_id: started.job_id });
    console.log(`cancel_task -> ${cancelled.status} (phase ${cancelled.phase})`);
    let state;
    do {
      await sleep(1000);
      state = await client.call("get_status", { job_id: started.job_id });
    } while (ACTIVE.has(state.status));
    console.log(`final status: ${state.status}`);

    console.log("watching ZCode DB for an orphan session carrying this job's nonce (15s)...");
    let orphan = null;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !orphan) {
      orphan = sessionByNonce(started.job_id);
      if (!orphan) await sleep(1000);
    }
    if (orphan) {
      console.log(`ORPHAN FOUND: ${orphan.id} created ${new Date(orphan.time_created).toISOString()}`);
    } else {
      console.log("no session ever created - clean cancel");
    }
    const ok = state.status === "cancelled" && !orphan;
    console.log(`\nearly-cancel test: ${ok ? "PASS" : "FAIL"} (status=${state.status}, orphan=${orphan ? orphan.id : "none"})`);
    process.exitCode = ok ? 0 : 1;
  } finally { client.kill(); }
}

function sessionByNonce(jobId) {
  const db = new DatabaseSync(ZCODE_DB, { readOnly: true });
  try {
    return db.prepare(`
      SELECT s.id, s.time_created FROM session s JOIN part p ON p.session_id = s.id
      WHERE p.data LIKE ? AND s.time_created > ? LIMIT 1
    `).get(`%[bridge job ${jobId}]%`, Date.now() - 10 * 60_000) || null;
  } finally { db.close(); }
}

async function main() {
  const flag = process.argv.find((arg) => arg.startsWith("--"));
  if (flag === "--one") return modeOne(process.argv[process.argv.indexOf(flag) + 1] || "one");
  if (flag === "--multi") return modeMulti(Number(process.argv[process.argv.indexOf(flag) + 1]) || 3);
  if (flag === "--cancel") return modeCancel();
  if (flag === "--cancel-early") return modeCancelEarly();
  const count = Number(process.argv.find((arg, i) => i > 2 && /^\d+$/.test(arg))) || 3;
  return modeSingle(count);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
