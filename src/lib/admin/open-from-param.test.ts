import { describe, it, expect } from "vitest";
import { parseOpenParams, stripParams } from "./open-from-param";

const STAFF = ["technician", "invite"] as const;

describe("parseOpenParams", () => {
  it("opens a whitelisted value and records from=setup", () => {
    expect(parseOpenParams("?new=technician&from=setup", STAFF)).toEqual({
      open: "technician",
      fromSetup: true,
    });
  });

  it("ignores values outside the whitelist", () => {
    expect(parseOpenParams("?new=admin", STAFF)).toEqual({ fromSetup: false });
    expect(parseOpenParams("?new=<script>", ["1"])).toEqual({ fromSetup: false });
  });

  it("accepts from=setup exactly and nothing else", () => {
    expect(parseOpenParams("?from=setup", ["1"])).toEqual({ fromSetup: true });
    expect(parseOpenParams("?from=Setup", ["1"])).toEqual({ fromSetup: false });
    expect(parseOpenParams("?from=setupx", ["1"])).toEqual({ fromSetup: false });
  });

  it("works without a leading ? and with no params", () => {
    expect(parseOpenParams("new=1", ["1"])).toEqual({ open: "1", fromSetup: false });
    expect(parseOpenParams("", ["1"])).toEqual({ fromSetup: false });
  });

  it("opens nothing with an empty whitelist", () => {
    expect(parseOpenParams("?new=1&from=setup", [])).toEqual({ fromSetup: true });
  });

  it("reads a custom key when given", () => {
    expect(parseOpenParams("?open=1", ["1"], "open")).toEqual({ open: "1", fromSetup: false });
  });
});

describe("stripParams", () => {
  it("removes only new and from", () => {
    expect(stripParams("?new=1&from=setup")).toBe("");
    expect(stripParams("?q=filter&new=1&type=service&from=setup")).toBe("?q=filter&type=service");
  });

  it("keeps every other key, its order and its raw encoding", () => {
    expect(stripParams("?tab=business&from=setup&x=a%20b&y=c+d")).toBe("?tab=business&x=a%20b&y=c+d");
  });

  it("removes repeated and value-less occurrences", () => {
    expect(stripParams("?new&new=2&keep=1&from")).toBe("?keep=1");
  });

  it("does not touch keys that only start with new or from", () => {
    expect(stripParams("?newest=1&fromDate=2")).toBe("?newest=1&fromDate=2");
  });

  it("returns an empty string for an empty search", () => {
    expect(stripParams("")).toBe("");
    expect(stripParams("?")).toBe("");
  });
});
