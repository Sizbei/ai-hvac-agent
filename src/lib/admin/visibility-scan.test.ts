import { describe, expect, it } from "vitest";
import { CHILD_TABLES, FLAGGED_TABLES, scanSource } from "./visibility-scan";

const P = "src/lib/x.ts";

function site(source: string, name: string) {
  const found = scanSource(P, source).find((s) => s.id === `${P}#${name}`);
  if (!found) throw new Error(`no site ${name}`);
  return found;
}

describe("table lists", () => {
  it("carry drizzle and snake names", () => {
    for (const t of ["customers", "serviceRequests", "service_requests", "invoices", "estimates", "customerSessions", "customer_sessions"]) {
      expect(FLAGGED_TABLES).toContain(t);
    }
    for (const t of ["payments", "customerEquipment", "customer_equipment", "messages", "appointments", "reviewRequests", "review_requests", "communicationJobs", "communication_jobs", "requestNotes", "request_notes", "customerNotes", "customer_notes", "attachments"]) {
      expect(CHILD_TABLES).toContain(t);
    }
  });
});

describe("scanSource", () => {
  it("finds .from(customers) inside an exported async function", () => {
    const src = `import x from "y";

export async function listThem(orgId: string) {
  return db.select().from(customers).where(eq(customers.organizationId, orgId));
}
`;
    const s = site(src, "listThem");
    expect(s.reads).toEqual([{ table: "customers", alias: null, kind: "flagged" }]);
    expect(s.uncovered).toEqual(["customers"]);
  });

  it("covers a drizzle read with visibleRows(T,", () => {
    const src = `export async function listThem(vis: Visibility) {
  return db.select().from(customers).where(and(eq(customers.organizationId, o), visibleRows(customers, vis)));
}
`;
    expect(site(src, "listThem").uncovered).toEqual([]);
  });

  it("finds raw FROM service_requests sr inside a const builder and needs visibleRowsSql('sr'", () => {
    const src = `const buildIt = (org: string) => sql\`
  SELECT count(*) FROM service_requests sr WHERE sr.organization_id = \${org}
\`;
`;
    const s = site(src, "buildIt");
    expect(s.reads).toEqual([{ table: "service_requests", alias: "sr", kind: "flagged" }]);
    expect(s.uncovered).toEqual(["service_requests"]);

    const wrongAlias = src.replace("WHERE", "WHERE ${visibleRowsSql('service_requests', vis)} AND");
    expect(site(wrongAlias, "buildIt").uncovered).toEqual(["service_requests"]);

    const single = src.replace("WHERE", "WHERE ${visibleRowsSql('sr', vis)} AND");
    expect(site(single, "buildIt").uncovered).toEqual([]);
    const double = src.replace("WHERE", 'WHERE ${visibleRowsSql("sr", vis)} AND');
    expect(site(double, "buildIt").uncovered).toEqual([]);
  });

  it("uses the table name when a raw read has no alias", () => {
    const src = `export function q() {
  return sql\`select id from invoices where state = 'open'\`;
}
`;
    expect(site(src, "q").reads).toEqual([{ table: "invoices", alias: null, kind: "flagged" }]);
    const covered = src.replace("where", 'where ${visibleRowsSql("invoices", vis)} and');
    expect(site(covered, "q").uncovered).toEqual([]);
  });

  it("finds JOIN ${serviceRequests} r and JOIN ${schema.customers} c", () => {
    const src = `export const thing = sql\`
  SELECT 1 FROM \${appointments} a
  JOIN \${serviceRequests} r ON r.id = a.service_request_id
  LEFT JOIN \${schema.customers} c ON c.id = r.customer_id
\`;
`;
    const s = site(src, "thing");
    expect(s.reads).toEqual(
      expect.arrayContaining([
        { table: "service_requests", alias: "r", kind: "flagged" },
        { table: "customers", alias: "c", kind: "flagged" },
        { table: "appointments", alias: "a", kind: "child" },
      ]),
    );
    expect([...s.uncovered].sort()).toEqual(["appointments", "customers", "service_requests"]);
  });

  it("a chunk filtering customers but reading invoices unfiltered reports invoices uncovered", () => {
    const src = `export async function mixed(vis: Visibility) {
  const a = await db.select().from(customers).where(visibleRows(customers, vis));
  const b = await db.select().from(invoices);
  return [a, b];
}
`;
    expect(site(src, "mixed").uncovered).toEqual(["invoices"]);
  });

  it("a payments read is covered when the chunk filters invoices", () => {
    const src = `export async function paid(vis: Visibility) {
  return db.select().from(payments).innerJoin(invoices, eq(invoices.id, payments.invoiceId)).where(visibleRows(invoices, vis));
}
`;
    const s = site(src, "paid");
    expect(s.reads).toEqual(
      expect.arrayContaining([
        { table: "payments", alias: null, kind: "child" },
        { table: "invoices", alias: null, kind: "flagged" },
      ]),
    );
    expect(s.uncovered).toEqual([]);
  });

  it("a child read with no filtered parent is uncovered", () => {
    const src = `export async function paid() {
  return db.select().from(payments);
}
`;
    expect(site(src, "paid").uncovered).toEqual(["payments"]);
  });

  it("ignores tables that share a prefix (customer_locations, invoice_lines)", () => {
    const src = `export async function other() {
  await db.select().from(customerLocations);
  await db.select().from(invoiceLines);
  await db.select().from(customersArchive);
  return sql\`SELECT 1 FROM customer_locations cl JOIN invoice_lines il ON true JOIN estimates_x e ON true\`;
}
`;
    expect(scanSource(P, src)).toEqual([]);
  });

  it("matches raw keywords in any case and normalizes drizzle names to snake", () => {
    const src = `export function q() {
  return sql\`select 1 from customer_sessions cs inner join request_notes rn on true\`;
}
export async function d() {
  return db.select().from(customerSessions).leftJoin(requestNotes, x);
}
`;
    expect(site(src, "q").reads).toEqual([
      { table: "customer_sessions", alias: "cs", kind: "flagged" },
      { table: "request_notes", alias: "rn", kind: "child" },
    ]);
    expect(site(src, "d").reads).toEqual([
      { table: "customer_sessions", alias: null, kind: "flagged" },
      { table: "request_notes", alias: null, kind: "child" },
    ]);
  });

  it("finds drizzle relational reads (db.query.T.findFirst)", () => {
    const src = `export async function status(id: string) {
  return db.query.communicationJobs.findFirst({ where: eq(communicationJobs.id, id) });
}
`;
    expect(site(src, "status").reads).toEqual([{ table: "communication_jobs", alias: null, kind: "child" }]);
  });

  it("raw FROM / JOIN match SQL (snake) names only", () => {
    const src = `export function q() {
  // parsed from customerSessions.metadata
  return 1;
}
`;
    expect(scanSource(P, src)).toEqual([]);
  });

  it("does not take an SQL keyword as an alias", () => {
    const src = `export function q() {
  return sql\`SELECT 1 FROM invoices WHERE true\`;
}
`;
    expect(site(src, "q").reads).toEqual([{ table: "invoices", alias: null, kind: "flagged" }]);
  });

  it("names a chunk before any declaration (top), and splits on non-exported functions and consts", () => {
    const src = `// reads FROM customers in a comment
import a from "b";
function helper() {
  return db.select().from(invoices);
}
const other = 1;
export default async function main() {
  return db.select().from(estimates);
}
`;
    const ids = scanSource(P, src).map((s) => s.id);
    expect(ids).toEqual([`${P}#(top)`, `${P}#helper`, `${P}#main`]);
  });

  it("does not split on nested (indented) declarations", () => {
    const src = `export async function outer() {
  const inner = await db.select().from(invoices);
  function nested() {}
  return inner;
}
`;
    expect(scanSource(P, src).map((s) => s.id)).toEqual([`${P}#outer`]);
  });

  it("returns only chunks that read a flagged or child table", () => {
    const src = `export function a() { return 1; }
export function b() { return db.select().from(messages); }
`;
    expect(scanSource(P, src).map((s) => s.id)).toEqual([`${P}#b`]);
  });
});
