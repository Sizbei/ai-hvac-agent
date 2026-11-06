import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql, type SQL } from "drizzle-orm";
import {
  billedSql, billingInvoiceIdSql, eidParam, jobBilledSql, officeBilledSql, statusInSql,
} from "./estimate-billing-sql";
import { BILL_STATUSES, SELL_STATUSES, statusGate } from "@/lib/tech/field-sale-statuses";

const ORG = "11111111-1111-4111-8111-111111111111";
const EID = "22222222-2222-4222-8222-222222222222";
const dialect = new PgDialect();
const q = (s: SQL) => dialect.sqlToQuery(s);
const text = (s: SQL) => q(s).sql.replace(/\s+/g, " ").trim();
const orgCount = (s: SQL) => q(s).params.filter((p) => p === ORG).length;

describe("billed(eid) builders (spec §5.3)", () => {
  it("office half: a non-void invoice born from the estimate, org-bound", () => {
    const s = officeBilledSql(ORG, eidParam(EID));
    expect(text(s)).toBe(
      "EXISTS (SELECT 1 FROM invoices obi WHERE obi.organization_id = $1::uuid AND obi.estimate_id = $2::uuid AND obi.state <> 'void'::invoice_state)",
    );
    expect(q(s).params).toEqual([ORG, EID]);
  });

  it("job half: linked lines on a non-void native invoice that no estimate created", () => {
    const s = jobBilledSql(ORG, eidParam(EID));
    const t = text(s);
    expect(t.startsWith("EXISTS (SELECT 1 FROM invoice_line_items jbx JOIN invoices jbi ON jbi.id = jbx.invoice_id")).toBe(true);
    expect(t).toContain("jbi.estimate_id IS NULL");
    expect(t).toContain("jbi.state <> 'void'::invoice_state");
    expect(t).toContain("jbi.fieldpulse_invoice_id IS NULL AND jbi.hcp_invoice_id IS NULL");
    expect(t).toContain(
      "jbx.estimate_line_item_id IN (SELECT jbl.id FROM estimate_line_items jbl JOIN estimates jbe ON jbe.sold_option_id = jbl.option_id",
    );
    expect(orgCount(s)).toBe(4);
    expect(q(s).params).toHaveLength(5);
  });

  it("billed(eid) wraps its OR in parentheses", () => {
    const s = billedSql(ORG, eidParam(EID));
    const t = text(s);
    expect(t.startsWith("(EXISTS (SELECT 1 FROM invoices obi")).toBe(true);
    expect(t).toContain(") OR EXISTS (SELECT 1 FROM invoice_line_items jbx");
    expect(t.endsWith("))")).toBe(true);
    expect(q(s).params).toHaveLength(7);
  });

  it("a column eid binds no estimate param", () => {
    const s = billedSql(ORG, sql.raw("e.id"));
    expect(q(s).params).toEqual([ORG, ORG, ORG, ORG, ORG]);
    expect(text(s)).toContain("obi.estimate_id = e.id");
    expect(text(s)).toContain("jbe.id = e.id");
  });

  it("the billing invoice id prefers the office invoice", () => {
    const t = text(billingInvoiceIdSql(ORG, eidParam(EID)));
    expect(t.startsWith("COALESCE(")).toBe(true);
    expect(t.indexOf("FROM invoices obi")).toBeLessThan(t.indexOf("FROM invoice_line_items jbx"));
    expect(t).toContain("ORDER BY obi.created_at DESC LIMIT 1");
    expect(t).toContain("ORDER BY jbi.created_at DESC LIMIT 1");
    // A voided invoice is never the billing invoice, on either branch.
    expect(t).toContain("obi.estimate_id = $2::uuid AND obi.state <> 'void'::invoice_state ORDER BY");
    expect(t).toMatch(/jbi\.estimate_id IS NULL AND jbi\.state <> 'void'::invoice_state .* ORDER BY jbi\.created_at/);
  });
});

describe("request-status sets", () => {
  it("statusInSql casts every literal", () => {
    expect(text(statusInSql(SELL_STATUSES))).toBe(
      "('arrived'::request_status, 'in_progress'::request_status, 'on_hold'::request_status)",
    );
    expect(text(statusInSql(BILL_STATUSES))).toContain("'completed'::request_status");
    expect(q(statusInSql(BILL_STATUSES)).params).toHaveLength(0);
  });

  it("statusGate splits before-arrival from closed", () => {
    for (const s of ["pending", "assigned", "scheduled", "en_route"]) expect(statusGate(s, SELL_STATUSES)).toBe("not_on_site");
    expect(statusGate("completed", SELL_STATUSES)).toBe("job_closed");
    expect(statusGate("cancelled", BILL_STATUSES)).toBe("job_closed");
    expect(statusGate("completed", BILL_STATUSES)).toBe("ok");
    expect(statusGate("on_hold", SELL_STATUSES)).toBe("ok");
  });
});
