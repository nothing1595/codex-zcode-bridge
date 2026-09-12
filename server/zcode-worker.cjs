#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { cancelActiveTask, runDesktopTask } = require("../desktop/zcode-desktop.cjs");

const SERVER = { name: "codex-zcode-worker", version: "0.2.0" };
const NODE_EXE = process.env.ZCODE_NODE_EXE || "E:\\Node.js\\node.exe";
const ZCODE_CLI = process.env.ZCODE_CLI || "E:\\ZCode\\resources\\glm\\zcode.cjs";
const ZCODE_CONFIG = process.env.ZCODE_CONFIG || path.join(os.homedir(), ".zcode", "v2", "config.json");
const PROVIDER_ID = process.env.ZCODE_PROVIDER_ID || "builtin:bigmodel-start-plan";
const MAX_OUTPUT_CHARS = 120_000;
const jobs = new Map();
let desktopQueue = Promise.resolve();

const MODELS = Object.freeze({
  "GLM-High": "GLM-5.3",
  "GLM-Flash": "GLM-5.3-Flash",
  "glm5.3": "GLM-5.3",
  "glm5.3flash": "GLM-5.3-Flash",
});

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function textResult(value, isError = false) {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }], isError };
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

function loadProvider() {
  const config = JSON.parse(fs.readFileSync(ZCODE_CONFIG, "utf8"));
  const provider = config?.provider?.[PROVIDER_ID];
  if (!provider?.options?.apiKey || !provider?.options?.baseURL) {
    throw new Error(`ZCode provider ${PROVIDER_ID} is missing apiKey/baseURL in ${ZCODE_CONFIG}`);
  }
  return provider;
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

function delegatedPrompt(task, model) {
  return [
    "You are the ZCode main agent operating in the current workspace.",
    `Delegate the following task to a general-purpose subagent using ${model}.`,
    "The subagent must inspect the workspace itself, obey AGENTS.md and project memory, use tools as needed, validate its work, and summarize results back to you.",
    "Return a concise final report including changed files, validation performed, and any blocker.",
    "",
    "TASK:",
    task,
  ].join("\n");
}

function startCliJob({ workspace, task, model, mode = "yolo", resumeSessionId }) {
  if (!task || typeof task !== "string") throw new Error("task is required");
  const cwd = resolveWorkspace(workspace);
  const resolvedModel = resolveModel(model);
  const provider = loadProvider();
  const jobId = `zjob_${randomUUID()}`;
  const args = [ZCODE_CLI, "--surface", "desktop", "--cwd", cwd, "--mode", mode, "--json", "--no-color"];
  if (resumeSessionId) args.push("--resume", resumeSessionId);
  args.push("--prompt", delegatedPrompt(task, resolvedModel));

  const providerName = PROVIDER_ID.replace(/^builtin:/, "");
  const child = spawn(NODE_EXE, args, {
    cwd,
    windowsHide: true,
    env: {
      ...process.env,
      ZCODE_API_KEY: provider.options.apiKey,
      ZCODE_BASE_URL: provider.options.baseURL,
      ZCODE_MODEL: `${providerName}/${resolvedModel}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const job = {
    jobId,
    status: "running",
    model: resolvedModel,
    workspace: cwd,
    startedAt: new Date().toISOString(),
    completedAt: null,
    exitCode: null,
    stdout: "",
    stderr: "",
    child,
  };
  jobs.set(jobId, job);

  child.stdout.on("data", (chunk) => { job.stdout = safeTail(job.stdout + chunk.toString("utf8")); });
  child.stderr.on("data", (chunk) => { job.stderr = safeTail(job.stderr + chunk.toString("utf8")); });
  child.on("error", (error) => {
    job.status = "failed";
    job.stderr = safeTail(`${job.stderr}\n${error.stack || error.message}`);
    job.completedAt = new Date().toISOString();
  });
  child.on("close", (code, signal) => {
    job.exitCode = code;
    if (job.status === "running") job.status = code === 0 ? "completed" : "failed";
    if (signal) job.stderr = safeTail(`${job.stderr}\nTerminated by ${signal}`);
    job.completedAt = new Date().toISOString();
    job.child = null;
  });
  return job;
}

function startDesktopJob({ workspace, task, model, mode = "yolo", resumeSessionId }) {
  if (!task || typeof task !== "string") throw new Error("task is required");
  const cwd = resolveWorkspace(workspace);
  const resolvedModel = resolveModel(model);
  const jobId = `zjob_${randomUUID()}`;
  const abortController = new AbortController();
  const job = {
    jobId, status: "queued", model: resolvedModel, workspace: cwd,
    startedAt: new Date().toISOString(), completedAt: null, exitCode: null,
    sessionId: null, stdout: "", stderr: "", child: null, abortController,
  };
  jobs.set(jobId, job);
  const execute = async () => {
    if (job.status === "cancelled") return;
    job.status = "running";
    try {
      const result = await runDesktopTask({
        workspace: cwd,
        prompt: delegatedPrompt(task, resolvedModel),
        model: resolvedModel,
        mode,
        resumeSessionId,
        signal: abortController.signal,
        onSession: (id) => { job.sessionId = id; },
        onNeedsUserAction: (needed) => { job.status = needed ? "needs_user_action" : "running"; },
      });
      job.status = result.status;
      job.sessionId = result.sessionId;
      job.stdout = safeTail(result.output || "");
      job.stderr = safeTail(result.diagnostics || "");
      job.exitCode = result.status === "completed" ? 0 : 1;
    } catch (error) {
      if (error.code === "CANCELLED" || abortController.signal.aborted) job.status = "cancelled";
      else job.status = "failed";
      job.stderr = safeTail(error.stack || error.message);
      job.exitCode = 1;
    } finally {
      job.completedAt = new Date().toISOString();
    }
  };
  desktopQueue = desktopQueue.then(execute, execute);
  return job;
}

function startJob(args) {
  return (process.env.ZCODE_TRANSPORT || "desktop").toLowerCase() === "cli" ? startCliJob(args) : startDesktopJob(args);
}

function publicJob(job, includeOutput = true) {
  const sessionId = job.sessionId || `${job.stdout}\n${job.stderr}`.match(/sess_[0-9a-f-]{20,}/i)?.[0] || null;
  const result = {
    job_id: job.jobId,
    status: job.status,
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
    if (job.status === "needs_user_action") {
      result.blocker = "Complete the captcha in the visible ZCode Desktop window; this job will resume automatically.";
    }
  }
  return result;
}

const tools = [
  {
    name: "run_task",
    description: "Start a task through the logged-in ZCode Desktop using GLM-5.3 or GLM-5.3-Flash. Returns immediately with a job_id.",
    inputSchema: {
      type: "object",
      properties: {
        workspace: { type: "string", description: "Absolute path to the shared Codex/ZCode workspace." },
        task: { type: "string", description: "Complete delegated task for the ZCode subagent." },
        model: { type: "string", enum: ["GLM-High", "GLM-Flash"], default: "GLM-High" },
        mode: { type: "string", enum: ["build", "edit", "plan", "yolo"], default: "yolo" },
      },
      required: ["workspace", "task"],
      additionalProperties: false,
    },
  },
  {
    name: "continue_task",
    description: "Resume a persisted ZCode Desktop session with another instruction.",
    inputSchema: {
      type: "object",
      properties: {
        workspace: { type: "string" }, task: { type: "string" }, session_id: { type: "string" },
        model: { type: "string", enum: ["GLM-High", "GLM-Flash"], default: "GLM-High" },
        mode: { type: "string", enum: ["build", "edit", "plan", "yolo"], default: "yolo" },
      },
      required: ["workspace", "task", "session_id"],
      additionalProperties: false,
    },
  },
  {
    name: "get_status",
    description: "Get status and accumulated output for a ZCode task.",
    inputSchema: { type: "object", properties: { job_id: { type: "string" } }, required: ["job_id"], additionalProperties: false },
  },
  {
    name: "cancel_task",
    description: "Cancel a running ZCode task.",
    inputSchema: { type: "object", properties: { job_id: { type: "string" } }, required: ["job_id"], additionalProperties: false },
  },
];

async function callTool(name, args) {
  if (name === "run_task") return textResult(publicJob(startJob(args), false));
  if (name === "continue_task") return textResult(publicJob(startJob({ ...args, resumeSessionId: args.session_id }), false));
  if (name === "get_status") {
    const job = jobs.get(args.job_id);
    return job ? textResult(publicJob(job)) : textResult(`unknown job_id: ${args.job_id}`, true);
  }
  if (name === "cancel_task") {
    const job = jobs.get(args.job_id);
    if (!job) return textResult(`unknown job_id: ${args.job_id}`, true);
    if (job.child && job.status === "running") {
      job.status = "cancelled";
      job.completedAt = new Date().toISOString();
      job.child.kill();
    } else if (["queued", "running", "needs_user_action"].includes(job.status)) {
      job.status = "cancelled";
      job.completedAt = new Date().toISOString();
      job.abortController?.abort();
      if (job.sessionId) await cancelActiveTask();
    }
    return textResult(publicJob(job));
  }
  return textResult(`unknown tool: ${name}`, true);
}

async function handle(request) {
  if (!request || request.jsonrpc !== "2.0") return;
  if (request.method === "notifications/initialized" || request.method === "notifications/cancelled") return;
  if (request.method === "initialize") {
    const protocolVersion = request.params?.protocolVersion || "2025-06-18";
    return send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion, capabilities: { tools: {} }, serverInfo: SERVER } });
  }
  if (request.method === "ping") return send({ jsonrpc: "2.0", id: request.id, result: {} });
  if (request.method === "tools/list") return send({ jsonrpc: "2.0", id: request.id, result: { tools } });
  if (request.method === "tools/call") {
    try {
      const result = await callTool(request.params?.name, request.params?.arguments || {});
      return send({ jsonrpc: "2.0", id: request.id, result });
    } catch (error) {
      return send({ jsonrpc: "2.0", id: request.id, result: textResult(error.stack || error.message, true) });
    }
  }
  if (request.id !== undefined) send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: `Method not found: ${request.method}` } });
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    try { void handle(JSON.parse(line)); }
    catch (error) { process.stderr.write(`Invalid MCP message: ${error.message}\n`); }
  }
});

process.on("exit", () => {
  for (const job of jobs.values()) if (job.child) job.child.kill();
});
