/**
 * FieldPulse spillover helper — buildFpSpillover.
 *
 * Captures the "long tail" of FP fields that aren't promoted to typed columns into
 * a per-row `fieldpulse_data` jsonb blob. Safety model:
 *
 *  - Global noise denylist: integration ids (qbo/xero/mongo_id/...), FP PDF display
 *    config keys, and fields already promoted to typed columns are always excluded.
 *  - Per-entity policy:
 *      "customers" → STRICT ALLOWLIST: only the named safe non-PII fields survive.
 *                    PII (names/emails/phones/addresses) can NEVER enter plaintext jsonb.
 *      other entities → DENYLIST mode: known-bad fields excluded; unclassified fields
 *                    excluded if they could carry PII (default-DENY-when-uncertain).
 *  - Only POPULATED values stored (null/empty string/[]/{}  dropped).
 *  - Conservative stringification: numbers, booleans, and strings only. Objects are
 *    never passed through unless explicitly classified safe.
 *  - Default = DENY when uncertain (any field that can't be classified safe at
 *    implementation is added to the denylist, never passed through).
 *
 * See spec §2 for the full design rationale and rationale for each choice.
 */

// ── Types ──────────────────────────────────────────────────────────────────────

/** Entity policy: which safety model applies. */
export type SpilloverPolicy = "customers" | "invoices" | "estimates" | "jobs" | "assets" | "items";

/** Sanitized spillover output — safe to write to jsonb. */
export type FpSpillover = Record<string, string | number | boolean> | null;

// ── Global noise denylist ──────────────────────────────────────────────────────
// Fields excluded from ALL entities regardless of policy.
// Includes:
//  - Integration ids (qbo_*, xero_*, service_titan_*, etc.)
//  - FP PDF display config keys (invoice_show_*, invoice_use_*, etc.)
//  - Fields already promoted to typed columns (entity-specific, also listed here
//    for defense-in-depth)
//  - Sort/search/sync noise
const GLOBAL_DENYLIST = new Set<string>([
  // Integration / external system ids
  "qbo_id", "qbo_customer_id", "qbo_item_id", "qbo_invoice_id", "qbo_estimate_id",
  "qbd_id", "qbd_customer_id", "qbd_item_id", "qbd_invoice_id",
  "xero_id", "xero_customer_id", "xero_item_id", "xero_invoice_id",
  "mongo_id", "cuid", "uuid",
  "nicejob_id", "nicejob_review_id", "should_send_nicejob_review",
  "pipedrive_id", "pipedrive_person_id", "pipedrive_deal_id",
  "mailchimp_id", "mailchimp_list_id",
  "stripe_id", "stripe_customer_id",
  "tsheets_id",
  "service_titan_id", "service_titan_location_id",
  "companycam_id",
  "hazardco_id", "hazardco_swms_id",
  "azuga_id",
  "zyra_id", "zyra_call_id",
  "import_id",
  "sort_key",
  "franchise_location_status", "franchise_id",
  "sync_version", "failed_sync",
  // Search/sort noise
  "search_tokens", "search_index",
  // FP PDF display config
  "invoice_show_pricing", "invoice_show_subtotal", "invoice_show_tax",
  "invoice_show_payment", "invoice_show_items", "invoice_show_description",
  "invoice_show_cost", "invoice_show_qty", "invoice_show_unit_price",
  "invoice_use_items", "invoice_use_tax", "invoice_use_discount",
  "invoice_contract_text", "invoice_contract_enabled",
  "display_settings", "invoice_display_settings", "estimate_display_settings",
  // Already-promoted fields (shared) — redundant vs entity-specific lists below
  // but listed here for defense-in-depth so they never leak through.
  "id", "created_at", "updated_at", "deleted_at",
]);

// Keys that start with these prefixes are also globally denied.
const GLOBAL_DENYLIST_PREFIXES = [
  "qbo_", "qbd_", "xero_", "stripe_", "tsheets_", "service_titan_",
  "companycam_", "hazardco_", "azuga_", "zyra_", "nicejob_", "pipedrive_",
  "mailchimp_", "franchise_", "search_", "invoice_show_", "invoice_use_",
  "invoice_contract_", "invoice_display_", "estimate_display_",
];

function isGloballyDenied(key: string): boolean {
  if (GLOBAL_DENYLIST.has(key)) return true;
  for (const prefix of GLOBAL_DENYLIST_PREFIXES) {
    if (key.startsWith(prefix)) return true;
  }
  return false;
}

// ── Per-entity promoted-field denylists ────────────────────────────────────────
// Fields already written to typed columns on each table — excluded from spillover
// to avoid duplication. This list is the source of truth for what NOT to pass through.

const ITEMS_PROMOTED = new Set<string>([
  "id", "name", "default_unit_price", "default_taxable", "is_active", "type",
  "default_unit_cost", "default_description", "is_labor_item",
  "quantity_available", "vendor_type", "automatic_markup_percentage",
  "created_at", "updated_at", "deleted_at",
  // FP item-specific noise
  "company_id", "import_id",
]);

const ESTIMATES_PROMOTED = new Set<string>([
  "id", "customer_id", "job_id", "status", "subtotal", "tax", "total",
  "grand_total", "notes", "due_date", "invoiced_date", "line_items",
  "custom_status", "name", "title", "created_at", "updated_at", "deleted_at",
]);

const INVOICES_PROMOTED = new Set<string>([
  "id", "job_id", "customer_id", "status", "total", "amount_paid",
  "amount_unpaid", "due_date", "last_payment_date", "first_payment_date",
  "created_at", "updated_at", "deleted_at", "line_items",
]);

