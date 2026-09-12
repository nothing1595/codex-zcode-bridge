#!/usr/bin/env node
"use strict";

const path = require("node:path");
const { spawn } = require("node:child_process");

const nodeExe = process.env.ZCODE_NODE_EXE || "E:\\Node.js\\node.exe";
const server = path.join(__dirname, "..", "server", "zcode-worker.cjs");
const workspace = path.resolve(process.argv[2] || path.join(__dirname, ".."));
const model = process.argv[3] || "GLM-High";
const resumeSessionId = process.argv[4];
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
    const message = JSON.parse(line);
    const waiter = pending.get(message.id);
    if (waiter) { pending.delete(message.id); waiter.resolve(message.result); }
  }
});

function request(method, params = {}) {
  const id = nextId++;
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`timeout waiting for ${method}`));
    }, 30_000).unref();
  });
}

async function main() {
  await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke-run", version: "1" } });
  child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  const toolName = resumeSessionId ? "continue_task" : "run_task";
  const toolArgs = { workspace, task: "Reply with exactly OK. Do not use tools or modify files.", model, mode: "plan" };
  if (resumeSessionId) toolArgs.session_id = resumeSessionId;
  const started = await request("tools/call", { name: toolName, arguments: toolArgs });
  const jobId = JSON.parse(started.content[0].text).job_id;
  let state;
  do {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const status = await request("tools/call", { name: "get_status", arguments: { job_id: jobId } });
    state = JSON.parse(status.content[0].text);
  } while (["queued", "running", "needs_user_action"].includes(state.status));
  process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
  child.kill();
  process.exitCode = state.status === "completed" ? 0 : 1;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  child.kill();
  process.exitCode = 1;
});
