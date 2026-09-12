const fs = require("node:fs");
const path = require("node:path");

const root = process.argv[2];
const pattern = new RegExp(process.argv[3] || "providerEndpointRouting|requestProviderRuntimeHeaders", "i");
const filePattern = process.argv[4] ? new RegExp(process.argv[4], "i") : null;
const before = Number(process.argv[5] || 900);
const after = Number(process.argv[6] || 2200);

function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    const stat = fs.statSync(file);
    if (stat.isDirectory()) {
      walk(file);
    } else if (/\.(?:c?js|mjs|json)$/i.test(name) && stat.size <= 50 * 1024 * 1024 && (!filePattern || filePattern.test(file))) {
      const source = fs.readFileSync(file, "utf8");
      const matches = [...source.matchAll(new RegExp(pattern.source, "ig"))];
      if (matches.length) {
        console.log(`FILE ${file}`);
        for (const match of matches.slice(0, 12)) {
          const start = Math.max(0, match.index - before);
          const end = Math.min(source.length, match.index + after);
          console.log(source.slice(start, end));
        }
      }
    }
  }
}

walk(root);
