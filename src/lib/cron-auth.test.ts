/**
 * Tests for shared cron auth (timing-safe Bearer CRON_SECRET).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { verifyCronAuth, timingSafeStrEqual } from "./cron-auth";

describe("timingSafeStrEqual", () => {
  it("returns true for equal strings", () => {
    expect(timingSafeStrEqual("secret-123", "secret-123")).toBe(true);
  });
  it("returns false for different strings of equal length", () => {
    expect(timingSafeStrEqual("secret-123", "secret-124")).toBe(false);
  });
  it("returns false (not throw) for different lengths", () => {
    expect(timingSafeStrEqual("short", "longer-value")).toBe(false);
  });
  it("handles empty strings", () => {
    expect(timingSafeStrEqual("", "")).toBe(true);
    expect(timingSafeStrEqual("", "x")).toBe(false);
  });
});

describe("verifyCronAuth", () => {
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env.CRON_SECRET;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = prev;
  });

  it("fails closed when CRON_SECRET is unset", () => {
    delete process.env.CRON_SECRET;
    expect(verifyCronAuth("Bearer anything")).toBe(false);
  });

  it("fails closed when CRON_SECRET is blank", () => {
    process.env.CRON_SECRET = "   ";
    expect(verifyCronAuth("Bearer ")).toBe(false);
  });

  it("rejects a missing header", () => {
    process.env.CRON_SECRET = "s3cr3t";
    expect(verifyCronAuth(null)).toBe(false);
  });

  it("rejects a non-Bearer header", () => {
    process.env.CRON_SECRET = "s3cr3t";
    expect(verifyCronAuth("Basic s3cr3t")).toBe(false);
  });

  it("rejects a wrong token", () => {
    process.env.CRON_SECRET = "s3cr3t";
    expect(verifyCronAuth("Bearer nope")).toBe(false);
  });

  it("accepts the correct Bearer token (secret trimmed)", () => {
    process.env.CRON_SECRET = "  s3cr3t  ";
    expect(verifyCronAuth("Bearer s3cr3t")).toBe(true);
  });
});