const JOBS_PROMOTED = new Set<string>([
  "id", "customer_id", "work_status", "status", "description", "notes",
  "field_notes", "start_time", "end_time", "schedule_start", "schedule_end",
  "assigned_user_id", "created_at", "updated_at", "deleted_at",
  "job_type", "subtitle", "status_int", "completed_at",
  "customer_arrival_window_start_time", "customer_arrival_window_end_time",
  "assignments",
  // Jobs fields that are too ambiguous/PII-adjacent to pass through (DENY)
  "billing",        // integer — meaning unclassified; see spec §2 jobs.billing decision
  "location_old",   // may carry address PII
  "location_coords", // geolocation — potentially PII
  "location_id",    // foreign key, not useful as jsonb
  "temp_location_id",
  "customer_contact_id", // contact reference — potentially PII
  "source",         // may carry PII (referral names, phone numbers)
  "company_id",
  "author_id",
  "cuid",
  "project_id",
  "recurring_parent_id",
  "upcoming_job_notified",
  "detached_from_recurring_parent",
  "maintenance_agreement_id",
  "maintenance_occurrence_id",
  "task_category_id",
  "is_template",
  "template_id",
  "status_id",
  "status_workflow_id",
  "is_visible",
  "status_based_button_workflow_id",
  "xero_default_account_id",
  "qb_time_class_id",
  "qbd_class_id",
  "booking_portal_booked_service_id",
  "assignment_count",
  "in_progress_status_log",
  "on_the_way_status_log",
  "invoice_status",
  "type",
]);

// Jobs: fields that ARE safe to pass through (allowlisted within the denylist model).
// Only primitives that are clearly operational and non-PII.
const JOBS_SAFE = new Set<string>([
  "tags",           // array of tag strings — operational, non-PII
  "is_multiday_job", // boolean — operational
  "tags_string",    // string concat of tags
]);

const ASSETS_PROMOTED = new Set<string>([
  "id", "customer_id", "title", "asset_type", "tag", "location_description",
  "install_date", "maintenance_agreement_id", "status",
  "created_at", "updated_at", "deleted_at",
]);

// ── Customers: STRICT ALLOWLIST ────────────────────────────────────────────────
// ONLY these keys survive. This is the highest-stakes safety control: PII
// (names/emails/phones/addresses) must NEVER enter plaintext jsonb.
//
// Verification: tests in spillover.test.ts feed a full raw customer and assert
// that no PII keys (first_name, last_name, email, phone, address_*,
// billing_address_*, display_name, company_name, phone_e164, mobile_phone,
// alt_phone, lead_source) appear in the output.
const CUSTOMERS_ALLOWLIST = new Set<string>([
  "status",
  "booking_portal_consent",
  "is_phone_notification_subscribed",
  "is_email_notification_subscribed",
  "pipeline_status_updated_at",
  // account_type is pre-promotion parity — safe (not PII, maps to customerType).
  "account_type",
]);

// ── Value stringifier ──────────────────────────────────────────────────────────

/**
 * Conservative coercion: numbers, booleans, and strings only.
 * Arrays with primitive elements are joined as comma-separated strings.
 * Objects and null/undefined are rejected (return undefined).
 */
function safeStringify(v: unknown): string | number | boolean | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "boolean") return v;
  // Arrays of primitives — join as comma-separated string.
  if (Array.isArray(v)) {
    const parts: string[] = [];
    for (const item of v) {
      if (typeof item === "string" && item.trim()) parts.push(item.trim());
      else if (typeof item === "number" && Number.isFinite(item)) parts.push(String(item));
    }
    return parts.length > 0 ? parts.join(", ") : undefined;
  }
  // Objects are never passed through (default DENY).
  return undefined;
}

/** Returns true when a stringified value is "empty" (skip it). */
function isEmpty(v: string | number | boolean | undefined): boolean {
  if (v === undefined) return true;
  if (typeof v === "string" && v.trim() === "") return true;
  return false;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Build the spillover jsonb for a FieldPulse raw payload.
 *
 * @param raw   - The raw untrusted FP API object (Record<string, unknown>).
 * @param policy - Which entity this is (determines denylist vs allowlist mode).
 * @returns A jsonb-safe Record<string, primitive> or null when empty.
 */
export function buildFpSpillover(raw: unknown, policy: SpilloverPolicy): FpSpillover {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;

  const out: Record<string, string | number | boolean> = {};

  if (policy === "customers") {
    // STRICT ALLOWLIST: only keys in CUSTOMERS_ALLOWLIST survive.
    for (const key of CUSTOMERS_ALLOWLIST) {
      if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
      const v = safeStringify(obj[key]);
      if (!isEmpty(v)) {
        out[key] = v as string | number | boolean;
      }
    }
  } else {
    // DENYLIST mode: exclude global noise + entity-promoted + entity-specific denies.
    let promotedSet: Set<string>;
    switch (policy) {
      case "items":
        promotedSet = ITEMS_PROMOTED;
        break;
      case "estimates":
        promotedSet = ESTIMATES_PROMOTED;
        break;
      case "invoices":
        promotedSet = INVOICES_PROMOTED;
        break;
      case "jobs":
        promotedSet = JOBS_PROMOTED;
        break;
      case "assets":
        promotedSet = ASSETS_PROMOTED;
        break;
    }

    for (const [key, val] of Object.entries(obj)) {
      // Global noise denylist first.
      if (isGloballyDenied(key)) continue;
      // Entity-specific promoted/denied fields.
      if (promotedSet.has(key)) continue;
      // Jobs: extra allowlist check — only JOBS_SAFE fields pass through.
      if (policy === "jobs" && !JOBS_SAFE.has(key)) continue;

      const v = safeStringify(val);
      if (!isEmpty(v)) {
        out[key] = v as string | number | boolean;
      }
    }
  }

  return Object.keys(out).length > 0 ? out : null;
}
