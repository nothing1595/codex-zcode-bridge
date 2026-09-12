#!/usr/bin/env node
"use strict";

const { connectToZCode } = require("../desktop/cdp-client.cjs");

const query = process.argv[2];
const mode = process.argv[3] || "aria";
if (!query || !["aria", "text", "selector"].includes(mode)) throw new Error("usage: cdp-click.cjs <query> [aria|text|selector]");

async function main() {
  const connection = await connectToZCode();
  try {
    const rect = await connection.evaluate(`(() => {
      const query = ${JSON.stringify(query)};
      const mode = ${JSON.stringify(mode)};
      let element;
      if (mode === 'aria') element = Array.from(document.querySelectorAll('[aria-label]')).find((item) => item.getAttribute('aria-label') === query && item.offsetParent !== null);
      if (mode === 'selector') element = Array.from(document.querySelectorAll(query)).find((item) => item.offsetParent !== null);
      if (mode === 'text') {
        const leaf = Array.from(document.querySelectorAll('body *')).find((item) => item.children.length === 0 && item.offsetParent !== null && (item.textContent || '').trim() === query);
        element = leaf?.closest('button,[role=menuitem],[role=option]') || leaf;
      }
      if (!element) return null;
      const box = element.getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    })()`);
    if (!rect) throw new Error(`visible element not found: ${query}`);
    await connection.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: rect.x, y: rect.y });
    await connection.send("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
    await connection.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
    process.stdout.write(`${JSON.stringify({ clicked: query, mode, ...rect })}\n`);
  } finally {
    connection.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
