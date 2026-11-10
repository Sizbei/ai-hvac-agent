import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));
const execute = vi.fn();
vi.mock("@/lib/db", () => ({ db: { execute: (...a: unknown[]) => execute(...a) } }));
const warn = vi.fn();
vi.mock("@/lib/logger", () => ({ logger: { warn: (...a: unknown[]) => warn(...a), error: vi.fn() }, errorCode: () => "X" }));

import { getGuide, hideGuide, readGuideHidden } from "./guide-queries";

const ON = { payLinks: true };
const OFF = { payLinks: false };
const ORG = "o", USER = "u";
const NOW = new Date("2026-11-05T12:00:00.000Z");
const row = (over: Record<string, unknown> = {}) => ({
  start_job: false, finish_job: false, clock_in: false, share_location: false, add_material: false,
  note_or_photo: false, capture_signature: false, build_invoice: false, collect_payment: false,
  has_open_job: false, field_guide_state: null, ...over,
});

beforeEach(() => { execute.mockReset(); warn.mockReset(); });

describe("getGuide", () => {
  it("one SELECT and no stamp when nothing is new", async () => {
    execute.mockResolvedValueOnce({ rows: [row()] });
    const p = await getGuide(ORG, USER, { features: ON, now: NOW, write: true });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(p.progress.requiredDone).toBe(0);
    expect(p.cardHidden).toBe(false);
    expect(p.hiddenAt).toBeNull();
  });
  it("stamps new completions in a second statement and returns the derived payload from the SELECT copy", async () => {
    execute.mockResolvedValueOnce({ rows: [row({ start_job: true })] }).mockResolvedValueOnce({ rows: [] });
    const p = await getGuide(ORG, USER, { features: ON, now: NOW, write: true });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(p.steps[0].done).toBe(true);
  });
  it("getGuide with write:false never executes guideStampSql", async () => {
    execute.mockResolvedValue({ rows: [row({ start_job: true, finish_job: true, clock_in: true })] });
    const p = await getGuide(ORG, USER, { features: ON, now: NOW, write: false });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(p.steps[0].done).toBe(true);
    expect(p.progress.requiredDone).toBe(2);
  });
  it("a failed stamp write is logged and the payload still returns", async () => {
    execute.mockResolvedValueOnce({ rows: [row({ start_job: true })] }).mockRejectedValueOnce(new Error("boom"));
    const p = await getGuide(ORG, USER, { features: ON, now: NOW, write: true });
    expect(p.steps[0].done).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
  });
  it("cardHidden comes from the STORED state only", async () => {
    const old = new Date(NOW.getTime() - 25 * 3_600_000).toISOString();
    execute.mockResolvedValueOnce({ rows: [row({ finish_job: true, start_job: true, field_guide_state: { firstCompleted: { finish_job: old } } })] });
    const p = await getGuide(ORG, USER, { features: ON, now: NOW, write: true });
    expect(p.cardHidden).toBe(true);
    expect(p.finished).toBe(true);
  });
  it("a missing row derives all-false", async () => {
    execute.mockResolvedValueOnce({ rows: [] });
    expect((await getGuide(ORG, USER, { features: ON, now: NOW, write: true })).upNext).toBe("start_job");
  });
});

describe("getGuide features", () => {
  const how = (p: Awaited<ReturnType<typeof getGuide>>) => p.steps.find((x) => x.id === "collect_payment")?.how;
  it("passes features through: off drops the pay-link clause, on keeps it", async () => {
    execute.mockResolvedValue({ rows: [row()] });
    expect(how(await getGuide(ORG, USER, { features: OFF, now: NOW, write: true }))).toBe("After the customer approves, record cash or a check in the sheet that opens.");
    expect(how(await getGuide(ORG, USER, { features: ON, now: NOW, write: true }))).toContain("or tap Send pay link.");
  });
});

describe("hideGuide", () => {
  it("returns the stored hiddenAt from RETURNING, null on zero rows", async () => {
    execute.mockResolvedValueOnce({ rows: [{ field_guide_state: { hiddenAt: "2026-11-01T00:00:00.000Z", firstCompleted: {} } }] });
    expect(await hideGuide(ORG, USER, NOW)).toEqual({ hiddenAt: "2026-11-01T00:00:00.000Z" });
    execute.mockResolvedValueOnce({ rows: [] });
    expect(await hideGuide(ORG, USER, NOW)).toBeNull();
  });
});

describe("readGuideHidden", () => {
  it("true for hiddenAt or a day-old finish stamp, false otherwise, false on a thrown select", async () => {
    execute.mockResolvedValueOnce({ rows: [{ field_guide_state: { hiddenAt: "2026-11-01T00:00:00.000Z" } }] });
    expect(await readGuideHidden(ORG, USER, NOW)).toBe(true);
    execute.mockResolvedValueOnce({ rows: [{ field_guide_state: { firstCompleted: { finish_job: new Date(NOW.getTime() - 25 * 3_600_000).toISOString() } } }] });
    expect(await readGuideHidden(ORG, USER, NOW)).toBe(true);
    execute.mockResolvedValueOnce({ rows: [{ field_guide_state: null }] });
    expect(await readGuideHidden(ORG, USER, NOW)).toBe(false);
    execute.mockRejectedValueOnce(new Error("down"));
    expect(await readGuideHidden(ORG, USER, NOW)).toBe(false);
    expect(warn).toHaveBeenCalled();
  });
});
