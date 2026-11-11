import { describe, it, expect } from "vitest";
import { ListChecks } from "lucide-react";
import { navGroupsFor, navItemMatches, navLabelFor } from "./nav-items";
import { filterCommands } from "@/lib/admin/nav-search";

const ON = { map: true } as const;
const OFF = { map: false } as const;

function group(placement: "operations" | "integrations", heading: string) {
  const g = navGroupsFor(placement, ON).find((x) => x.heading === heading);
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
      const all = navGroupsFor(p, ON).flatMap((g) => g.items);
      expect(all.filter((i) => i.label === "Setup")).toHaveLength(1);
    }
  });

  it("is found by the ⌘K page search", () => {
    const items = navGroupsFor("integrations", ON).flatMap((g) =>
      g.items.map((i) => ({ label: i.label, href: i.href, group: g.heading })),
    );
    expect(filterCommands("setup", items)[0]?.href).toBe("/admin/setup");
  });

  it("keeps every other item and group order unchanged", () => {
    const strip = (p: "operations" | "integrations") =>
      navGroupsFor(p, ON).map((g) => [g.heading, g.items.filter((i) => i.href !== "/admin/setup").map((i) => i.href)]);
    expect(strip("operations")).toEqual(strip("integrations"));
    expect(navGroupsFor("operations", ON).map((g) => g.heading)).toEqual([
      "Operations",
      "Customers",
      "Workspace",
      "Money",
      "Insights",
      "Integrations",
    ]);
  });

  it("returns a stable reference per placement", () => {
    expect(navGroupsFor("operations", ON)).toBe(navGroupsFor("operations", ON));
  });
});

describe("navItemMatches / navLabelFor", () => {
  it("matches the dashboard with or without a trailing slash, and only exactly", () => {
    const dash = { href: "/admin/", exact: true };
    expect(navItemMatches("/admin", dash)).toBe(true);
    expect(navItemMatches("/admin/", dash)).toBe(true);
    expect(navItemMatches("/admin/requests", dash)).toBe(false);
  });

  it("matches sub-pages but not look-alike prefixes", () => {
    const item = { href: "/admin/customers" };
    expect(navItemMatches("/admin/customers/abc", item)).toBe(true);
    expect(navItemMatches("/admin/customersx", item)).toBe(false);
  });

  it("labels the mobile top bar, including the dashboard", () => {
    expect(navLabelFor("/admin", "operations", ON)).toBe("Dashboard");
    expect(navLabelFor("/admin/conversations", "integrations", ON)).toBe("Conversations");
    expect(navLabelFor("/nowhere", "integrations", ON)).toBe("Admin");
    expect(navLabelFor("/admin/platform", "integrations", ON)).toBe("Platform");
    expect(navLabelFor("/admin/some-page/x", "integrations", ON)).toBe("Some page");
  });

  it("uses plain sentence-case labels and keeps reports out of Money", () => {
    const labels = navGroupsFor("operations", ON).flatMap((g) => g.items.map((i) => i.label));
    expect(labels).toEqual(expect.arrayContaining(["AI insights", "Settings", "FieldPulse import"]));
    expect(labels).not.toEqual(expect.arrayContaining(["AI Insights"]));
    const money = navGroupsFor("operations", ON).find((g) => g.heading === "Money")!;
    expect(money.items.map((i) => i.href)).not.toContain("/admin/reports");
    expect(navLabelFor("/admin/operations", "operations", ON)).toBe("Operations");
  });
});

describe("map gate", () => {
  const hrefs = (p: "operations" | "integrations", map: boolean) =>
    navGroupsFor(p, { map }).flatMap((g) => g.items.map((i) => i.href));

  it("omits /admin/map when map is off, for both placements", () => {
    for (const p of ["operations", "integrations"] as const) {
      expect(hrefs(p, false)).not.toContain("/admin/map");
      expect(hrefs(p, false)).toContain("/admin/dispatch");
    }
  });

  it("keeps /admin/map when map is on", () => {
    for (const p of ["operations", "integrations"] as const) {
      expect(hrefs(p, true)).toContain("/admin/map");
    }
  });

  it("returns a stable reference per placement and map value", () => {
    expect(navGroupsFor("operations", OFF)).toBe(navGroupsFor("operations", OFF));
    expect(navGroupsFor("operations", ON)).not.toBe(navGroupsFor("operations", OFF));
  });

  it("still titles the map page when it is off", () => {
    expect(navLabelFor("/admin/map", "operations", ON)).toBe("Map");
    expect(navLabelFor("/admin/map", "operations", OFF)).toBe("Map");
  });
});

describe("platform-only items", () => {
  const hrefs = (platformUi?: boolean) =>
    navGroupsFor("operations", { map: true, platformUi }).flatMap((g) => g.items.map((i) => i.href));

  it("drops the FieldPulse import board from an org's own nav, keeps it for the platform owner", () => {
    expect(hrefs(false)).not.toContain("/admin/fieldpulse-import");
    expect(hrefs(true)).toContain("/admin/fieldpulse-import");
    expect(hrefs(undefined)).toContain("/admin/fieldpulse-import");
    expect(hrefs(false)).toContain("/admin/audit-log");
  });

  it("still names the hidden page when it is opened by URL", () => {
    expect(navLabelFor("/admin/fieldpulse-import", "operations", { map: true, platformUi: false })).toBe(
      "FieldPulse import",
    );
  });
});
