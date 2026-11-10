import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

vi.mock("server-only", () => ({}));

vi.mock("next/server", () => ({
  after: (fn: () => Promise<void> | void) => {
    void fn();
  },
}));

const cookieSet = vi.fn();
const cookieGet = vi.fn();
vi.mock("next/headers", () => ({
  cookies: async () => ({ set: cookieSet, get: cookieGet, delete: vi.fn() }),
}));

const execute = vi.fn();
vi.mock("@/lib/db", () => ({ db: { execute: (q: SQL) => execute(q) } }));

vi.mock("./tech-config", () => ({
  signTechToken: vi.fn(async () => "tok"),
  verifyTechToken: vi.fn(),
}));
vi.mock("./session-revocation", () => ({ isSessionUserCurrent: vi.fn() }));

const warn = vi.fn();
vi.mock("@/lib/logger", () => ({ logger: { warn: (...a: unknown[]) => warn(...a) } }));

import { createTechSession, getTechSession } from "./tech-session";
import { verifyTechToken } from "./tech-config";
import { isSessionUserCurrent } from "./session-revocation";
const DEMO_ORG_ID = "44444444-4444-4444-4444-444444444444";

const ORG = "33333333-3333-3333-3333-333333333333";
const payload = (organizationId: string) =>
  ({ userId: "u1", organizationId, role: "technician" }) as never;

beforeEach(() => {
  process.env.DEMO_MODE_ORG_IDS = DEMO_ORG_ID;
  execute.mockReset().mockResolvedValue({ rows: [] });
  cookieSet.mockClear();
  warn.mockClear();
});

describe("createTechSession onboarding flag", () => {
  it("never writes for the demo org", async () => {
    await createTechSession(payload(DEMO_ORG_ID));
    expect(cookieSet).toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("writes a guarded techSignedInAt statement for a real org", async () => {
    await createTechSession(payload(ORG));
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    const q = new PgDialect().sqlToQuery(execute.mock.calls[0][0] as SQL);
    expect(q.sql).toContain("#> '{flags,techSignedInAt}' IS NULL");
    expect(q.params).toContain(ORG);
  });

  it("does not reject when the write throws", async () => {
    execute.mockRejectedValue(new Error("db down"));
    await expect(createTechSession(payload(ORG))).resolves.toBeUndefined();
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
  });
});

describe("getTechSession revocation call shape", () => {
  it("passes the token email to isSessionUserCurrent", async () => {
    cookieGet.mockReturnValue({ value: "tok" });
    const tokenPayload = {
      userId: "u1",
      organizationId: ORG,
      email: "tech@example.com",
      name: "Tess",
      role: "technician",
    };
    vi.mocked(verifyTechToken).mockResolvedValue(tokenPayload as never);
    vi.mocked(isSessionUserCurrent).mockResolvedValue(true);
    expect(await getTechSession()).toEqual(tokenPayload);
    expect(isSessionUserCurrent).toHaveBeenCalledWith(
      "u1",
      ORG,
      "technician",
      "tech@example.com",
    );
  });

  it("returns null when the revocation check denies", async () => {
    cookieGet.mockReturnValue({ value: "tok" });
    vi.mocked(verifyTechToken).mockResolvedValue({
      userId: "u1",
      organizationId: ORG,
      email: "mike.johnson@demo-hvac.com",
      name: "Mike",
      role: "technician",
    } as never);
    vi.mocked(isSessionUserCurrent).mockResolvedValue(false);
    expect(await getTechSession()).toBeNull();
  });
});
