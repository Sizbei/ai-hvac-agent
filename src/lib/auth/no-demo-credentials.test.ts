import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PUBLISHED_FILES = [
  "src/app/page.tsx",
  "docs/site/docs.html",
  "README.md",
  "DEMO.md",
  "GUIDE.md",
  "DEPLOY.md",
  ".claude/skills/admin-pages/SKILL.md",
  ".claude/skills/verify-page/SKILL.md",
  "scripts/screenshots.mjs",
  "scripts/agent/prod-smoke.sh",
  "scripts/agent/mint-admin-session.mjs",
  "scripts/agent/mint-tech-session.mjs",
];

describe("published files", () => {
  it.each(PUBLISHED_FILES)("%s carries no demo credentials", (file) => {
    const text = readFileSync(join(process.cwd(), file), "utf8");
    expect(text).not.toContain("admin123");
    expect(text).not.toContain("admin@demo-hvac.com");
  });
});
