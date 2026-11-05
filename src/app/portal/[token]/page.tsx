import {
  resolvePortalToken,
  getPortalData,
  type PortalData,
} from "@/lib/portal/portal-queries";
import { formatCentsExact } from "@/lib/admin/money-format";
import { BUSINESS_BASE_LOCATION } from "@/lib/config/business-location";
import { cardPaymentsEnabled } from "@/lib/payments/card-enabled";
import { getOrgConfig } from "@/lib/admin/org-config-queries";
import {
  portalPaymentNotice,
  telHref,
  type PortalPaymentNotice,
} from "@/lib/portal/portal-notice";
import { logger } from "@/lib/logger";
import type { PortalEstimateAmount } from "@/lib/portal/portal-estimate";
import { BusinessIdentity } from "@/components/public/business-identity";
import { PayButton } from "./pay-button";

// Arrival windows are stored anchored to the BUSINESS timezone; render them in it
// (not the server's UTC), or an 8 AM ET window (12:00Z) shows as "12:00 PM".
const TZ = BUSINESS_BASE_LOCATION.timezone;

// PUBLIC page — authorized BY THE TOKEN in the URL, NOT an admin session.
// proxy.ts does not gate /portal/*. Org + customer are resolved from the token
// server-side; no cost/margin data is ever loaded into this payload.

function formatDate(d: Date): string {
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: TZ,
  });
}

function formatWindow(start: Date | null, end: Date | null): string | null {
  if (!start) return null;
  const day = start.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: TZ,
  });
  const t = (d: Date) =>
    d.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: TZ,
    });
  if (end) return `${day}, ${t(start)} – ${t(end)}`;
  return `${day}, ${t(start)}`;
}

/** Sentence-case a stored enum ("no_cooling" → "No cooling") for customers. */
function humanize(value: string): string {
  const text = value.replace(/_/g, " ").trim();
  return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
}

function formatEstimateAmount(amount: PortalEstimateAmount): string {
  return amount.kind === "single"
    ? formatCentsExact(amount.cents)
    : `${formatCentsExact(amount.minCents)} – ${formatCentsExact(amount.maxCents)}`;
}

function MessageState({
  title,
  body,
}: {
  readonly title: string;
  readonly body: string;
}) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas p-6">
      <div className="w-full max-w-lg rounded-lg border border-border-strong bg-surface p-8 text-center">
        <h1 className="text-xl font-semibold text-foreground">{title}</h1>
        <p className="mt-2 text-[15px] text-muted-foreground">{body}</p>
      </div>
    </main>
  );
}

function Section({
  title,
  children,
}: {
  readonly title: string;
  readonly children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border-strong bg-surface p-5 sm:p-6">
      <h2 className="mb-4 text-[17px] font-semibold text-foreground">{title}</h2>
      {children}
    </section>
  );
}

function InvoiceStateBadge({ state }: { readonly state: string }) {
  const NEUTRAL =
    "border-border bg-surface-raised text-muted-foreground";
  const colors: Record<string, string> = {
    paid: "border-success-border bg-success-light text-success-strong",
    open: "border-warning-border bg-warning-light text-warning-strong",
    draft: NEUTRAL,
    void: NEUTRAL,
    refunded: NEUTRAL,
  };
  return (
    <span
      className={`inline-flex items-center rounded-[3px] border px-2 py-0.5 text-[12px] font-semibold ${
        colors[state] ?? NEUTRAL
      }`}
    >
      {humanize(state)}
    </span>
  );
}

/** The org's name and configured business phone (the same source message
 * templates use), or nulls. */
async function getOrgBrand(
  organizationId: string,
): Promise<{ companyName: string | null; phone: string | null }> {
  try {
    const config = await getOrgConfig(organizationId);
    return {
      companyName: config.companyName?.trim() || null,
      phone: config.businessInfo?.phone?.trim() || null,
    };
  } catch (error: unknown) {
    logger.warn({ error }, "Portal org brand lookup failed");
    return { companyName: null, phone: null };
  }
}

function InPersonNotice({
  payment,
  phone,
}: {
  readonly payment: PortalPaymentNotice;
  readonly phone: string | null;
}) {
  if (!payment.notice) return null;
  if (!payment.tel || !phone) {
    return (
      <p className="mt-1 text-[13px] text-muted-foreground">{payment.notice}</p>
    );
  }
  // payment.notice ends "…, or call <phone>." — render that phone as a tap-to-call link.
  const at = payment.notice.lastIndexOf(phone);
  if (at < 0) {
    return (
      <p className="mt-1 text-[13px] text-muted-foreground">{payment.notice}</p>
    );
  }
  return (
    <p className="mt-1 text-[13px] text-muted-foreground">
      {payment.notice.slice(0, at)}
      <a
        href={payment.tel}
        className="font-medium whitespace-nowrap text-link underline underline-offset-2"
      >
        {phone}
      </a>
      {payment.notice.slice(at + phone.length)}
    </p>
  );
}

