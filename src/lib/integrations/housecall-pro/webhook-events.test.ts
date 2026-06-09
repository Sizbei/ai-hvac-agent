import { describe, it, expect } from "vitest";
import { parseWebhookEvent, eventTypeToStatus } from "./webhook-events";

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
});
