#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const { connectToZCode, discoverZCodePage } = require("./cdp-client.cjs");

const ZCODE_EXE = process.env.ZCODE_EXE || "E:\\ZCode\\ZCode.exe";
const ZCODE_DB = process.env.ZCODE_DB || path.join(os.homedir(), ".zcode", "cli", "db", "db.sqlite");
const POLL_MS = Number(process.env.ZCODE_POLL_MS || 750);
const START_TIMEOUT_MS = Number(process.env.ZCODE_START_TIMEOUT_MS || 30_000);
const TASK_TIMEOUT_MS = Number(process.env.ZCODE_TASK_TIMEOUT_MS || 30 * 60_000);
// Upper bound for hunting the session id after Send was clicked while a cancel came in.
const CANCEL_HUNT_TIMEOUT_MS = Number(process.env.ZCODE_CANCEL_HUNT_TIMEOUT_MS || 60_000);

// turn_usage rows are only written when a turn ends. Only these statuses are
// interpreted; anything else (present or future) keeps the watcher waiting.
const USAGE_SUCCESS = new Set(["completed", "success"]);
const USAGE_FAILED = new Set(["error"]);
const USAGE_CANCELLED = new Set(["cancelled"]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function cancelledError(message = "ZCode task was cancelled") {
  return Object.assign(new Error(message), { code: "CANCELLED" });
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw cancelledError();
}

async function waitFor(check, timeoutMs, label, signal) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    try {
      const value = await check();
      if (value) return value;
    } catch (error) { lastError = error; }
    await sleep(POLL_MS);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`);
}

// Like waitFor but resolves null instead of throwing when the element never shows up.
async function waitForOrNull(check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check().catch(() => null);
    if (value) return value;
    if (Date.now() >= deadline) return null;
    await sleep(POLL_MS);
  }
}

// Single-writer mutex for every UI mutation. Only the broker process calls into
// this module, so this lock is the global window lock by construction.
let windowLock = Promise.resolve();
function withWindowLock(fn) {
  const previous = windowLock;
  let release;
  windowLock = new Promise((resolve) => { release = resolve; });
  return previous.then(fn).finally(release);
}

async function mouseClick(connection, rect) {
  await connection.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: rect.x, y: rect.y });
  await connection.send("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
  await connection.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
}

async function pressKey(connection, key, code = key) {
  await connection.send("Input.dispatchKeyEvent", { type: "keyDown", key, code });
  await connection.send("Input.dispatchKeyEvent", { type: "keyUp", key, code });
}

// Escape stops the generation of whichever task view is focused, so only send
// it when a popup/menu is actually open - never unconditionally.
async function dismissPopups(connection) {
  const open = await connection.evaluate(`(() => {
    const visible = (e) => e && e.offsetParent !== null;
    return Array.from(document.querySelectorAll('[role=menu],[role=listbox],[role=dialog],[data-radix-popper-content-wrapper]'))
      .some(e => visible(e) && e.getAttribute('data-state') !== 'closed');
  })()`);
  if (open) await pressKey(connection, "Escape", "Escape");
}

async function visibleRect(connection, query, mode = "aria", excludeAria = "") {
  return connection.evaluate(`(() => {
    const query = ${JSON.stringify(query)};
    const mode = ${JSON.stringify(mode)};
    const excludeAria = ${JSON.stringify(excludeAria)};
    const visible = (e) => e && e.offsetParent !== null && e.getBoundingClientRect().width > 0;
    let element = null;
    if (mode === "aria") element = Array.from(document.querySelectorAll("[aria-label]")).find(e => visible(e) && e.getAttribute("aria-label") === query);
    if (mode === "selector") element = Array.from(document.querySelectorAll(query)).find(visible);
    if (mode === "text") {
      const leaves = Array.from(document.querySelectorAll("body *")).filter(e => visible(e) && e.children.length === 0 && (e.textContent || "").trim() === query);
      const leaf = leaves.find(e => e.closest("button,[role=menuitem],[role=option],[data-radix-collection-item]")?.getAttribute("aria-label") !== excludeAria);
      element = leaf?.closest("button,[role=menuitem],[role=option],[data-radix-collection-item]") || leaf;
    }
    if (!element) return null;
    const box = element.getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2, text: (element.innerText || "").trim(), disabled: !!element.disabled };
  })()`);
}

async function click(connection, query, mode = "aria", excludeAria = "") {
  const rect = await visibleRect(connection, query, mode, excludeAria);
  if (!rect) throw new Error(`Visible ZCode control was not found: ${query}`);
  await mouseClick(connection, rect);
  return rect;
}

function openWorkspace(workspace) {
  if (!fs.existsSync(ZCODE_EXE)) throw new Error(`ZCode executable was not found: ${ZCODE_EXE}`);
  const child = spawn(ZCODE_EXE, ["--open-workspace", workspace], { detached: true, stdio: "ignore", windowsHide: false });
  child.unref();
}

function openDb() {
  if (!fs.existsSync(ZCODE_DB)) throw new Error(`ZCode database was not found: ${ZCODE_DB}`);
  return new DatabaseSync(ZCODE_DB, { readOnly: true });
}

function baselineTime() {
  const db = openDb();
  try { return Number(db.prepare("SELECT COALESCE(MAX(time_created), 0) AS value FROM session").get().value); }
  finally { db.close(); }
}

function parseJson(value) {
  try { return JSON.parse(value); } catch { return {}; }
}

function findPromptSession(prompt, afterTime) {
  const db = openDb();
  try {
    const rows = db.prepare(`
      SELECT s.id, s.directory, s.title, s.time_created, p.data
      FROM session s JOIN part p ON p.session_id = s.id
      WHERE p.time_created >= ?
      ORDER BY s.time_created DESC, p.sequence ASC
    `).all(afterTime);
    for (const row of rows) {
      const part = parseJson(row.data);
      if (part.type === "text" && part.text === prompt) return row;
    }
    return null;
  } finally { db.close(); }
}

// Resolve the workspace a session belongs to without trusting the caller.
function sessionWorkspace(sessionId) {
  const db = openDb();
  try {
    for (const column of ["directory", "path"]) {
      try {
        const value = db.prepare(`SELECT ${column} AS value FROM session WHERE id = ?`).get(sessionId)?.value;
        if (value) return value;
      } catch { /* column does not exist in this ZCode schema */ }
    }
    return null;
  } finally { db.close(); }
}

function readSession(sessionId) {
  const db = openDb();
  try {
    const session = db.prepare("SELECT * FROM session WHERE id = ?").get(sessionId);
    if (!session) return null;
    const messages = db.prepare("SELECT * FROM message WHERE session_id = ? ORDER BY sequence, time_created").all(sessionId)
      .map((row) => ({ ...row, parsed: parseJson(row.data) }));
    const parts = db.prepare("SELECT * FROM part WHERE session_id = ? ORDER BY sequence, time_created").all(sessionId)
      .map((row) => ({ ...row, parsed: parseJson(row.data) }));
    const usage = db.prepare("SELECT * FROM turn_usage WHERE session_id = ? ORDER BY started_at DESC LIMIT 1").get(sessionId) || null;
    const latestUserSequence = Math.max(-1, ...messages.filter((m) => m.parsed.role === "user").map((m) => Number(m.sequence ?? -1)));
    const currentAssistants = messages.filter((m) => m.parsed.role === "assistant" && Number(m.sequence ?? -1) > latestUserSequence);
    const finalMessages = currentAssistants.filter((m) => m.parsed.finish && m.parsed.finish !== "tool-calls");
    const outputMessageIds = new Set((finalMessages.length ? finalMessages : currentAssistants).map((m) => m.id));
    const output = parts.filter((p) => outputMessageIds.has(p.message_id) && p.parsed.type === "text").map((p) => p.parsed.text || "").join("\n").trim();
    const completed = finalMessages.length > 0;
    return { session, messages, parts, usage, output, completed };
  } finally { db.close(); }
}

function findSessionTitle(sessionId) {
  const db = openDb();
  try { return db.prepare("SELECT title FROM session WHERE id = ?").get(sessionId)?.title || null; }
  finally { db.close(); }
}

function partCount(sessionId) {
  const db = openDb();
  try { return Number(db.prepare("SELECT COUNT(*) AS value FROM part WHERE session_id = ?").get(sessionId).value); }
  finally { db.close(); }
}

// Captcha checks read the shared window, so the result describes the whole
// ZCode Desktop, not one session. The broker treats it as a global pause.
async function captchaVisible(connection) {
  const dom = await connection.evaluate(`(() => {
    const visible = (e) => e && e.offsetParent !== null;
    return Array.from(document.querySelectorAll('[role="dialog"],dialog,iframe,webview'))
      .filter(visible)
      .some(e => /验证码|captcha|滑块验证|安全验证/i.test((e.getAttribute('title') || '') + ' ' + (e.getAttribute('src') || '') + ' ' + (e.innerText || '')));
  })()`);
  if (dom) return true;
  const response = await fetch(`http://${process.env.ZCODE_CDP_HOST || "127.0.0.1"}:${process.env.ZCODE_CDP_PORT || 19223}/json/list`);
  const targets = await response.json();
  return targets.some((target) => /验证码|captcha|安全验证/i.test(`${target.title} ${target.url}`));
}

