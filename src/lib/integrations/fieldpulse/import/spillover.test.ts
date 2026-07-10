/**
 * Tests for the FieldPulse spillover helper (buildFpSpillover).
 *
 * Covers:
 *  - Customers: strict ALLOWLIST enforcement — PII keys must NEVER appear in output.
 *  - Global noise denylist: qbo_*, invoice_show_*, sort_key, etc.
 *  - Populated-only: null/empty/[]/undefined values are dropped.
 *  - Conservative stringification: numbers, booleans, strings pass; objects and
 *    unclassified fields are dropped.
 *  - Jobs: only JOBS_SAFE fields (tags, is_multiday_job, tags_string) survive.
 *  - Items/estimates/invoices/assets: promoted fields excluded; extras pass
 *    only if safe.
 *  - Empty result → null (never an empty object {}).
 */
import { describe, it, expect } from "vitest";
import { buildFpSpillover } from "./spillover";

// ── Customers: strict ALLOWLIST ───────────────────────────────────────────────

describe("buildFpSpillover customers — STRICT ALLOWLIST", () => {
  // A full raw customer payload including PII fields (sanitized values).
  const fullRawCustomer = {
    id: "10001001",
    first_name: "Alice",
    last_name: "Example",
    display_name: "Alice Example (Example Corp)",
    company_name: "Example Corp",
    email: "alice@example.invalid",
    phone: "555-010-0001",
    phone_e164: "+15550100001",
    mobile_phone: "555-010-0002",
    alt_phone: "555-010-0003",
    address_1: "100 Test Street",
    address_2: "Suite 1",
    city: "Testville",
    state: "TN",
    zip_code: "37000",
    billing_address_1: "200 Billing Ave",
    billing_address_2: null,
    billing_city: "Billington",
    billing_state: "TN",
    billing_zip_code: "37001",
    lead_source: "Google",
    account_type: "residential",
    is_tax_exempt: false,
    status: "active",
    booking_portal_consent: true,
    is_phone_notification_subscribed: true,
    is_email_notification_subscribed: false,
    pipeline_status_updated_at: "2026-07-01 10:00:00",
    qbo_id: "qb-cust-123",
    created_at: "2026-01-01 10:00:00",
    updated_at: "2026-01-02 10:00:00",
    deleted_at: null,
  };

  const PII_KEYS = [
    "first_name", "last_name", "display_name", "company_name",
    "email", "phone", "phone_e164", "mobile_phone", "alt_phone",
    "address_1", "address_2", "city", "state", "zip_code",
    "billing_address_1", "billing_address_2", "billing_city",
    "billing_state", "billing_zip_code", "lead_source",
  ];

  it("allows only ALLOWLIST keys to survive (no PII keys in output)", () => {
    const result = buildFpSpillover(fullRawCustomer, "customers");
    // Must have a result (some allowlisted fields are populated).
    expect(result).not.toBeNull();
    // None of the PII keys can appear.
    for (const key of PII_KEYS) {
      expect(result).not.toHaveProperty(key);
    }
  });

  it("only allowlisted keys appear in the output", () => {
    const result = buildFpSpillover(fullRawCustomer, "customers");
    const allowedKeys = new Set([
      "status",
      "booking_portal_consent",
      "is_phone_notification_subscribed",
      "is_email_notification_subscribed",
      "pipeline_status_updated_at",
      "account_type",
    ]);
    for (const key of Object.keys(result ?? {})) {
      expect(allowedKeys.has(key)).toBe(true);
    }
  });

  it("captures allowlisted populated values correctly", () => {
    const result = buildFpSpillover(fullRawCustomer, "customers");
    expect(result).toMatchObject({
      status: "active",
      booking_portal_consent: true,
      is_phone_notification_subscribed: true,
      is_email_notification_subscribed: false,
      account_type: "residential",
    });
    expect(result).toHaveProperty("pipeline_status_updated_at", "2026-07-01 10:00:00");
  });

  it("returns null when no allowlisted fields are populated", () => {
    // Raw with only PII fields and noise.
    const piiOnly = {
      id: "999",
      first_name: "Zoe",
      email: "zoe@example.invalid",
      qbo_id: "123",
    };
    const result = buildFpSpillover(piiOnly, "customers");
    expect(result).toBeNull();
  });

  it("does not include id, created_at, updated_at, deleted_at", () => {
    const result = buildFpSpillover(fullRawCustomer, "customers");
    expect(result).not.toHaveProperty("id");
    expect(result).not.toHaveProperty("created_at");
    expect(result).not.toHaveProperty("updated_at");
    expect(result).not.toHaveProperty("deleted_at");
  });

  it("excludes qbo_* global noise", () => {
    const result = buildFpSpillover(fullRawCustomer, "customers");
    expect(result).not.toHaveProperty("qbo_id");
  });
});

