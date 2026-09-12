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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function throwIfAborted(signal) {
  if (signal?.aborted) throw Object.assign(new Error("ZCode task was cancelled"), { code: "CANCELLED" });
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

async function mouseClick(connection, rect) {
  await connection.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: rect.x, y: rect.y });
  await connection.send("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
  await connection.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
}

async function pressKey(connection, key, code = key) {
  await connection.send("Input.dispatchKeyEvent", { type: "keyDown", key, code });
  await connection.send("Input.dispatchKeyEvent", { type: "keyUp", key, code });
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
  await pressKey(connection, "Escape", "Escape");
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
  await pressKey(connection, "Escape", "Escape");
  if (resumeSessionId) {
    if (!findSessionTitle(resumeSessionId)) throw new Error(`Unknown ZCode session: ${resumeSessionId}`);
    await click(connection, `[data-testid=${JSON.stringify(`task-item-${resumeSessionId}`)}]`, "selector");
    await sleep(500);
  } else {
    await click(connection, "新建任务", "aria");
    await sleep(500);
  }
  await selectMode(connection, mode);
  await selectModel(connection, model);
}

async function insertAndSend(connection, prompt) {
  const rect = await connection.evaluate(`(() => {
    const e = Array.from(document.querySelectorAll('[contenteditable="true"][role="textbox"]')).find(x => x.offsetParent !== null);
    if (!e) return null;
    const b = e.getBoundingClientRect();
    return { x: b.x + Math.min(40, b.width / 2), y: b.y + Math.min(20, b.height / 2) };
  })()`);
  if (!rect) throw new Error("Visible ZCode composer was not found");
  await mouseClick(connection, rect);
  await connection.send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", modifiers: 2 });
  await connection.send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers: 2 });
  await pressKey(connection, "Backspace", "Backspace");
  await connection.send("Input.insertText", { text: prompt });
  await waitFor(async () => {
    const send = await visibleRect(connection, "发送", "aria");
    return send && !send.disabled ? send : null;
  }, 10_000, "enabled Send button");
  await click(connection, "发送", "aria");
}

async function cancelActiveTask() {
  let connection;
  try {
    connection = await connectToZCode();
    const stop = await visibleRect(connection, "停止生成", "aria");
    if (stop) await mouseClick(connection, stop);
  } finally { connection?.close(); }
}

async function runDesktopTask({ workspace, prompt, model, mode = "yolo", resumeSessionId, signal, onSession, onNeedsUserAction }) {
  await discoverZCodePage().catch(() => {
    throw new Error("ZCode Desktop CDP is unavailable. Start ZCode.exe with --remote-debugging-port=19223.");
  });
  const cutoff = baselineTime();
  const connection = await connectToZCode();
  try {
    throwIfAborted(signal);
    await prepareTask(connection, workspace, model, mode, resumeSessionId);
    await insertAndSend(connection, prompt);
    let waitingForUser = false;
    const reportCaptchaState = async () => {
      const visible = await captchaVisible(connection);
      if (visible !== waitingForUser) {
        waitingForUser = visible;
        onNeedsUserAction?.(visible);
      }
      return visible;
    };
    const sessionDeadline = Date.now() + Math.max(START_TIMEOUT_MS, TASK_TIMEOUT_MS);
    let sessionRow = null;
    while (!sessionRow && Date.now() < sessionDeadline) {
      throwIfAborted(signal);
      sessionRow = findPromptSession(prompt, cutoff);
      if (sessionRow) break;
      await reportCaptchaState();
      await sleep(POLL_MS);
    }
    if (!sessionRow) throw new Error("Timed out waiting for ZCode session creation");
    if (waitingForUser) { waitingForUser = false; onNeedsUserAction?.(false); }
    onSession?.(sessionRow.id);
    const final = await waitFor(async () => {
      const state = readSession(sessionRow.id);
      if (!state) return null;
      if (state.usage?.status && !["running", "pending", "completed", "success"].includes(state.usage.status)) return state;
      if (state.completed) return state;
      await reportCaptchaState();
      return null;
    }, TASK_TIMEOUT_MS, `ZCode session ${sessionRow.id} completion`, signal);
    if (waitingForUser) onNeedsUserAction?.(false);
    const failed = final.usage?.status && !["completed", "success"].includes(final.usage.status);
    return {
      status: failed ? "failed" : "completed",
      sessionId: sessionRow.id,
      output: final.output,
      diagnostics: failed ? `${final.usage.error_type || "ZCode task failed"}${final.usage.error_code ? ` (${final.usage.error_code})` : ""}` : "",
      usage: final.usage,
    };
  } finally { connection.close(); }
}

module.exports = { ZCODE_DB, ZCODE_EXE, cancelActiveTask, runDesktopTask };