async function selectModel(connection, model) {
  await dismissPopups(connection);
  const current = await visibleRect(connection, "选择模型", "aria");
  if (!current) throw new Error("ZCode model selector is unavailable");
  const currentModel = () => connection.evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('[aria-label="选择模型"]')).find(e => e.offsetParent !== null);
    return button?.querySelector('[title]')?.getAttribute('title') || null;
  })()`);
  if (await currentModel() === model) return;
  await mouseClick(connection, current);
  await waitFor(() => visibleRect(connection, model, "text", "选择模型"), 10_000, `${model} menu item`);
  await click(connection, model, "text", "选择模型");
  await waitFor(async () => await currentModel() === model, 10_000, `${model} selection`);
}

async function selectMode(connection, mode) {
  const labels = { build: "自动编辑", edit: "变更前确认", plan: "计划模式", yolo: "完全访问" };
  const target = labels[mode] || labels.yolo;
  const current = await visibleRect(connection, "切换模式", "aria");
  if (!current) throw new Error("ZCode permission mode selector is unavailable");
  if (current.text.includes(target)) return;
  await mouseClick(connection, current);
  await waitFor(() => visibleRect(connection, target, "text", "切换模式"), 10_000, `${target} mode item`);
  await click(connection, target, "text", "切换模式");
  await waitFor(async () => (await visibleRect(connection, "切换模式", "aria"))?.text.includes(target), 10_000, `${target} mode selection`);
}

async function prepareTask(connection, workspace, model, mode, resumeSessionId) {
  openWorkspace(workspace);
  await sleep(800);
  await dismissPopups(connection);
  if (resumeSessionId) {
    if (!findSessionTitle(resumeSessionId)) throw new Error(`Unknown ZCode session: ${resumeSessionId}`);
    await click(connection, `[data-testid=${JSON.stringify(`task-item-${resumeSessionId}`)}]`, "selector");
    await sleep(500);
  } else {
    await click(connection, "新建任务", "aria");
    await waitFor(
      () => visibleRect(connection, '[contenteditable="true"][role="textbox"]', "selector"),
      10_000,
      "new task composer",
    );
  }
  await selectMode(connection, mode);
  await selectModel(connection, model);
}

function composerRect(connection) {
  return connection.evaluate(`(() => {
    const e = Array.from(document.querySelectorAll('[contenteditable="true"][role="textbox"]')).find(x => x.offsetParent !== null);
    if (!e) return null;
    const b = e.getBoundingClientRect();
    return { x: b.x + Math.min(40, b.width / 2), y: b.y + Math.min(20, b.height / 2) };
  })()`);
}

function composerFocused(connection) {
  return connection.evaluate(`(() => {
    const e = document.activeElement;
    return !!(e && e.getAttribute && e.getAttribute('contenteditable') === 'true');
  })()`);
}

async function focusComposer(connection) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const rect = await composerRect(connection);
    if (!rect) throw new Error("Visible ZCode composer was not found");
    await mouseClick(connection, rect);
    await sleep(250);
    if (await composerFocused(connection)) return;
  }
  throw new Error("ZCode composer did not take focus");
}

async function insertPrompt(connection, prompt) {
  // Verify the text actually landed (insertText goes to the focused element
  // only); re-click and re-insert once otherwise. Under parallel load a view
  // transition can swallow the first attempt.
  const suffix = prompt.slice(-40);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await focusComposer(connection);
    await connection.send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", modifiers: 2 });
    await connection.send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers: 2 });
    await pressKey(connection, "Backspace", "Backspace");
    await connection.send("Input.insertText", { text: prompt });
    const inserted = await connection.evaluate(`(() => {
      const e = Array.from(document.querySelectorAll('[contenteditable="true"][role="textbox"]')).find(x => x.offsetParent !== null);
      if (!e) return false;
      return (e.textContent || '').replace(/\\s+$/, '').endsWith(${JSON.stringify(suffix)});
    })()`);
    if (inserted) {
      await waitFor(async () => {
        const send = await visibleRect(connection, "发送", "aria");
        return send && !send.disabled ? send : null;
      }, 10_000, "enabled Send button");
      return;
    }
    await sleep(400);
  }
  throw new Error("Failed to insert the prompt into the ZCode composer");
}

async function sendPrompt(connection) {
  await click(connection, "发送", "aria");
}

// Stop a session through the UI. Must be called while holding the window lock.
// The task-item only exists in its own workspace view, so switch there first
// and treat a missing stop button as "already stopped" (idempotent).
async function stopSession(connection, sessionId, fallbackWorkspace) {
  const workspace = sessionWorkspace(sessionId) || fallbackWorkspace;
  if (!workspace) throw new Error(`Cannot resolve workspace for ZCode session ${sessionId}`);
  openWorkspace(workspace);
  await waitFor(
    () => visibleRect(connection, `[data-testid=${JSON.stringify(`task-item-${sessionId}`)}]`, "selector"),
    START_TIMEOUT_MS,
    `task item for session ${sessionId}`,
  );
  await click(connection, `[data-testid=${JSON.stringify(`task-item-${sessionId}`)}]`, "selector");
  await sleep(500);
  const stop = await waitForOrNull(() => visibleRect(connection, "停止生成", "aria"), 3_000);
  if (stop) await mouseClick(connection, stop);
  return true;
}

// Phase 1: window-exclusive submission. Holds the window lock for the few
// seconds of UI work, then returns once the session id is known so the caller
// can watch it in parallel with every other session.
//
// Cancel semantics around the point of no return:
// - cancelRequested() before Send is clicked -> abort immediately (nothing was submitted);
// - cancelRequested() after Send was clicked  -> never drop the job: keep
//   hunting the session id (bounded by CANCEL_HUNT_TIMEOUT_MS), stop the
//   session inside this same lock, then throw CANCELLED. No orphan sessions.
async function submitDesktopTask({ workspace, prompt, model, mode = "yolo", resumeSessionId, signal, cancelRequested = () => false, onSent, onSession }) {
  return withWindowLock(async () => {
    await discoverZCodePage().catch(() => {
      throw new Error("ZCode Desktop CDP is unavailable. Start ZCode.exe with --remote-debugging-port=19223.");
    });
    const cutoff = baselineTime();
    const connection = await connectToZCode();
    try {
      throwIfAborted(signal);
      if (cancelRequested()) throw cancelledError();
      await prepareTask(connection, workspace, model, mode, resumeSessionId);
      await insertPrompt(connection, prompt);
      throwIfAborted(signal);
      if (cancelRequested()) throw cancelledError();
      await sendPrompt(connection);
      onSent?.();
      const huntBudget = Math.max(START_TIMEOUT_MS, TASK_TIMEOUT_MS);
      let sessionDeadline = Date.now() + huntBudget;
      let sessionRow = null;
      while (!sessionRow && Date.now() < sessionDeadline) {
        sessionRow = findPromptSession(prompt, cutoff);
        if (sessionRow) break;
        // A cancel arriving mid-hunt clamps the remaining budget: either the
        // session shows up quickly (it normally persists within a second of
        // Send) or the job settles as cancelled without hunting for half an hour.
        if (cancelRequested()) sessionDeadline = Math.min(sessionDeadline, Date.now() + CANCEL_HUNT_TIMEOUT_MS);
        await sleep(POLL_MS);
      }
      if (!sessionRow) {
        if (cancelRequested()) throw cancelledError("cancelled before the ZCode session became discoverable");
        throw new Error("Timed out waiting for ZCode session creation");
      }
      onSession?.(sessionRow.id);
      if (cancelRequested()) {
        await stopSession(connection, sessionRow.id, workspace);
        throw cancelledError();
      }
      return { sessionId: sessionRow.id, workspace };
    } finally { connection.close(); }
  });
}

// Phase 2: per-session completion watch. Pure read-only SQLite polling; any
// number of these run in parallel. Cancellation surfaces via the AbortSignal
// after the broker stopped the session through the UI.
async function watchDesktopSession({ sessionId, signal }) {
  const usageDiagnostics = (usage) => `${usage.error_type || "ZCode task failed"}${usage.error_code ? ` (${usage.error_code})` : ""}`;
  return waitFor(async () => {
    const state = readSession(sessionId);
    if (!state) return null;
    const usageStatus = state.usage?.status;
    if (USAGE_CANCELLED.has(usageStatus)) {
      return { status: "cancelled", sessionId, output: state.output, diagnostics: "", usage: state.usage };
    }
    if (USAGE_FAILED.has(usageStatus)) {
      return { status: "failed", sessionId, output: state.output, diagnostics: usageDiagnostics(state.usage), usage: state.usage };
    }
    if (state.completed || USAGE_SUCCESS.has(usageStatus)) {
      return { status: "completed", sessionId, output: state.output, diagnostics: "", usage: state.usage };
    }
    // usage row missing -> judge by final assistant message; unknown future
    // usage status -> keep waiting rather than misreporting a live turn.
    return null;
  }, TASK_TIMEOUT_MS, `ZCode session ${sessionId} completion`, signal);
}

// Cancel a running session from outside a submission. Takes the window lock
// because it mutates the UI just like a submission does.
async function cancelZCodeSession({ sessionId, workspace } = {}) {
  if (!sessionId) throw new Error("cancelZCodeSession requires sessionId");
  return withWindowLock(async () => {
    const connection = await connectToZCode();
    try { return await stopSession(connection, sessionId, workspace); }
    finally { connection.close(); }
  });
}

module.exports = {
  ZCODE_DB,
  ZCODE_EXE,
  cancelZCodeSession,
  captchaVisible,
  partCount,
  submitDesktopTask,
  watchDesktopSession,
};
