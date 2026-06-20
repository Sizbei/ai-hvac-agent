import { describe, it, expect } from "vitest";
import {
  parseWebhookEvent,
  eventTypeToStatus,
  eventTypeToInvoiceStatus,
} from "./webhook-events";

describe("parseWebhookEvent", () => {
  it("narrows a well-formed job event (id, type, job id from data)", () => {
    const event = parseWebhookEvent({
      id: "evt_123",
      event: "job.completed",
      created_at: "2026-06-09T12:00:00Z",
      data: { id: "job_abc", work_status: "completed" },
    });
    expect(event).toEqual({
      eventId: "evt_123",
      eventType: "job.completed",
      hcpJobId: "job_abc",
      hcpInvoiceId: null,
    });
  });

  it("returns a null job id for a non-job event with no data.id", () => {
    const event = parseWebhookEvent({
      id: "evt_9",
      event: "estimate.sent",
      data: {},
    });
    expect(event).toEqual({
      eventId: "evt_9",
      eventType: "estimate.sent",
      hcpJobId: null,
      hcpInvoiceId: null,
    });
  });

  it("resolves an invoice event's job id from data.job_id and captures the invoice id", () => {
    const event = parseWebhookEvent({
      id: "evt_inv",
      event: "invoice.paid",
      data: { id: "inv_xyz", job_id: "job_abc", status: "paid" },
    });
    expect(event).toEqual({
      eventId: "evt_inv",
      eventType: "invoice.paid",
      hcpJobId: "job_abc",
      // The invoice event's resource id is the invoice id — the money-pull target.
      hcpInvoiceId: "inv_xyz",
    });
  });

  it("returns null when id or event is missing/malformed", () => {
    expect(parseWebhookEvent({ event: "job.completed" })).toBeNull();
    expect(parseWebhookEvent({ id: "evt_1" })).toBeNull();
    expect(parseWebhookEvent({ id: 1, event: "job.completed" })).toBeNull();
    expect(parseWebhookEvent(null)).toBeNull();
    expect(parseWebhookEvent("nope")).toBeNull();
  });
});

describe("eventTypeToStatus", () => {
  it("maps lifecycle events to request-status targets", () => {
    expect(eventTypeToStatus("job.scheduled")).toBe("scheduled");
    expect(eventTypeToStatus("job.started")).toBe("in_progress");
    expect(eventTypeToStatus("job.on_my_way")).toBe("in_progress");
    expect(eventTypeToStatus("job.completed")).toBe("completed");
    expect(eventTypeToStatus("job.canceled")).toBe("cancelled");
    expect(eventTypeToStatus("job.deleted")).toBe("cancelled");
  });

  it("returns null for non-lifecycle and unknown events", () => {
    expect(eventTypeToStatus("job.created")).toBeNull();
    expect(eventTypeToStatus("job.paid")).toBeNull();
    expect(eventTypeToStatus("something.new")).toBeNull();
  });

  it("does not map invoice events to a request-status transition", () => {
    expect(eventTypeToStatus("invoice.sent")).toBeNull();
    expect(eventTypeToStatus("invoice.paid")).toBeNull();
    expect(eventTypeToStatus("invoice.voided")).toBeNull();
  });
});

describe("eventTypeToInvoiceStatus", () => {
  it("maps invoice events to invoice/payment statuses", () => {
    expect(eventTypeToInvoiceStatus("invoice.sent")).toBe("sent");
    expect(eventTypeToInvoiceStatus("invoice.paid")).toBe("paid");
    expect(eventTypeToInvoiceStatus("invoice.voided")).toBe("void");
  });

  it("returns null for job events and unknown events", () => {
    expect(eventTypeToInvoiceStatus("job.completed")).toBeNull();
    expect(eventTypeToInvoiceStatus("invoice.refunded")).toBeNull();
    expect(eventTypeToInvoiceStatus("something.new")).toBeNull();
  });
});
