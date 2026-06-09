import { describe, it, expect } from "vitest";
import { isBusinessName } from "./detect-business-name";

describe("isBusinessName", () => {
  it("flags known chains (incl. possessive / bare brand)", () => {
    expect(isBusinessName("McDonald's")).toBe(true);
    expect(isBusinessName("mcdonalds")).toBe(true);
    expect(isBusinessName("the Walmart on Main")).toBe(true);
    expect(isBusinessName("Burger King")).toBe(true);
    expect(isBusinessName("Waffle House")).toBe(true);
  });

  it("flags legal-entity suffixes", () => {
    expect(isBusinessName("Acme Refrigeration LLC")).toBe(true);
    expect(isBusinessName("Spears Services, Inc.")).toBe(true);
    expect(isBusinessName("Tri-Cities Foods Corp")).toBe(true);
  });

  it("flags industry / venue words", () => {
    expect(isBusinessName("Joe's Diner")).toBe(true);
    expect(isBusinessName("Mountain View Restaurant")).toBe(true);
    expect(isBusinessName("Sunrise Bakery")).toBe(true);
    expect(isBusinessName("Riverside Hotel")).toBe(true);
  });

  it("flags a lone possessive brand", () => {
    expect(isBusinessName("Maguire's")).toBe(true);
  });

  it("does NOT flag genuine person names", () => {
    expect(isBusinessName("Brian Hoang")).toBe(false);
    expect(isBusinessName("Mary McDonald")).toBe(false); // surname w/ first name
    expect(isBusinessName("John Smith")).toBe(false);
    expect(isBusinessName("Anne-Marie Watson")).toBe(false);
    expect(isBusinessName("O'Brien")).toBe(false); // single surname, not possessive-s
  });

  it("does NOT flag a two-token person whose surname is an ambiguous word", () => {
    // "co", "group", "holdings", "industries", "services" are also surname-ish /
    // common words — a plain <First> <Last> must not trip the business heuristic.
    expect(isBusinessName("Mary Co")).toBe(false);
    expect(isBusinessName("Jane Holdings")).toBe(false);
    expect(isBusinessName("Will Group")).toBe(false);
    expect(isBusinessName("Brian Industries")).toBe(false);
    expect(isBusinessName("Sara Services")).toBe(false);
  });

  it("flags an ambiguous suffix only as the trailing token of a longer name", () => {
    expect(isBusinessName("Acme Refrigeration Co")).toBe(true);
    expect(isBusinessName("Smith Family Holdings")).toBe(true);
    expect(isBusinessName("Tri Cities Industries")).toBe(true);
  });

  it("handles null / empty safely", () => {
    expect(isBusinessName(null)).toBe(false);
    expect(isBusinessName(undefined)).toBe(false);
    expect(isBusinessName("")).toBe(false);
    expect(isBusinessName("   ")).toBe(false);
  });
});
