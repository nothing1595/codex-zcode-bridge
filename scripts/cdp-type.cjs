#!/usr/bin/env node
"use strict";

const { connectToZCode } = require("../desktop/cdp-client.cjs");

const text = process.argv.slice(2).join(" ");
if (!text) throw new Error("usage: cdp-type.cjs <text>");

async function main() {
  const connection = await connectToZCode();
  try {
    const rect = await connection.evaluate(`(() => {
      const element = Array.from(document.querySelectorAll('[contenteditable="true"][role="textbox"]')).find((item) => item.offsetParent !== null);
      if (!element) return null;
      const box = element.getBoundingClientRect();
      return { x: box.x + Math.min(box.width / 2, 40), y: box.y + Math.min(box.height / 2, 20) };
    })()`);
    if (!rect) throw new Error("visible ZCode composer was not found");
    await connection.send("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
    await connection.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
    await connection.send("Input.insertText", { text });
    process.stdout.write(`${JSON.stringify({ inserted: true, length: text.length })}\n`);
  } finally {
    connection.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