// ── Global noise denylist ──────────────────────────────────────────────────────

describe("buildFpSpillover — global noise denylist", () => {
  it("drops qbo_* keys globally", () => {
    const raw = {
      is_multiday_job: true,
      qbo_customer_id: "qb-123",
      qbo_invoice_id: "qb-inv-456",
    };
    const result = buildFpSpillover(raw, "jobs");
    expect(result).not.toHaveProperty("qbo_customer_id");
    expect(result).not.toHaveProperty("qbo_invoice_id");
    expect(result).toMatchObject({ is_multiday_job: true });
  });

  it("drops invoice_show_* globally", () => {
    const raw = {
      is_multiday_job: false,
      invoice_show_pricing: true,
      invoice_show_items: "1",
    };
    const result = buildFpSpillover(raw, "jobs");
    expect(result).not.toHaveProperty("invoice_show_pricing");
    expect(result).not.toHaveProperty("invoice_show_items");
  });

  it("drops sort_key, sync_version, search_tokens globally", () => {
    const raw = {
      is_multiday_job: true,
      sort_key: "0001",
      sync_version: 42,
      search_tokens: ["foo", "bar"],
    };
    const result = buildFpSpillover(raw, "jobs");
    expect(result).not.toHaveProperty("sort_key");
    expect(result).not.toHaveProperty("sync_version");
    expect(result).not.toHaveProperty("search_tokens");
  });
});

// ── Populated-only ─────────────────────────────────────────────────────────────

describe("buildFpSpillover — populated-only", () => {
  it("drops null values", () => {
    const raw = {
      is_multiday_job: null,
      tags_string: null,
    };
    const result = buildFpSpillover(raw, "jobs");
    expect(result).toBeNull();
  });

  it("drops empty strings", () => {
    const raw = { tags_string: "" };
    const result = buildFpSpillover(raw, "jobs");
    expect(result).toBeNull();
  });

  it("drops empty arrays", () => {
    const raw = { tags: [] };
    const result = buildFpSpillover(raw, "jobs");
    expect(result).toBeNull();
  });

  it("returns null (not {}) when all values are empty", () => {
    const result = buildFpSpillover({}, "jobs");
    expect(result).toBeNull();
  });

  it("includes boolean false (not 'empty')", () => {
    const raw = { is_multiday_job: false };
    const result = buildFpSpillover(raw, "jobs");
    expect(result).toMatchObject({ is_multiday_job: false });
  });

  it("includes number 0 (not 'empty')", () => {
    // 0 is a valid number — should not be treated as empty.
    const raw = { is_multiday_job: 0 }; // edge case: 0 as number passes safeStringify as a number
    // Note: 0 passes the number check (Number.isFinite(0) = true)
    const result = buildFpSpillover(raw, "jobs");
    // 0 passes as a finite number
    expect(result).toMatchObject({ is_multiday_job: 0 });
  });
});

// ── Conservative stringification ───────────────────────────────────────────────

