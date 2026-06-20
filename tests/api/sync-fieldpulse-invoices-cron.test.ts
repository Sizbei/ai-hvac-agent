/**
 * Reconcile cron — the durability backstop for failed webhook pulls.
 * Verifies it fails closed without the cron secret and, when authorized, pulls
 * each connected org's job invoices (org-scoped).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { GET } from "@/app/api/cron/sync-fieldpulse-invoices/route";
import { db } from "@/lib/db";
import { verifyCronAuth } from "@/lib/cron-auth";
import { pullInvoicesForJob } from "@/lib/integrations/fieldpulse/invoice-sync";

vi.mock("@/lib/db", () => ({ db: { select: vi.fn() } }));
vi.mock("@/lib/cron-auth", () => ({ verifyCronAuth: vi.fn() }));
vi.mock("@/lib/integrations/fieldpulse/invoice-sync", () => ({
  pullInvoicesForJob: vi
    .fn()
    .mockResolvedValue({ created: 1, updated: 0, skipped: 0, failed: 0 }),
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/api-response", () => ({
  successResponse: (d: unknown) => new Response(JSON.stringify(d), { status: 200 }),
  errorResponse: (m: string, c: string, s: number) =>
    new Response(JSON.stringify({ error: m, code: c }), { status: s }),
}));
vi.mock("next/server", () => ({ after: (cb: () => unknown) => cb() }));

const mockedSelect = db.select as unknown as ReturnType<typeof vi.fn>;
const mockedAuth = verifyCronAuth as unknown as ReturnType<typeof vi.fn>;
const mockedPull = pullInvoicesForJob as unknown as ReturnType<typeof vi.fn>;

function chain(rows: unknown[]) {
  return { from: () => ({ where: () => Promise.resolve(rows) }) } as never;
}
const reqWith = (auth: string | null) =>
  ({ headers: { get: () => auth } }) as unknown as Request;

beforeEach(() => vi.clearAllMocks());

describe("sync-fieldpulse-invoices cron", () => {
  it("fails closed (401) without a valid cron secret", async () => {
    mockedAuth.mockReturnValue(false);
    const res = await GET(reqWith(null));
    expect(res.status).toBe(401);
    expect(mockedSelect).not.toHaveBeenCalled();
  });

  it("pulls each connected org's job invoices when authorized", async () => {
    mockedAuth.mockReturnValue(true);
    mockedSelect
      .mockReturnValueOnce(chain([{ organizationId: "org-1" }])) // connections
      .mockReturnValueOnce(chain([{ fieldpulseJobId: "job-1" }])); // org-1 jobs
    const res = await GET(reqWith("Bearer secret"));
    expect(res.status).toBe(200);
    expect(mockedPull).toHaveBeenCalledWith("org-1", "job-1");
  });
});
