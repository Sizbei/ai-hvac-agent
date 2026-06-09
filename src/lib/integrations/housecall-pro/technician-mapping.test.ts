import { describe, it, expect } from "vitest";
import {
  mapHcpTechnicians,
  toHcpTechId,
  HCP_TECH_ID_PREFIX,
} from "./technician-mapping";
import type { HousecallTechnician } from "./types";

describe("mapHcpTechnicians", () => {
  it("maps each HCP technician id to an opaque prefixed tech id", () => {
    const techs: HousecallTechnician[] = [
      { id: "emp-1", name: "Pat", isActive: true },
      { id: "emp-2", name: "Sam", isActive: true },
    ];
    const ids = mapHcpTechnicians(techs);
    expect(ids).toHaveLength(2);
    expect(ids).toContain(toHcpTechId("emp-1"));
    expect(ids).toContain(toHcpTechId("emp-2"));
    expect(ids.every((id) => id.startsWith(HCP_TECH_ID_PREFIX))).toBe(true);
  });

  it("NO PII: the opaque id carries only the employee id, never the name", () => {
    const ids = mapHcpTechnicians([{ id: "emp-9", name: "Jane Doe" }]);
    expect(ids[0]).toBe(`${HCP_TECH_ID_PREFIX}emp-9`);
    expect(ids[0]).not.toContain("Jane");
    expect(ids[0]).not.toContain("Doe");
  });

  it("filters out explicitly inactive technicians", () => {
    const techs: HousecallTechnician[] = [
      { id: "emp-1", isActive: true },
      { id: "emp-2", isActive: false },
    ];
    const ids = mapHcpTechnicians(techs);
    expect(ids).toEqual([toHcpTechId("emp-1")]);
  });

  it("keeps technicians whose active flag is missing (undefined != inactive)", () => {
    const ids = mapHcpTechnicians([{ id: "emp-1" }, { id: "emp-2", name: "X" }]);
    expect(ids).toHaveLength(2);
  });

  it("tolerates a missing name", () => {
    const ids = mapHcpTechnicians([{ id: "emp-1", isActive: true }]);
    expect(ids).toEqual([toHcpTechId("emp-1")]);
  });

  it("drops rows without a usable id", () => {
    const techs = [
      { id: "", name: "blank" },
      { id: "emp-1" },
    ] as unknown as HousecallTechnician[];
    const ids = mapHcpTechnicians(techs);
    expect(ids).toEqual([toHcpTechId("emp-1")]);
  });

  it("de-duplicates repeated technician ids", () => {
    const ids = mapHcpTechnicians([
      { id: "emp-1", isActive: true },
      { id: "emp-1", isActive: true },
    ]);
    expect(ids).toEqual([toHcpTechId("emp-1")]);
  });

  it("returns an empty roster for an empty list", () => {
    expect(mapHcpTechnicians([])).toEqual([]);
  });
});