describe("buildFpSpillover — conservative stringification", () => {
  it("keeps string values", () => {
    const raw = { tags_string: "urgent, commercial" };
    const result = buildFpSpillover(raw, "jobs");
    expect(result?.tags_string).toBe("urgent, commercial");
  });

  it("keeps finite number values", () => {
    // is_multiday_job as a number (edge case for type coercion)
    const raw = { is_multiday_job: 1 };
    const result = buildFpSpillover(raw, "jobs");
    expect(result?.is_multiday_job).toBe(1);
  });

  it("keeps boolean values", () => {
    const raw = { is_multiday_job: true };
    const result = buildFpSpillover(raw, "jobs");
    expect(result?.is_multiday_job).toBe(true);
  });

  it("drops objects (never passed through)", () => {
    const raw = {
      is_multiday_job: true,
      some_object: { nested: "value" },
    };
    const result = buildFpSpillover(raw, "jobs");
    expect(result).not.toHaveProperty("some_object");
    expect(result).toMatchObject({ is_multiday_job: true });
  });

  it("joins array-of-strings as comma-separated", () => {
    const raw = { tags: ["urgent", "commercial", "repeat"] };
    const result = buildFpSpillover(raw, "jobs");
    expect(result?.tags).toBe("urgent, commercial, repeat");
  });

  it("drops arrays with non-string/number elements (objects in array)", () => {
    const raw = {
      tags: [{ id: 1, name: "tag" }], // object element — not primitive
      is_multiday_job: true,
    };
    const result = buildFpSpillover(raw, "jobs");
    // tags should not appear since array contains objects (no primitive elements)
    expect(result).not.toHaveProperty("tags");
    expect(result?.is_multiday_job).toBe(true);
  });
});

// ── Jobs: JOBS_SAFE allowlist within denylist mode ────────────────────────────

describe("buildFpSpillover jobs", () => {
  it("passes tags (array of strings) and is_multiday_job", () => {
    const raw = {
      id: "10000001",
      customer_id: "20000001",
      status: 1,
      billing: 1,         // DENIED — unclassified integer
      tags: ["urgent"],
      is_multiday_job: false,
      tags_string: "urgent",
    };
    const result = buildFpSpillover(raw, "jobs");
    expect(result).not.toHaveProperty("billing");
    expect(result).not.toHaveProperty("id");
    expect(result).not.toHaveProperty("customer_id");
    expect(result?.tags).toBe("urgent");
    expect(result?.is_multiday_job).toBe(false);
    expect(result?.tags_string).toBe("urgent");
  });

  it("denies billing field (unclassified integer)", () => {
    const raw = { billing: 1 };
    const result = buildFpSpillover(raw, "jobs");
    expect(result).toBeNull();
  });

  it("excludes fields not in JOBS_SAFE even if not in promoted set", () => {
    const raw = {
      is_multiday_job: true,
      some_unknown_field: "secret",  // not in JOBS_SAFE → denied
    };
    const result = buildFpSpillover(raw, "jobs");
    expect(result).not.toHaveProperty("some_unknown_field");
    expect(result?.is_multiday_job).toBe(true);
  });
});

// ── Items: promoted fields excluded ───────────────────────────────────────────

describe("buildFpSpillover items", () => {
  it("returns null for an empty raw (all fields promoted)", () => {
    const result = buildFpSpillover({}, "items");
    expect(result).toBeNull();
  });

  it("excludes promoted item fields", () => {
    const raw = {
      id: "10001",
      name: "Diagnostic",
      default_unit_price: "99.00",
      default_unit_cost: "45.00",
      default_description: "A description",
      is_labor_item: false,
      quantity_available: 10,
      vendor_type: "carrier",
      automatic_markup_percentage: 15,
      type: "service",
      is_active: true,
      default_taxable: true,
    };
    const result = buildFpSpillover(raw, "items");
    expect(result).toBeNull(); // all fields promoted, none extra
  });
});

// ── Estimates: promoted fields excluded ───────────────────────────────────────

describe("buildFpSpillover estimates", () => {
  it("excludes promoted estimate fields", () => {
    const raw = {
      id: "70000001",
      customer_id: "20000001",
      status: "2",
      subtotal: "250.00",
      total: "270.00",
      notes: "Replace capacitor",
      due_date: "2026-08-01",
      name: "HVAC Repair Quote",
    };
    const result = buildFpSpillover(raw, "estimates");
    // All are promoted → null
    expect(result).toBeNull();
  });
});

// ── Input validation ───────────────────────────────────────────────────────────

describe("buildFpSpillover — edge cases", () => {
  it("returns null for non-object input", () => {
    expect(buildFpSpillover(null, "jobs")).toBeNull();
    expect(buildFpSpillover("string", "jobs")).toBeNull();
    expect(buildFpSpillover(42, "jobs")).toBeNull();
  });
});
