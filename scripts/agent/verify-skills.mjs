#!/usr/bin/env node
/**
 * Gate for the repo's page skills: every `src/...` or `scripts/...` path
 * cited in .claude/skills is checked against the filesystem. Exits non-zero
 * listing missing paths — a skill citing a nonexistent file misleads every
 * future agent session.
 *
 *   node scripts/agent/verify-skills.mjs
 */
import { readFileSync, readdirSync, existsSync, statSync } from "fs";
import { join } from "path";

const root = ".claude/skills";
const pathRe = /(?:src|scripts)\/[A-Za-z0-9_@/().[\]-]+\.[a-z]+/g;
let cited = 0;
const missing = [];

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p);
    else if (entry.endsWith(".md")) {
      const text = readFileSync(p, "utf8");
      for (const match of text.match(pathRe) ?? []) {
        cited++;
        if (!existsSync(match)) missing.push(`${p}: ${match}`);
      }
    }
  }
}

if (!existsSync(root)) {
  console.error(`${root} does not exist`);
  process.exit(1);
}
walk(root);
console.log(`${cited} paths cited, ${missing.length} missing`);
for (const m of missing) console.error(`MISSING ${m}`);
process.exit(missing.length ? 1 : 0);
