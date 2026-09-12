#!/usr/bin/env node
"use strict";

const CDP_HOST = process.env.ZCODE_CDP_HOST || "127.0.0.1";
const CDP_PORT = Number(process.env.ZCODE_CDP_PORT || 19223);

function redactSensitive(value) {
  if (typeof value !== "string") return value;
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED_JWT]")
    .replace(/(['"]?(?:authorization|x-api-key|api[_-]?key|set-cookie|cookie|token|x-aliyun-captcha-verify-param)['"]?\s*:\s*['"])[^'"\r\n]*(['"])/gi, "$1[REDACTED]$2");
}

async function discoverZCodePage() {
  const response = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  if (!response.ok) throw new Error(`CDP discovery failed: HTTP ${response.status}`);
  const targets = await response.json();
  const page = targets.find((target) => target.type === "page" && /^file:\/\/\/.+\/ZCode\/resources\/app\.asar\/out\/renderer\/index\.html/i.test(target.url));
  if (!page?.webSocketDebuggerUrl) throw new Error("ZCode page target was not found on the CDP endpoint");
  return page;
}

class CdpConnection {
  constructor(webSocketUrl) {
    this.socket = new WebSocket(webSocketUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id === undefined) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }

  async open() {
    if (this.socket.readyState === WebSocket.OPEN) return this;
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", () => reject(new Error("CDP WebSocket connection failed")), { once: true });
    });
    return this;
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  async evaluate(expression, options = {}) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: options.awaitPromise !== false,
      returnByValue: options.returnByValue !== false,
      userGesture: options.userGesture !== false,
    });
    if (result.exceptionDetails) {
      const description = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
      throw new Error(redactSensitive(description));
    }
    return result.result?.value;
  }

  close() {
    this.socket.close();
  }
}

async function connectToZCode() {
  const page = await discoverZCodePage();
  return new CdpConnection(page.webSocketDebuggerUrl).open();
}

module.exports = { CDP_HOST, CDP_PORT, CdpConnection, connectToZCode, discoverZCodePage, redactSensitive };

if (require.main === module) {
  const expression = process.argv.slice(2).join(" ") || "({ title: document.title, url: location.href })";
  connectToZCode()
    .then(async (connection) => {
      try {
        const value = await connection.evaluate(expression);
        process.stdout.write(`${redactSensitive(JSON.stringify(value, null, 2))}\n`);
      } finally {
        connection.close();
      }
    })
    .catch((error) => {
      process.stderr.write(`${redactSensitive(error.stack || error.message)}\n`);
      process.exitCode = 1;
    });
}
