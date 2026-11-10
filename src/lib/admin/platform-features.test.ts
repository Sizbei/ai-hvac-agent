import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

vi.mock("server-only", () => ({}));

const batch = vi.fn();
const updateBuilder = {
  set: vi.fn(),
  where: vi.fn(),
  returning: vi.fn(),
};
const insertBuilder = { values: vi.fn() };
vi.mock("@/lib/db", () => ({
  db: {
    update: () => updateBuilder,
    insert: () => insertBuilder,
    batch: (...a: unknown[]) => batch(...a),
  },
}));

import { updateOrgFeatures } from "./platform-features";

const ORG = "11111111-1111-4111-8111-111111111111";
const ACTOR = { userId: "u-1", email: "owner@x.com" };
const dialect = new PgDialect();

beforeEach(() => {
  vi.clearAllMocks();
  updateBuilder.set.mockReturnValue(updateBuilder);
  updateBuilder.where.mockReturnValue(updateBuilder);
  updateBuilder.returning.mockReturnValue("UPDATE_STMT");
  insertBuilder.values.mockReturnValue("INSERT_STMT");
});

describe("updateOrgFeatures", () => {
  it("merges with || and scopes WHERE id = $1", async () => {
    batch.mockResolvedValue([[{ featureFlags: { map: true } }], undefined]);
    await updateOrgFeatures(ORG, { map: true }, ACTOR);

    const setArg = updateBuilder.set.mock.calls[0][0];
    const set = dialect.sqlToQuery(setArg.featureFlags);
    expect(set.sql).toContain("||");
    expect(set.sql).toContain("::jsonb");
    expect(set.params).toEqual([JSON.stringify({ map: true })]);

    const where = dialect.sqlToQuery(updateBuilder.where.mock.calls[0][0]);
    expect(where.sql).toBe('"organizations"."id" = $1');
    expect(where.params).toEqual([ORG]);
  });

  it("runs the update and one audit insert in a single batch, booleans only", async () => {
    batch.mockResolvedValue([[{ featureFlags: { map: true } }], undefined]);
    await updateOrgFeatures(ORG, { map: true, payLinks: false }, ACTOR);

    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch.mock.calls[0][0]).toEqual(["UPDATE_STMT", "INSERT_STMT"]);
    expect(insertBuilder.values).toHaveBeenCalledWith({
      action: "org_features_update",
      actorUserId: "u-1",
      actorEmail: "owner@x.com",
      targetOrgId: ORG,
      details: { features: { map: true, payLinks: false } },
    });
  });

  it("returns the merged, parsed features", async () => {
    batch.mockResolvedValue([[{ featureFlags: { map: true, junk: 1 } }], undefined]);
    const out = await updateOrgFeatures(ORG, { map: true }, ACTOR);
    expect(out).toEqual({
      map: true,
      reviewRequests: true,
      payLinks: true,
      showHistory: false,
    });
  });

  it("returns null when the org does not exist", async () => {
    batch.mockResolvedValue([[], undefined]);
    expect(await updateOrgFeatures(ORG, { map: true }, ACTOR)).toBeNull();
  });
});
