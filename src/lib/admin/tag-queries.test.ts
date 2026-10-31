import { describe, it, expect, beforeEach, vi } from "vitest";
import { replaceEntityTags } from "./tag-queries";
import { db } from "@/lib/db";

vi.mock("@/lib/db", () => ({
  db: { select: vi.fn(), delete: vi.fn(), insert: vi.fn(), batch: vi.fn() },
}));

const ORG = "org-1";
const ENT = "job-1";
const A = "tag-a"; // active, new
const I = "tag-i"; // inactive, already attached

function selectOnce(rows: unknown[]) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(rows) }),
  } as never);
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(db.delete).mockReturnValue({ where: vi.fn().mockReturnValue({}) } as never);
  vi.mocked(db.insert).mockReturnValue({ values: vi.fn().mockReturnValue({}) } as never);
  vi.mocked(db.batch).mockResolvedValue([] as never);
});

describe("replaceEntityTags", () => {
  it("adds an active tag while an inactive one stays attached", async () => {
    selectOnce([{ id: I }]); // current
    selectOnce([{ id: A }]); // added, active-only
    selectOnce([{ id: I }]); // kept, any state
    await expect(replaceEntityTags(ORG, "job", ENT, [A, I])).resolves.toEqual({ ok: true });
    expect(db.batch).toHaveBeenCalledTimes(1);
  });

  it("rejects adding an inactive tag (not returned by the active-only check)", async () => {
    selectOnce([]); // current
    selectOnce([]); // added: inactive -> not found
    await expect(replaceEntityTags(ORG, "job", ENT, [A])).resolves.toEqual({ ok: false, reason: "unknown_tag" });
    expect(db.batch).not.toHaveBeenCalled();
  });

  it("rejects a tag of the wrong entity kind", async () => {
    selectOnce([{ id: I }]); // current
    selectOnce([]); // kept: wrong entity -> not found
    await expect(replaceEntityTags(ORG, "job", ENT, [I])).resolves.toEqual({ ok: false, reason: "unknown_tag" });
    expect(db.batch).not.toHaveBeenCalled();
  });

  it("counts duplicate input ids once", async () => {
    selectOnce([]); // current
    selectOnce([{ id: A }]); // added: one unique id
    await expect(replaceEntityTags(ORG, "job", ENT, [A, A, A])).resolves.toEqual({ ok: true });
  });

  it("maps a wrapped 23505 to a race", async () => {
    selectOnce([]);
    selectOnce([{ id: A }]);
    vi.mocked(db.batch).mockRejectedValueOnce(Object.assign(new Error("q"), { cause: { code: "23505" } }));
    await expect(replaceEntityTags(ORG, "job", ENT, [A])).resolves.toEqual({ ok: false, reason: "race" });
  });
});
