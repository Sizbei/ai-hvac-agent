import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * Shared fixture for the hidden-history visibility suites
 * (tests/integration/visibility-*.test.ts). One throwaway org on the DEV
 * database with two identical row sets: `visible`, and `hidden`, which is
 * marked `hidden_from_org = true` by UPDATE after every insert, as the go-live
 * marking script does (so no un-hide trigger fires on it). Refuses prod.
 *
 * Callers must `vi.mock("server-only", () => ({}))` and call `cleanup()` in
 * afterAll; it deletes the org (cascade).
 */

export interface Ids {
  readonly customer: string;
  /** status `submitted`. */
  readonly session: string;
  /** Scheduled tomorrow; the visit-sync trigger creates `appointment`. */
  readonly request: string;
  readonly appointment: string;
  /** state `open`. */
  readonly invoice: string;
  /** status `open`. */
  readonly estimate: string;
  readonly payment: string;
  readonly message: string;
  readonly reviewRequest: string;
  readonly equipment: string;
}

export interface VisibilityOrg {
  readonly org: string;
  readonly visible: Ids;
  readonly hidden: Ids;
  cleanup(): Promise<void>;
}

const PROD_HOST = "ep-withered-hill";

function loadEnv(): void {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
  }
  const url = process.env.DATABASE_URL ?? "";
  if (!url) throw new Error("DATABASE_URL missing from .env.local");
  if (url.includes(PROD_HOST)) throw new Error("Refusing to run against the production database");
}

export async function seedVisibilityOrg(): Promise<VisibilityOrg> {
  loadEnv();
  const { sql } = await import("drizzle-orm");
  const { db } = await import("@/lib/db");
  const { encrypt } = await import("@/lib/crypto");
  const { createOrgCore } = await import("@/lib/admin/provisioning");

  const out = await createOrgCore({
    name: `Probe Org Visibility ${randomUUID().slice(0, 8)}`,
    createdBy: null,
    ownerEmail: null,
    ownerUser: {
      email: `owner-${randomUUID()}@throwaway.example`,
      name: "Probe Owner",
      googleId: `probe-${randomUUID()}`,
    },
    skipOrgCountCheck: true,
  });
  if (!out.ok) throw new Error(`createOrgCore failed: ${JSON.stringify(out.error)}`);
  const org = out.result.organizationId as string;

  const cleanup = async () => {
    try {
      await db.execute(sql`DELETE FROM organizations WHERE id = ${org}`);
    } catch (error) {
      console.error(`cleanup: could not delete probe org ${org}`, error);
    }
  };

  const id = async (statement: ReturnType<typeof sql>): Promise<string> => {
    const res = await db.execute(statement);
    return (res.rows[0] as { id: string }).id;
  };

  const seed = async (label: string): Promise<Ids> => {
    const customer = await id(sql`INSERT INTO customers (organization_id,name_encrypted)
      VALUES (${org},${encrypt(`Pat ${label}`)}) RETURNING id`);
    const session = await id(sql`INSERT INTO customer_sessions (organization_id,token,customer_id,status)
      VALUES (${org},gen_random_uuid()::text,${customer},'submitted'::session_status) RETURNING id`);
    const message = await id(sql`INSERT INTO messages (organization_id,session_id,role,content)
      VALUES (${org},${session},'user'::message_role,${`Probe ${label} message`}) RETURNING id`);
    const request = await id(sql`INSERT INTO service_requests
        (organization_id,session_id,customer_id,issue_type,urgency,description,reference_number,
         scheduled_date,arrival_window_start,arrival_window_end)
      VALUES (${org},${session},${customer},'no_heat','medium',${`Probe ${label} request`},
        'PRB-'||substr(md5(random()::text),1,8),
        now()+interval '1 day',now()+interval '1 day',now()+interval '1 day 2 hours') RETURNING id`);
    const appointment = await id(sql`SELECT id FROM appointments
      WHERE service_request_id = ${request} AND appointment_number = 1`);
    const invoice = await id(sql`INSERT INTO invoices (organization_id,service_request_id,customer_id,state,subtotal_cents,total_cents,amount_paid_cents)
      VALUES (${org},${request},${customer},'open'::invoice_state,10000,10000,2500) RETURNING id`);
    const estimate = await id(sql`INSERT INTO estimates (organization_id,service_request_id,customer_id,status,total_cents)
      VALUES (${org},${request},${customer},'open'::estimate_status,25000) RETURNING id`);
    const payment = await id(sql`INSERT INTO payments (organization_id,invoice_id,provider,amount_cents,status,method)
      VALUES (${org},${invoice},'manual',2500,'succeeded'::payment_status,'cash') RETURNING id`);
    const reviewRequest = await id(sql`INSERT INTO review_requests (organization_id,service_request_id,customer_id,review_token_hash)
      VALUES (${org},${request},${customer},md5(random()::text)||md5(random()::text)) RETURNING id`);
    const equipment = await id(sql`INSERT INTO customer_equipment (organization_id,customer_id,equipment_type,make)
      VALUES (${org},${customer},'furnace'::equipment_type,'Probe') RETURNING id`);
    return { customer, session, request, appointment, invoice, estimate, payment, message, reviewRequest, equipment };
  };

  try {
    const visible = await seed("Visible");
    const hidden = await seed("Hidden");
    const hide = (table: string, rowId: string) =>
      db.execute(
        sql`UPDATE ${sql.identifier(table)} SET hidden_from_org = true WHERE id = ${rowId} AND organization_id = ${org}`,
      );
    await db.batch([
      hide("customers", hidden.customer),
      hide("customer_sessions", hidden.session),
      hide("service_requests", hidden.request),
      hide("invoices", hidden.invoice),
      hide("estimates", hidden.estimate),
    ]);
    return { org, visible, hidden, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
