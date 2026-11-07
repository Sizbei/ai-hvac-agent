import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { attachmentMatchSql, eraseAnswersSql, eraseAttachmentsSql, eraseAuditSql, eraseLockSql } from "./erasure-sql";

const ORG = "11111111-1111-4111-8111-111111111111";
const CUST = "22222222-2222-4222-8222-222222222222";
const S1 = "33333333-3333-4333-8333-333333333333";
const dialect = new PgDialect();
const q = (s: SQL) => dialect.sqlToQuery(s);
const text = (s: SQL) => q(s).sql.replace(/\s+/g, " ").trim();
const orgCount = (s: SQL) => q(s).params.filter((p) => p === ORG).length;

describe("erase statements (spec §4.5, §5.4)", () => {
  it("statement 0 locks every request of the customer in id order", () => {
    expect(text(eraseLockSql(ORG, CUST))).toBe(
      "SELECT 1 FROM service_requests WHERE organization_id = $1::uuid AND customer_id = $2::uuid ORDER BY id FOR NO KEY UPDATE",
    );
  });

  it("the attachment match covers customer, sessions, the customer's requests and their equipment (parenthesised)", () => {
    const s = attachmentMatchSql(ORG, CUST, [S1]);
    const t = text(s);
    expect(t.startsWith("(customer_id = $1::uuid OR session_id = ANY(ARRAY[$2::uuid]::uuid[])")).toBe(true);
    expect(t).toContain("OR service_request_id IN (SELECT id FROM service_requests WHERE organization_id = $3::uuid AND customer_id = $4::uuid)");
    expect(t).toContain("OR equipment_id IN (SELECT id FROM customer_equipment WHERE organization_id = $5::uuid AND customer_id = $6::uuid))");
    expect(text(attachmentMatchSql(ORG, CUST, []))).toContain("session_id = ANY(ARRAY[]::uuid[])");
  });

  it("the audit counts attachments in SQL with the same match; details hold counts only", () => {
    const s = eraseAuditSql(ORG, CUST, [S1]);
    const t = text(s);
    expect(t).toContain("VALUES ($1::uuid, NULL, 'customer_erased', 'customers', $2::uuid, json_build_object('sessions', $3::int, 'attachmentsDeleted', (SELECT count(*)::int FROM attachments WHERE organization_id = $4::uuid AND (customer_id = $5::uuid");
    expect(q(s).params).toContain(1);
    expect(orgCount(s)).toBe(4);
  });

  it("the attachments DELETE returns storage keys, org-bound", () => {
    const t = text(eraseAttachmentsSql(ORG, CUST, []));
    expect(t.startsWith("DELETE FROM attachments WHERE organization_id = $1::uuid AND (customer_id = $2::uuid")).toBe(true);
    expect(t.endsWith("RETURNING storage_key")).toBe(true);
  });

  it("answers: values NULL, erased_at set once; status, who and when kept", () => {
    const t = text(eraseAnswersSql(ORG, CUST));
    expect(t).toBe(
      "UPDATE form_submissions SET values_encrypted = NULL, erased_at = COALESCE(erased_at, now()), updated_at = now() WHERE organization_id = $1::uuid AND service_request_id IN (SELECT id FROM service_requests WHERE organization_id = $2::uuid AND customer_id = $3::uuid)",
    );
  });
});
