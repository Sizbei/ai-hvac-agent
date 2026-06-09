import { describe, it, expect, vi, beforeEach } from "vitest";
import type { HcpWebhookEvent } from "./webhook-events";

// ── Distinct schema sentinels so the db mock can route by table identity ──────
// Defined INSIDE the factory (the mock is hoisted above top-level consts).
vi.mock("@/lib/db/schema", () => ({
  hcpWebhookEvents: { __t: "hcp_webhook_events" },
  serviceRequests: { __t: "service_requests" },
  serviceHistory: { __t: "service_history" },
  auditLog: { __t: "audit_log" },
}));
vi.mock("@/lib/db/tenant", () => ({ withTenant: () => undefined }));

// ── Mocked DB ─────────────────────────────────────────────────────────────────
// Per-test knobs: whether the ledger insert "wins" (first delivery) and which
// request row the SELECT returns. Records audit + serviceHistory inserts.
const dbState: {
  ledgerInsertWins: boolean;
  requestRows: Record<string, unknown>[];
  ledgerValues?: Record<string, unknown>;
  auditValues?: Record<string, unknown>;
  serviceHistoryValues?: Record<string, unknown>;
  ledgerDeletedEventId?: string;
} = { ledgerInsertWins: true, requestRows: [] };

const ledgerDeleted = vi.fn();

vi.mock("@/lib/db", () => {
  const insert = (table: { __t: string }) => ({
    values: (v: Record<string, unknown>) => {
      if (table.__t === "hcp_webhook_events") {
        dbState.ledgerValues = v;
        return {
          onConflictDoNothing: () => ({
            returning: () =>
              Promise.resolve(dbState.ledgerInsertWins ? [{ id: "led_1" }] : []),
          }),
        };
      }
      if (table.__t === "service_history") {
        dbState.serviceHistoryValues = v;
        return Promise.resolve();
      }
      if (table.__t === "audit_log") {
        dbState.auditValues = v;
        // logAudit-style .catch chain on the insert promise.
        return Object.assign(Promise.resolve(), {
          catch: () => Promise.resolve(),
        });
      }
      return Promise.resolve();
    },
  });
  const select = () => ({
    from: () => ({ where: () => Promise.resolve(dbState.requestRows) }),
  });
  // delete().where() — the compensating ledger release on a processing throw.
  const del = () => ({
    where: () => {
      ledgerDeleted();
      return Object.assign(Promise.resolve(), { catch: () => Promise.resolve() });
    },
  });
  return { db: { insert, select, delete: del } };
});

// ── Mocked collaborators ──────────────────────────────────────────────────────
const updateRequestStatus =
  vi.fn<
    (org: string, id: string, target: string) => Promise<Record<string, unknown>>
  >();
vi.mock("@/lib/admin/queries", () => ({
  updateRequestStatus: (org: string, id: string, target: string) =>
    updateRequestStatus(org, id, target),
}));
const addFollowUp =
  vi.fn<
    (org: string, customerId: string, input: { reason: string; dueDate: string }) => Promise<void>
  >();
