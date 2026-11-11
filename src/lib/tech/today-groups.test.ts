import { describe, expect, it } from "vitest";
import { RECENT_OVERDUE_DAYS, splitTodayJobs } from "./today-groups";

const TZ = "America/New_York";
// Wed Nov 11 2026, 10:00 AM Eastern.
const NOW = new Date("2026-11-11T15:00:00Z");

function job(id: string, scheduledDate: string | null, assignmentStatus = "assigned", arrivalWindowStart: string | null = null) {
  return { id, scheduledDate, arrivalWindowStart, assignmentStatus };
}

describe("splitTodayJobs", () => {
  it("keeps today's visits and last week's overdue ones in the main list", () => {
    const jobs = [job("week", "2026-11-04T14:00:00Z"), job("today", "2026-11-11T14:00:00Z")];
    const { current, older } = splitTodayJobs(jobs, NOW, TZ);
    expect(current.map((j) => j.id)).toEqual(["week", "today"]);
    expect(older).toEqual([]);
  });

  it("moves open visits older than a week to the older group, newest first", () => {
    const jobs = [
      job("may", "2026-05-30T12:00:00Z"),
      job("oct", "2026-10-20T12:00:00Z"),
      job("eight-days", "2026-11-03T14:00:00Z"),
      job("today", "2026-11-11T14:00:00Z"),
    ];
    const { current, older } = splitTodayJobs(jobs, NOW, TZ);
    expect(current.map((j) => j.id)).toEqual(["today"]);
    expect(older.map((j) => j.id)).toEqual(["eight-days", "oct", "may"]);
    expect(RECENT_OVERDUE_DAYS).toBe(7);
  });

  it("orders older visits by their own date, not the server's window order", () => {
    // The route sorts by window start, nulls last: a date-only visit from
    // September arrives after a windowed one from May.
    const jobs = [
      job("may-window", null, "assigned", "2026-05-30T12:00:00Z"),
      job("oct-window", null, "assigned", "2026-10-20T12:00:00Z"),
      job("sep-date-only", "2026-09-15T00:00:00Z"),
      job("jan-date-only", "2026-01-10T00:00:00Z"),
    ];
    const { older } = splitTodayJobs(jobs, NOW, TZ);
    expect(older.map((j) => j.id)).toEqual(["oct-window", "sep-date-only", "may-window", "jan-date-only"]);
  });

  it("moves a stale in-progress visit too, but keeps one started this week", () => {
    const { current, older } = splitTodayJobs(
      [job("stale", "2026-07-07T12:00:00Z", "in_progress"), job("recent", "2026-11-09T14:00:00Z", "in_progress")],
      NOW,
      TZ,
    );
    expect(current.map((j) => j.id)).toEqual(["recent"]);
    expect(older.map((j) => j.id)).toEqual(["stale"]);
  });

  it("falls back to the arrival window and keeps undated or unreadable visits on top", () => {
    const jobs = [
      job("window", null, "assigned", "2026-06-01T12:00:00Z"),
      job("undated", null),
      job("bad", "not a date"),
    ];
    const { current, older } = splitTodayJobs(jobs, NOW, TZ);
    expect(current.map((j) => j.id)).toEqual(["undated", "bad"]);
    expect(older.map((j) => j.id)).toEqual(["window"]);
  });

  it("cuts on the business day, not UTC", () => {
    // 2026-11-04 03:00 UTC is Nov 3, 10 PM Eastern: eight business days ago.
    const { older } = splitTodayJobs([job("late", "2026-11-04T03:00:00Z")], NOW, TZ);
    expect(older).toHaveLength(1);
  });
});
