import { describe, it, expect } from "vitest";
import { ListChecks } from "lucide-react";
import { navGroupsFor } from "./nav-items";
import { filterCommands } from "@/lib/admin/nav-search";

function group(placement: "operations" | "integrations", heading: string) {
  const g = navGroupsFor(placement).find((x) => x.heading === heading);
  if (!g) throw new Error(`missing group ${heading}`);
  return g;
}

describe("navGroupsFor", () => {
  it("places Setup second in Operations, after Dashboard", () => {
    const items = group("operations", "Operations").items;
    expect(items[0].label).toBe("Dashboard");
    expect(items[1]).toEqual({ label: "Setup", href: "/admin/setup", icon: ListChecks, badge: "setup" });
    expect(group("operations", "Integrations").items.some((i) => i.href === "/admin/setup")).toBe(false);
  });

  it("places Setup last in Integrations", () => {
    const items = group("integrations", "Integrations").items;
    expect(items[items.length - 1]).toEqual({
      label: "Setup",
      href: "/admin/setup",
      icon: ListChecks,
      badge: "setup",
    });
    expect(group("integrations", "Operations").items.some((i) => i.href === "/admin/setup")).toBe(false);
  });

  it("includes Setup exactly once for either placement (searchable)", () => {
    for (const p of ["operations", "integrations"] as const) {
      const all = navGroupsFor(p).flatMap((g) => g.items);
      expect(all.filter((i) => i.label === "Setup")).toHaveLength(1);
    }
  });

  it("is found by the ⌘K page search", () => {
    const items = navGroupsFor("integrations").flatMap((g) =>
      g.items.map((i) => ({ label: i.label, href: i.href, group: g.heading })),
    );
    expect(filterCommands("setup", items)[0]?.href).toBe("/admin/setup");
  });

  it("keeps every other item and group order unchanged", () => {
    const strip = (p: "operations" | "integrations") =>
      navGroupsFor(p).map((g) => [g.heading, g.items.filter((i) => i.href !== "/admin/setup").map((i) => i.href)]);
    expect(strip("operations")).toEqual(strip("integrations"));
    expect(navGroupsFor("operations").map((g) => g.heading)).toEqual([
      "Operations",
      "Customers",
      "Workspace",
      "Money",
      "Integrations",
    ]);
  });

  it("returns a stable reference per placement", () => {
    expect(navGroupsFor("operations")).toBe(navGroupsFor("operations"));
  });
});