vi.mock("@/lib/admin/crm-queries", () => ({
  addFollowUp: (
    org: string,
    customerId: string,
    input: { reason: string; dueDate: string },
  ) => addFollowUp(org, customerId, input),
}));
// after() runs the callback synchronously so the test can assert the follow-up.
vi.mock("next/server", () => ({
  after: (cb: () => unknown) => {
    void cb();
  },
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { applyWebhookEvent } from "./webhook-sync";

const ORG = "org-1";
const completedEvent: HcpWebhookEvent = {
  eventId: "evt_done",
  eventType: "job.completed",
  hcpJobId: "job_1",
};

beforeEach(() => {
  dbState.ledgerInsertWins = true;
  dbState.requestRows = [{ id: "req_1", customerId: "cust_1" }];
  dbState.ledgerValues = undefined;
  dbState.auditValues = undefined;
  dbState.serviceHistoryValues = undefined;
  updateRequestStatus.mockReset();
  addFollowUp.mockReset();
  addFollowUp.mockResolvedValue(undefined);
  ledgerDeleted.mockReset();
});

describe("applyWebhookEvent — status mapping", () => {
  it("transitions the mapped request through the state machine and audits", async () => {
    updateRequestStatus.mockResolvedValue({ ok: true, status: "completed" });

    const result = await applyWebhookEvent(ORG, completedEvent);

    expect(result.outcome).toBe("applied");
    expect(updateRequestStatus).toHaveBeenCalledWith(ORG, "req_1", "completed");
    expect(dbState.auditValues?.action).toBe("hcp_webhook_received");
    expect(dbState.auditValues?.entityId).toBe("req_1");
    // Details are non-PII: ids + enums only.
    const details = JSON.parse(String(dbState.auditValues?.details));
    expect(details).toMatchObject({
      eventId: "evt_done",
      eventType: "job.completed",
      hcpJobId: "job_1",
      outcome: "applied",
    });
  });

  it("maps job.started -> in_progress", async () => {
    updateRequestStatus.mockResolvedValue({ ok: true, status: "in_progress" });
    await applyWebhookEvent(ORG, {
      eventId: "evt_s",
      eventType: "job.started",
      hcpJobId: "job_1",
    });
    expect(updateRequestStatus).toHaveBeenCalledWith(ORG, "req_1", "in_progress");
  });
});

describe("applyWebhookEvent — idempotent redelivery", () => {
  it("processes only the FIRST delivery; a redelivery applies no second update", async () => {
    updateRequestStatus.mockResolvedValue({ ok: true, status: "completed" });

    // First delivery: ledger insert wins.
    dbState.ledgerInsertWins = true;
    const first = await applyWebhookEvent(ORG, completedEvent);
    expect(first.outcome).toBe("applied");
    expect(updateRequestStatus).toHaveBeenCalledTimes(1);

    // Redelivery: ledger insert conflicts (zero rows) → short-circuit.
    dbState.ledgerInsertWins = false;
    const second = await applyWebhookEvent(ORG, completedEvent);
    expect(second.outcome).toBe("duplicate");
    // Still only one status update across both deliveries.
    expect(updateRequestStatus).toHaveBeenCalledTimes(1);
  });
});

describe("applyWebhookEvent — unknown job id", () => {
  it("records + no-ops (no transition) when no request maps to the HCP job", async () => {
    dbState.requestRows = [];
    const result = await applyWebhookEvent(ORG, completedEvent);
    expect(result.outcome).toBe("unknown_job");
    expect(updateRequestStatus).not.toHaveBeenCalled();
    expect(dbState.auditValues?.entityId).toBe(null);
  });
});

describe("applyWebhookEvent — unmapped event type", () => {
  it("no-ops on a non-lifecycle event without finding a request", async () => {
    const result = await applyWebhookEvent(ORG, {
      eventId: "evt_paid",
      eventType: "job.paid",
      hcpJobId: "job_1",
    });
    expect(result.outcome).toBe("unmapped_event");
    expect(updateRequestStatus).not.toHaveBeenCalled();
  });
});

describe("applyWebhookEvent — illegal transition", () => {
  it("never forces an illegal edge; records invalid_transition", async () => {
    updateRequestStatus.mockResolvedValue({
      ok: false,
      reason: "invalid_transition",
      currentStatus: "completed",
    });
    const result = await applyWebhookEvent(ORG, {
      eventId: "evt_sched_late",
      eventType: "job.scheduled",
      hcpJobId: "job_1",
    });
    expect(result.outcome).toBe("invalid_transition");
    expect(dbState.auditValues?.details).toContain("invalid_transition");
  });
});

describe("applyWebhookEvent — durability on a transient failure", () => {
  it("RELEASES the ledger claim and rethrows when processing throws, so HCP's retry isn't dropped", async () => {
    // First delivery claims the ledger, then the status update throws (DB blip).
    dbState.ledgerInsertWins = true;
    updateRequestStatus.mockRejectedValue(new Error("db blip"));

    await expect(applyWebhookEvent(ORG, completedEvent)).rejects.toThrow(
      "db blip",
    );
    // The ledger row we just inserted is deleted, so a redelivery is NOT deduped.
    expect(ledgerDeleted).toHaveBeenCalledTimes(1);
  });

  it("does NOT release the ledger on a terminal no-op (invalid_transition)", async () => {
    updateRequestStatus.mockResolvedValue({
      ok: false,
      reason: "invalid_transition",
      currentStatus: "completed",
    });
    await applyWebhookEvent(ORG, completedEvent);
    // A definitive outcome keeps the ledger row — retrying wouldn't change it.
    expect(ledgerDeleted).not.toHaveBeenCalled();
  });
});

describe("applyWebhookEvent — completion follow-up", () => {
  it("schedules a follow-up + service_history on a completion", async () => {
    updateRequestStatus.mockResolvedValue({ ok: true, status: "completed" });
    await applyWebhookEvent(ORG, completedEvent);

    expect(addFollowUp).toHaveBeenCalledTimes(1);
    const [org, customerId, input] = addFollowUp.mock.calls[0]!;
    expect(org).toBe(ORG);
    expect(customerId).toBe("cust_1");
    expect(input.reason).toContain("follow-up");
    // service_history row marks the completed service as needing follow-up.
    expect(dbState.serviceHistoryValues).toMatchObject({
      customerId: "cust_1",
      serviceRequestId: "req_1",
      organizationId: ORG,
      followUpNeeded: true,
    });
  });

  it("does NOT schedule a follow-up on a non-completion transition", async () => {
    updateRequestStatus.mockResolvedValue({ ok: true, status: "in_progress" });
    await applyWebhookEvent(ORG, {
      eventId: "evt_start",
      eventType: "job.started",
      hcpJobId: "job_1",
    });
    expect(addFollowUp).not.toHaveBeenCalled();
  });
});
