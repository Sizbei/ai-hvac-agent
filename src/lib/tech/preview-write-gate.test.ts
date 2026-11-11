import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { previewWriteRefusal } from "./preview-write-gate";

const REAL = { userId: "u1", organizationId: "o1", email: "t@x", name: "T", role: "technician" as const };
const PREVIEW = { ...REAL, preview: { adminUserId: "a1", exp: 9_999_999_999 } };

describe("previewWriteRefusal", () => {
  it.each(["POST", "PUT", "PATCH", "DELETE", "post", "OPTIONS"])(
    "refuses %s while previewing with 403 PREVIEW_READ_ONLY",
    async (method) => {
      const res = previewWriteRefusal(PREVIEW, { method });
      expect(res?.status).toBe(403);
      expect(await res?.json()).toEqual({
        success: false,
        error: { message: "Read-only while viewing as another user", code: "PREVIEW_READ_ONLY" },
      });
    },
  );

  it.each(["GET", "HEAD", "get"])("lets %s through while previewing", (method) => {
    expect(previewWriteRefusal(PREVIEW, { method })).toBeNull();
  });

  it.each(["POST", "DELETE", "GET"])("never refuses a real technician (%s)", (method) => {
    expect(previewWriteRefusal(REAL, { method })).toBeNull();
  });
});

// Every tech write handler must reach the gate, directly or through a shared
// preamble that calls it, so a preview write is refused even without the proxy.
const API_TECH = join(__dirname, "../../app/api/tech");
const GATES = ["previewWriteRefusal(", "frontGates(", "techWritePreamble(", "techEquipmentPreamble(", "techFormFront("];

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return routeFiles(p);
    return name === "route.ts" ? [p] : [];
  });
}

function writeHandlers(src: string): { method: string; body: string }[] {
  const parts = src.split(/(?=export async function )/);
  return parts.flatMap((part) => {
    const m = /^export async function (POST|PUT|PATCH|DELETE)\b/.exec(part);
    return m ? [{ method: m[1], body: part }] : [];
  });
}

describe("every /api/tech write handler is preview-gated", () => {
  const files = routeFiles(API_TECH);
  const handlers = files.flatMap((f) =>
    writeHandlers(readFileSync(f, "utf8")).map((h) => ({ file: f.slice(API_TECH.length), ...h })),
  );

  it("finds the write handlers", () => {
    expect(handlers.length).toBeGreaterThanOrEqual(24);
  });

  it.each(handlers.map((h) => [`${h.method} ${h.file}`, h.body]))("%s", (_name, body) => {
    expect(GATES.some((g) => body.includes(g))).toBe(true);
  });
});
