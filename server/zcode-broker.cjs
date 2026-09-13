#!/usr/bin/env node
"use strict";

// Singleton broker that owns every piece of shared bridge state: the window
// lock (via the desktop module, which only this process calls), the parallel
// job semaphore, the job table, and the global captcha monitor. MCP wrappers
// connect here over loopback TCP, so several Codex subagents — each with its
// own wrapper process — still funnel into one serialized UI driver.

const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { cancelZCodeSession, captchaVisible, submitDesktopTask, watchDesktopSession } = require("../desktop/zcode-desktop.cjs");
const { connectToZCode } = require("../desktop/cdp-client.cjs");

const SERVER = { name: "zcode-broker", version: "0.3.0" };
const BROKER_PORT = Number(process.env.ZCODE_BROKER_PORT || 19224);
// Observed BigModel Coding Plan behavior: 2 concurrent provider turns work,
// a 3rd simultaneous turn is rejected at request time (unknown_error,
// UNKNOWN_ERROR, zero tokens). Keep the default at 2; raise only if the
// account's plan allows more.
const MAX_PARALLEL_JOBS = Number(process.env.ZCODE_MAX_PARALLEL_JOBS || 2);
const IDLE_EXIT_MS = Number(process.env.ZCODE_BROKER_IDLE_MS || 10 * 60_000);
const JOB_TTL_MS = 60 * 60_000;
const CAPTCHA_POLL_MS = 1_500;
const MAX_OUTPUT_CHARS = 120_000;

const NODE_EXE = process.env.ZCODE_NODE_EXE || "E:\\Node.js\\node.exe";
const ZCODE_CLI = process.env.ZCODE_CLI || "E:\\ZCode\\resources\\glm\\zcode.cjs";
const ZCODE_CONFIG = process.env.ZCODE_CONFIG || path.join(os.homedir(), ".zcode", "v2", "config.json");
const PROVIDER_ID = process.env.ZCODE_PROVIDER_ID || "builtin:bigmodel-start-plan";

const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const MODELS = Object.freeze({
  "GLM-High": "GLM-5.3",
  "GLM-Flash": "GLM-5.3-Flash",
  "glm5.3": "GLM-5.3",
  "glm5.3flash": "GLM-5.3-Flash",
});

