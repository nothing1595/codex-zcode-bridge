#!/usr/bin/env node
"use strict";

// Thin MCP wrapper: speaks stdio JSON-RPC 2.0 to Codex and relays every tool
// call to the singleton zcode-broker over loopback TCP. Codex may spawn one
// wrapper process per subagent; the broker is what actually serializes UI
// access and parallelizes session watching, so multiple wrappers are safe.
// If no broker is reachable, one is spawned detached and the connection is
// retried (concurrent spawns converge: the loser exits on EADDRINUSE).

const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");

const SERVER = { name: "codex-zcode-worker", version: "0.3.0" };
const BROKER_PATH = path.join(__dirname, "zcode-broker.cjs");
const BROKER_PORT = Number(process.env.ZCODE_BROKER_PORT || 19224);
const BROKER_START_ATTEMPTS = 40;
const BROKER_START_RETRY_MS = 250;
const BROKER_REQUEST_TIMEOUT_MS = 60_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function textResult(value, isError = false) {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }], isError };
}

function brokerRequest(method, params) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(BROKER_PORT, "127.0.0.1");
    let buffer = "";
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };
    socket.setTimeout(BROKER_REQUEST_TIMEOUT_MS);
    socket.on("timeout", () => fail(Object.assign(new Error("broker request timed out"), { code: "ETIMEDOUT" })));
    socket.on("error", fail);
    socket.on("connect", () => socket.write(`${JSON.stringify({ id: 1, method, params })}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      if (settled) return;
      settled = true;
      socket.end();
      try {
        const message = JSON.parse(buffer.slice(0, newline));
        if (message.error) reject(new Error(message.error.message || "broker error"));
        else resolve(message.result);
      } catch (error) {
        reject(error);
      }
    });
  });
}

function spawnBroker() {
  const child = spawn(process.execPath, [BROKER_PATH], { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
}

async function callBroker(method, params) {
  let lastError;
  for (let attempt = 0; attempt <= BROKER_START_ATTEMPTS; attempt += 1) {
    try {
      return await brokerRequest(method, params);
    } catch (error) {
      lastError = error;
      const connectFailure = ["ECONNREFUSED", "ECONNRESET", "EPIPE", "ETIMEDOUT"].includes(error.code);
      if (!connectFailure || attempt === BROKER_START_ATTEMPTS) break;
      if (attempt === 0) spawnBroker();
      await sleep(BROKER_START_RETRY_MS);
    }
  }
  throw new Error(`zcode-broker unreachable on 127.0.0.1:${BROKER_PORT}: ${lastError?.message || "unknown error"}`);
}

const tools = [
  {
    name: "run_task",
    description: "Start a task through the logged-in ZCode Desktop using GLM-5.3 or GLM-5.3-Flash. Returns immediately with a job_id. Multiple jobs run in parallel (each takes a semaphore slot); poll each job_id with get_status.",
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
    description: "Resume a persisted ZCode Desktop session with another instruction. A session can only run one job at a time.",
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
    description: "Get status and accumulated output for a ZCode task. Statuses: queued, running, needs_user_action, cancelling, completed, failed, cancelled.",
    inputSchema: { type: "object", properties: { job_id: { type: "string" } }, required: ["job_id"], additionalProperties: false },
  },
  {
    name: "cancel_task",
    description: "Cancel a ZCode task. Safe at any phase: after Send the broker first stops the ZCode session (no orphan sessions keep burning tokens), then finalizes the job as cancelled.",
    inputSchema: { type: "object", properties: { job_id: { type: "string" } }, required: ["job_id"], additionalProperties: false },
  },
];

async function callTool(name, args) {
  if (!["run_task", "continue_task", "get_status", "cancel_task"].includes(name)) {
    return textResult(`unknown tool: ${name}`, true);
  }
  const result = await callBroker(name, args || {});
  return textResult(result);
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
