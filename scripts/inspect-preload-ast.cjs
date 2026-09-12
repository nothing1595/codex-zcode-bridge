#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const parser = require("E:/ZCode/resources/app.asar/node_modules/@babel/parser");

const file = process.argv[2] || "E:/ZCode/resources/app.asar/out/preload/index.cjs";
const filter = process.argv[3] ? new RegExp(process.argv[3], "i") : null;
const source = fs.readFileSync(file, "utf8");
const ast = parser.parse(source, { sourceType: "unambiguous", allowReturnOutsideFunction: true });

function keyName(property) {
  if (property.computed) return null;
  return property.key?.name || property.key?.value || null;
}

function walk(node) {
  if (!node || typeof node !== "object") return;
  if (node.type === "CallExpression" && node.arguments?.[0]?.value === "zcode" && node.arguments?.[1]?.type === "ObjectExpression") {
    for (const property of node.arguments[1].properties) {
      const name = keyName(property);
      if (!name || (filter && !filter.test(name))) continue;
      const body = source.slice(property.start, property.end);
      const channels = [...body.matchAll(/ipcRenderer\.(?:invoke|send|sendSync)\([^,.)]+\.([A-Za-z_$][\w$]*)/g)].map((match) => match[1]);
      process.stdout.write(`${name}\t${[...new Set(channels)].join(",")}\n`);
    }
    return;
  }
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) for (const child of value) walk(child);
    else if (value && typeof value === "object" && typeof value.type === "string") walk(value);
  }
}

walk(ast.program);