const jobs = new Map();
const activeSessionIds = new Set();
const clients = new Set();
let activeSlots = 0;
const slotWaiters = [];
let lastActivity = Date.now();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Lightweight append-only event log so unattended-run behavior (auto-approve,
// captcha, job transitions) can be diagnosed after the fact.
const BROKER_LOG = process.env.ZCODE_BROKER_LOG || path.join(os.tmpdir(), "zcode-broker.log");
function logEvent(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  process.stderr.write(line);
  try { fs.appendFileSync(BROKER_LOG, line); } catch { /* log is best-effort */ }
}

function safeTail(value) {
  return value.length <= MAX_OUTPUT_CHARS ? value : `[output truncated]\n${value.slice(-MAX_OUTPUT_CHARS)}`;
}

function redactSensitive(value) {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED_JWT]")
    .replace(/(['"]?(?:authorization|x-api-key|api[_-]?key|set-cookie|cookie|token|x-aliyun-captcha-verify-param)['"]?\s*:\s*['"])[^'"\r\n]*(['"])/gi, "$1[REDACTED]$2");
}

function resolveWorkspace(input) {
  if (!input || typeof input !== "string") throw new Error("workspace is required");
  const workspace = path.resolve(input);
  if (!path.isAbsolute(workspace) || !fs.statSync(workspace).isDirectory()) {
    throw new Error(`workspace is not a directory: ${workspace}`);
  }
  return workspace;
}

function resolveModel(input) {
  const model = MODELS[input || "GLM-High"];
  if (!model) throw new Error(`unsupported model: ${input}. Use GLM-High or GLM-Flash.`);
  return model;
}

// The trailing nonce line makes every submitted prompt globally unique, so the
// session created for a job can always be attributed by exact text match even
// when several jobs with the same task text run at the same time.
function delegatedPrompt(task, model, jobId) {
  return [
    "You are the ZCode main agent operating in the current workspace.",
    `Delegate the following task to a general-purpose subagent using ${model}.`,
    "The subagent must inspect the workspace itself, obey AGENTS.md and project memory, use tools as needed, validate its work, and summarize results back to you.",
    "Return a concise final report including changed files, validation performed, and any blocker.",
    "",
    "TASK:",
    task,
    "",
    `[bridge job ${jobId}]`,
  ].join("\n");
}

function loadProvider() {
  const config = JSON.parse(fs.readFileSync(ZCODE_CONFIG, "utf8"));
  const provider = config?.provider?.[PROVIDER_ID];
  if (!provider?.options?.apiKey || !provider?.options?.baseURL) {
    throw new Error(`ZCode provider ${PROVIDER_ID} is missing apiKey/baseURL in ${ZCODE_CONFIG}`);
  }
  return provider;
}

// ---------------------------------------------------------------------------
// Parallelism: semaphore slots + FIFO waiters

function acquireSlot(job) {
  return new Promise((resolve) => {
    slotWaiters.push({ job, resolve });
    pumpSlots();
  });
}

function pumpSlots() {
  while (activeSlots < MAX_PARALLEL_JOBS && slotWaiters.length > 0) {
    const { job, resolve } = slotWaiters.shift();
    if (TERMINAL.has(job.status)) { resolve(false); continue; }
    activeSlots += 1;
    job.slotHeld = true;
    resolve(true);
  }
}

function releaseSlot(job) {
  if (!job.slotHeld) return;
  job.slotHeld = false;
  activeSlots -= 1;
  pumpSlots();
}

function dropSlotWaiter(job) {
  for (let i = slotWaiters.length - 1; i >= 0; i -= 1) {
    if (slotWaiters[i].job === job) {
      slotWaiters[i].resolve(false);
      slotWaiters.splice(i, 1);
    }
  }
}

// ---------------------------------------------------------------------------
// Global captcha monitor: captcha is a property of the whole ZCode Desktop
// window, never of one session. While active, every non-terminal desktop job
// is presented as needs_user_action; all of them resume when it clears.

let captchaActive = false;
let captchaTimer = null;
let captchaConnection = null;

function hasActiveJobs() {
  for (const job of jobs.values()) if (!TERMINAL.has(job.status)) return true;
  return false;
}

function startCaptchaMonitor() {
  if (captchaTimer) return;
  captchaTimer = setInterval(() => { void captchaTick(); }, CAPTCHA_POLL_MS);
  captchaTimer.unref();
}

async function captchaTick() {
  if (!hasActiveJobs()) { stopCaptchaMonitor(); return; }
  let visible = false;
  try {
    if (!captchaConnection) captchaConnection = await connectToZCode();
    visible = await captchaVisible(captchaConnection);
  } catch {
    try { captchaConnection?.close(); } catch { /* already closed */ }
    captchaConnection = null;
  }
  captchaActive = visible;
}

function stopCaptchaMonitor() {
  if (captchaTimer) { clearInterval(captchaTimer); captchaTimer = null; }
  try { captchaConnection?.close(); } catch { /* already closed */ }
  captchaConnection = null;
  captchaActive = false;
}

// ---------------------------------------------------------------------------
// Job lifecycle

function startJob(args) {
  const transport = (process.env.ZCODE_TRANSPORT || "desktop").toLowerCase() === "cli" ? "cli" : "desktop";
  if (!args?.task || typeof args.task !== "string") throw new Error("task is required");
  const workspace = resolveWorkspace(args.workspace);
  const model = resolveModel(args.model);
  const resumeSessionId = args.resumeSessionId || args.session_id || null;
  if (resumeSessionId && activeSessionIds.has(resumeSessionId)) {
    throw new Error(`ZCode session ${resumeSessionId} already has an active job; ZCode rejects concurrent prompts in one session`);
  }
  const jobId = `zjob_${randomUUID()}`;
  const job = {
    jobId,
    transport,
    status: "queued",
    model,
    workspace,
    task: args.task,
    mode: args.mode || "yolo",
    resumeSessionId,
    prompt: delegatedPrompt(args.task, model, jobId),
    startedAt: new Date().toISOString(),
    completedAt: null,
    exitCode: null,
    sessionId: null,
    stdout: "",
    stderr: "",
    usage: null,
    sent: false,
    cancelRequested: false,
    awaitingUser: null,
    abortController: new AbortController(),
    slotHeld: false,
    child: null,
  };
  jobs.set(jobId, job);
  logEvent(`job ${jobId} created (${transport}, ${model}, workspace=${workspace})`);
  if (transport === "cli") void executeCliJob(job);
  else void executeDesktopJob(job);
  return publicJob(job, false);
}

async function executeDesktopJob(job) {
  const granted = await acquireSlot(job);
  if (!granted || job.status === "cancelled") { releaseSlot(job); return; }
  job.status = "submitting";
  if (job.resumeSessionId) activeSessionIds.add(job.resumeSessionId);
  startCaptchaMonitor();
  try {
    const submitted = await submitDesktopTask({
      workspace: job.workspace,
      prompt: job.prompt,
      model: job.model,
      mode: job.mode,
      resumeSessionId: job.resumeSessionId,
      signal: job.abortController.signal,
      cancelRequested: () => job.cancelRequested,
      onSent: () => {
        job.sent = true;
        if (job.status === "submitting") job.status = "submitted";
      },
      onSession: (id) => {
        job.sessionId = id;
        activeSessionIds.add(id);
      },
    });
    job.sessionId = submitted.sessionId;
    job.status = "running";
    const final = await watchDesktopSession({
      sessionId: submitted.sessionId,
      signal: job.abortController.signal,
      fallbackWorkspace: job.workspace,
      onAwaitingUser: (kind) => {
        if (job.awaitingUser !== kind) logEvent(`job ${job.jobId} awaiting=${kind || "none"}`);
        job.awaitingUser = kind;
      },
      onLog: logEvent,
    });
    job.status = final.status;
    job.stdout = safeTail(final.output || "");
    job.stderr = safeTail(final.diagnostics || "");
    job.usage = final.usage || null;
    job.exitCode = final.status === "completed" ? 0 : 1;
  } catch (error) {
    if (error.code === "CANCELLED" || job.cancelRequested || job.abortController.signal.aborted) job.status = "cancelled";
    else { job.status = "failed"; job.stderr = safeTail(error.stack || error.message); }
    job.exitCode = 1;
  } finally {
    job.completedAt = new Date().toISOString();
    logEvent(`job ${job.jobId} settled: ${job.status}`);
    if (job.sessionId) activeSessionIds.delete(job.sessionId);
    if (job.resumeSessionId) activeSessionIds.delete(job.resumeSessionId);
    releaseSlot(job);
  }
}

// Legacy diagnostic route (ZCODE_TRANSPORT=cli). Kept in the broker so job
// state stays in one place no matter which wrapper process submitted.
function executeCliJob(job) {
  const provider = loadProvider();
  const args = [ZCODE_CLI, "--surface", "desktop", "--cwd", job.workspace, "--mode", job.mode, "--json", "--no-color"];
  if (job.resumeSessionId) args.push("--resume", job.resumeSessionId);
  args.push("--prompt", job.prompt);
  const providerName = PROVIDER_ID.replace(/^builtin:/, "");
  job.status = "running";
  const child = spawn(NODE_EXE, args, {
    cwd: job.workspace,
    windowsHide: true,
    env: {
      ...process.env,
      ZCODE_API_KEY: provider.options.apiKey,
      ZCODE_BASE_URL: provider.options.baseURL,
      ZCODE_MODEL: `${providerName}/${job.model}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  job.child = child;
  child.stdout.on("data", (chunk) => { job.stdout = safeTail(job.stdout + chunk.toString("utf8")); });
  child.stderr.on("data", (chunk) => { job.stderr = safeTail(job.stderr + chunk.toString("utf8")); });
  child.on("error", (error) => {
    job.status = "failed";
    job.stderr = safeTail(`${job.stderr}\n${error.stack || error.message}`);
    job.completedAt = new Date().toISOString();
  });
  child.on("close", (code, signal) => {
    job.exitCode = code;
    if (!TERMINAL.has(job.status)) job.status = code === 0 ? "completed" : "failed";
    if (signal) job.stderr = safeTail(`${job.stderr}\nTerminated by ${signal}`);
    job.completedAt = new Date().toISOString();
    job.child = null;
  });
}

function cancelJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) throw new Error(`unknown job_id: ${jobId}`);
  if (TERMINAL.has(job.status)) return publicJob(job);
  if (job.transport === "cli") {
    job.status = "cancelled";
    job.completedAt = new Date().toISOString();
    job.child?.kill();
    return publicJob(job);
  }
  if (job.status === "queued") {
    job.status = "cancelled";
    job.completedAt = new Date().toISOString();
    job.abortController.abort();
    dropSlotWaiter(job);
    return publicJob(job);
  }
  job.cancelRequested = true;
  if (!job.sent) {
    // Before Send there is nothing to orphan; the submit phase bails out at
    // its next checkpoint.
    job.status = "cancelling";
    job.abortController.abort();
    return publicJob(job);
  }
  job.status = "cancelling";
  if (job.sessionId) {
    void (async () => {
      try {
        await cancelZCodeSession({ sessionId: job.sessionId });
      } catch (error) {
        job.stderr = safeTail(`${job.stderr}\nstop attempt failed: ${error.message}`);
      } finally {
        // Wake the watcher; executeDesktopJob settles the job as cancelled.
        job.abortController.abort();
      }
    })();
  }
  // Sent but sessionId still unknown: submitDesktopTask's post-send cancel
  // path is hunting the session and stops it inside its own window lock.
  return publicJob(job);
}

function publicJob(job, includeOutput = true) {
  const sessionId = job.sessionId || `${job.stdout}\n${job.stderr}`.match(/sess_[0-9a-f-]{20,}/i)?.[0] || null;
  const terminal = TERMINAL.has(job.status);
  let status = job.status;
  if (!terminal && captchaActive && job.transport === "desktop") status = "needs_user_action";
  else if (!terminal && job.awaitingUser === "question" && job.transport === "desktop") status = "needs_user_action";
  else if (job.status === "submitting" || job.status === "submitted") status = "running";
  const result = {
    job_id: job.jobId,
    status,
    phase: job.status,
    model: job.model,
    workspace: job.workspace,
    started_at: job.startedAt,
    completed_at: job.completedAt,
    exit_code: job.exitCode,
    session_id: sessionId,
  };
  if (includeOutput) {
    result.output = redactSensitive(job.stdout.trim());
    result.diagnostics = redactSensitive(job.stderr.trim());
    if (/captcha verify failed/i.test(job.stderr)) {
      result.blocker = "ZCode Coding Plan rejected the standalone CLI because desktop captcha runtime headers are unavailable.";
    }
    if (status === "needs_user_action" && captchaActive) {
      result.blocker = "Complete the captcha in the visible ZCode Desktop window. Captcha pauses the whole desktop app; every active bridge job resumes automatically once it is resolved.";
    } else if (status === "needs_user_action" && job.awaitingUser === "question") {
      result.blocker = "The ZCode agent asked a question (AskUserQuestion) and is waiting for a human answer in the ZCode window. Answer it there; this job resumes automatically. Plan approvals are auto-approved and never need a human.";
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Loopback TCP service (line-delimited JSON requests/responses)

async function dispatch(method, params) {
  switch (method) {
    case "health":
      return {
        ...SERVER,
        active_jobs: hasActiveJobs(),
        parallel_limit: MAX_PARALLEL_JOBS,
        captcha_active: captchaActive,
        port: BROKER_PORT,
      };
    case "run_task":
      return startJob(params);
    case "continue_task":
      return startJob({ ...params, resumeSessionId: params.session_id });
    case "get_status": {
      const job = jobs.get(params.job_id);
      if (!job) throw new Error(`unknown job_id: ${params.job_id}`);
      // Optional server-side long poll: hold the response until the job's
      // observable state changes or wait_ms elapses, so MCP clients do not
      // burn their own quota busy-polling.
      const waitMs = Math.min(Number(params.wait_ms) || 0, 45_000);
      if (waitMs > 0 && !TERMINAL.has(job.status)) {
        const fingerprint = () => `${job.status}|${job.sessionId}|${job.stdout.length}|${job.stderr.length}|${job.awaitingUser || ""}|${captchaActive}`;
        const initial = fingerprint();
        const deadline = Date.now() + waitMs;
        while (Date.now() < deadline && !TERMINAL.has(job.status) && fingerprint() === initial) {
          await sleep(400);
        }
      }
      return publicJob(job);
    }
    case "cancel_task":
      return cancelJob(params.job_id);
    default:
      throw new Error(`unknown broker method: ${method}`);
  }
}

function writeMessage(socket, message) {
  if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
}

async function handleLine(socket, line) {
  let request;
  try {
    request = JSON.parse(line);
  } catch (error) {
    writeMessage(socket, { id: null, error: { message: `invalid JSON line: ${error.message}` } });
    return;
  }
  const id = request?.id ?? null;
  try {
    const result = await dispatch(request?.method, request?.params || {});
    writeMessage(socket, { id, result });
  } catch (error) {
    writeMessage(socket, { id, error: { message: redactSensitive(error.message) } });
  }
}

const server = net.createServer((socket) => {
  clients.add(socket);
  lastActivity = Date.now();
  socket.setEncoding("utf8");
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) void handleLine(socket, line);
    }
  });
  socket.on("error", () => { /* client dropped; nothing to do */ });
  socket.on("close", () => {
    clients.delete(socket);
    lastActivity = Date.now();
  });
});

// Two wrappers may spawn brokers at the same time; the loser sees EADDRINUSE
// and exits 0 because the singleton already exists.
server.on("error", (error) => {
  if (error.code === "EADDRINUSE") process.exit(0);
  process.stderr.write(`zcode-broker server error: ${error.stack || error.message}\n`);
  process.exit(1);
});

server.listen(BROKER_PORT, "127.0.0.1", () => {
  process.stderr.write(`zcode-broker listening on 127.0.0.1:${BROKER_PORT} (max parallel jobs: ${MAX_PARALLEL_JOBS})\n`);
});

// Housekeeping: drop finished jobs after the TTL and exit when fully idle so
// no stray daemon lingers. Wrappers respawn the broker on demand.
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (TERMINAL.has(job.status) && job.completedAt && now - Date.parse(job.completedAt) > JOB_TTL_MS) jobs.delete(id);
  }
  if (clients.size === 0 && !hasActiveJobs() && now - lastActivity > IDLE_EXIT_MS) {
    stopCaptchaMonitor();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2_000).unref();
  }
}, 30_000).unref();

process.on("exit", () => {
  stopCaptchaMonitor();
  for (const job of jobs.values()) job.child?.kill();
});

// A crash would orphan every tracked job, so log and keep serving instead.
process.on("uncaughtException", (error) => {
  process.stderr.write(`zcode-broker uncaught exception: ${error.stack || error.message}\n`);
});
process.on("unhandledRejection", (reason) => {
  process.stderr.write(`zcode-broker unhandled rejection: ${reason?.stack || reason}\n`);
});