function InvoicesSection({
  token,
  invoices,
  payment,
  phone,
}: {
  readonly token: string;
  readonly invoices: PortalData["invoices"];
  readonly payment: PortalPaymentNotice;
  readonly phone: string | null;
}) {
  return (
    <Section title="Invoices">
      {invoices.length === 0 ? (
        <p className="text-[15px] text-muted-foreground">No invoices yet.</p>
      ) : (
        <ul className="divide-y divide-border">
          {invoices.map((inv) => {
            const payable = inv.state === "open" && inv.balanceCents > 0;
            return (
              <li
                key={inv.id}
                className="flex min-h-11 flex-wrap items-center justify-between gap-3 py-3"
              >
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[17px] font-medium tabular-nums text-foreground">
                      {formatCentsExact(inv.totalCents)}
                    </span>
                    <InvoiceStateBadge state={inv.state} />
                  </div>
                  <p className="mt-0.5 font-mono text-[13px] tabular-nums text-muted-foreground">
                    Issued {formatDate(inv.createdAt)}
                    {inv.amountPaidCents > 0 &&
                      ` · ${formatCentsExact(inv.amountPaidCents)} paid`}
                    {payable &&
                      ` · ${formatCentsExact(inv.balanceCents)} due`}
                  </p>
                  {payable && <InPersonNotice payment={payment} phone={phone} />}
                </div>
                {payable && payment.showPayButton && (
                  <PayButton
                    token={token}
                    invoiceId={inv.id}
                    balanceCents={inv.balanceCents}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

function EstimatesSection({
  estimates,
}: {
  readonly estimates: PortalData["estimates"];
}) {
  return (
    <Section title="Estimates">
      {estimates.length === 0 ? (
        <p className="text-[15px] text-muted-foreground">No estimates yet.</p>
      ) : (
        <ul className="divide-y divide-border">
          {estimates.map((est) => (
            <li
              key={est.id}
              className="flex min-h-11 flex-wrap items-center justify-between gap-3 py-3"
            >
              <div>
                <span className="font-mono text-[17px] font-medium tabular-nums text-foreground">
                  {formatEstimateAmount(est.display.amount)}
                </span>
                <p className="mt-0.5 text-[13px] text-muted-foreground">
                  {est.display.statusLabel}
                  {est.display.optionName ? ` · ${est.display.optionName}` : ""}
                  {est.display.optionCount
                    ? ` · ${est.display.optionCount} options`
                    : ""}
                  {est.expiresAt && est.status === "open"
                    ? ` · expires ${formatDate(est.expiresAt)}`
                    : ""}
                </p>
                {est.awaitingApproval && (
                  <p className="mt-0.5 text-[13px] text-muted-foreground">
                    To approve, open the estimate link we sent you.
                  </p>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function JobsSection({ jobs }: { readonly jobs: PortalData["jobs"] }) {
  return (
    <Section title="Upcoming service">
      {jobs.length === 0 ? (
        <p className="text-[15px] text-muted-foreground">
          No upcoming visits scheduled.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {jobs.map((job) => {
            const window = formatWindow(
              job.arrivalWindowStart,
              job.arrivalWindowEnd,
            );
            return (
              <li key={job.id} className="py-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[15px] font-medium text-foreground">
                    {humanize(job.issueType)}
                  </span>
                  <span className="rounded-[3px] border border-border bg-surface-raised px-2 py-0.5 text-[12px] font-semibold text-muted-foreground">
                    {humanize(job.status)}
                  </span>
                </div>
                <p className="mt-1 font-mono text-[13px] tabular-nums text-muted-foreground">
                  {window ??
                    (job.scheduledDate
                      ? formatDate(job.scheduledDate)
                      : "Scheduling in progress")}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

function HistorySection({
  history,
}: {
  readonly history: PortalData["history"];
}) {
  return (
    <Section title="Service history">
      {history.length === 0 ? (
        <p className="text-[15px] text-muted-foreground">
          No past service on record.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {history.map((h) => (
            <li key={h.id} className="py-3">
              <p className="text-[15px] text-foreground">
                {h.workPerformed ? humanize(h.workPerformed) : "Service visit"}
              </p>
              <p className="mt-1 font-mono text-[13px] tabular-nums text-muted-foreground">
                {formatDate(h.createdAt)}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

export default async function CustomerPortalPage({
  params,
}: {
  readonly params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const identity = await resolvePortalToken(token);

  if (!identity) {
    return (
      <MessageState
        title="This link isn't valid"
        body="It may be incorrect or no longer active. Please contact us and we'll send you a fresh link."
      />
    );
  }

  const [data, brand] = await Promise.all([
    getPortalData(identity.organizationId, identity.customerId),
    getOrgBrand(identity.organizationId),
  ]);
  const phone = brand.phone;
  const cardEnabled = cardPaymentsEnabled();
  const payment = portalPaymentNotice({ cardEnabled, phone });
  const tel = phone ? telHref(phone) : null;

  return (
    <main className="min-h-screen bg-canvas">
      <div className="mx-auto max-w-2xl space-y-5 p-4 sm:p-6">
        <BusinessIdentity companyName={brand.companyName} phone={phone} />
        <header className="pt-2">
          <h1 className="font-heading text-[26px] leading-[30px] font-semibold tracking-[-0.02em] text-foreground">
            {data.customerName
              ? `Welcome back, ${data.customerName}`
              : "Your account"}
          </h1>
          <p className="mt-1.5 text-[15px] text-muted-foreground">
            {cardEnabled
              ? "View your estimates and invoices, pay a balance, and track upcoming service."
              : "View your estimates and invoices and track upcoming service."}
          </p>
        </header>

        <InvoicesSection
          token={token}
          invoices={data.invoices}
          payment={payment}
          phone={phone}
        />
        <EstimatesSection estimates={data.estimates} />
        <JobsSection jobs={data.jobs} />
        <HistorySection history={data.history} />

        <p className="pb-4 text-center text-[13px] text-muted-foreground">
          {tel && phone ? (
            <>
              Questions? Call us at{" "}
              <a
                href={tel}
                className="font-medium whitespace-nowrap text-link underline underline-offset-2"
              >
                {phone}
              </a>
              .
            </>
          ) : (
            "Questions? Contact us and we'll help."
          )}
        </p>
      </div>
    </main>
  );
}
