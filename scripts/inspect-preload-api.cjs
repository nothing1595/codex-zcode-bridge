#!/usr/bin/env node
"use strict";

const fs = require("node:fs");

const file = process.argv[2] || "E:\\ZCode\\resources\\app.asar\\out\\preload\\index.cjs";
const source = fs.readFileSync(file, "utf8");
if (process.argv.includes("--worlds")) {
  for (const match of source.matchAll(/exposeInMainWorld\((?:'|")([^'"]+)/g)) {
    process.stdout.write(`${match[1]}\n`);
  }
  process.exit(0);
}
const marker = 'exposeInMainWorld("zcode",{';
const start = source.indexOf(marker);
if (start < 0) throw new Error("window.zcode preload API was not found");
const tail = source.slice(start, start + 250_000);
const entries = new Map();
const pattern = /(?:^|,)([A-Za-z_$][\w$]*):s\([\s\S]{0,300}?ipcRenderer\.(invoke|send|sendSync)\(b\.([A-Za-z_$][\w$]*)/g;
for (const match of tail.matchAll(pattern)) {
  if (!entries.has(match[1])) entries.set(match[1], { transport: match[2], channelSymbol: match[3] });
}
for (const [name, details] of entries) {
  process.stdout.write(`${name}\t${details.transport}\t${details.channelSymbol}\n`);
}
