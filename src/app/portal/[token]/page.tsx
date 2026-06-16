import {
  resolvePortalToken,
  getPortalData,
  type PortalData,
} from "@/lib/portal/portal-queries";
import { formatCentsExact } from "@/lib/admin/money-format";
import { PayButton } from "./pay-button";

// PUBLIC page — authorized BY THE TOKEN in the URL, NOT an admin session.
// proxy.ts does not gate /portal/*. Org + customer are resolved from the token
// server-side; no cost/margin data is ever loaded into this payload.

function formatDate(d: Date): string {
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatWindow(start: Date | null, end: Date | null): string | null {
  if (!start) return null;
  const day = start.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  const t = (d: Date) =>
    d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  if (end) return `${day}, ${t(start)} – ${t(end)}`;
  return `${day}, ${t(start)}`;
}

function humanize(value: string): string {
  return value.replace(/_/g, " ");
}

function MessageState({
  title,
  body,
}: {
  readonly title: string;
  readonly body: string;
}) {
  return (
    <main className="mx-auto flex min-h-screen max-w-lg items-center justify-center p-6">
      <div className="w-full rounded-xl border border-gray-200 bg-white p-8 text-center shadow-sm">
        <h1 className="text-xl font-semibold text-gray-900">{title}</h1>
        <p className="mt-2 text-sm text-gray-600">{body}</p>
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
    <section className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm sm:p-6">
      <h2 className="mb-4 text-base font-semibold text-gray-900">{title}</h2>
      {children}
    </section>
  );
}

function InvoiceStateBadge({ state }: { readonly state: string }) {
  const colors: Record<string, string> = {
    paid: "bg-green-100 text-green-800",
    open: "bg-amber-100 text-amber-800",
    draft: "bg-gray-100 text-gray-700",
    void: "bg-gray-100 text-gray-500",
    refunded: "bg-gray-100 text-gray-700",
  };
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
        colors[state] ?? "bg-gray-100 text-gray-700"
      }`}
    >
      {humanize(state)}
    </span>
  );
}

function InvoicesSection({
  token,
  invoices,
}: {
  readonly token: string;
  readonly invoices: PortalData["invoices"];
}) {
  return (
    <Section title="Invoices">
      {invoices.length === 0 ? (
        <p className="text-sm text-gray-500">No invoices yet.</p>
      ) : (
        <ul className="divide-y divide-gray-100">
          {invoices.map((inv) => {
            const payable = inv.state === "open" && inv.balanceCents > 0;
            return (
              <li
                key={inv.id}
                className="flex flex-wrap items-center justify-between gap-3 py-3"
              >
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-gray-900">
                      {formatCentsExact(inv.totalCents)}
                    </span>
                    <InvoiceStateBadge state={inv.state} />
                  </div>
                  <p className="mt-0.5 text-xs text-gray-500">
                    {formatDate(inv.createdAt)}
                    {inv.amountPaidCents > 0 &&
                      ` · ${formatCentsExact(inv.amountPaidCents)} paid`}
                    {payable &&
                      ` · ${formatCentsExact(inv.balanceCents)} due`}
                  </p>
                </div>
                {payable && (
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
        <p className="text-sm text-gray-500">No estimates yet.</p>
      ) : (
        <ul className="divide-y divide-gray-100">
          {estimates.map((est) => (
            <li
              key={est.id}
              className="flex flex-wrap items-center justify-between gap-3 py-3"
            >
              <div>
                <span className="font-medium text-gray-900">
                  {formatCentsExact(est.totalCents)}
                </span>
                <p className="mt-0.5 text-xs text-gray-500">
                  {est.awaitingApproval
                    ? "Awaiting your approval"
                    : humanize(est.status)}
                  {est.expiresAt && est.status === "open"
                    ? ` · expires ${formatDate(est.expiresAt)}`
                    : ""}
                </p>
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
        <p className="text-sm text-gray-500">No upcoming visits scheduled.</p>
      ) : (
        <ul className="divide-y divide-gray-100">
          {jobs.map((job) => {
            const window = formatWindow(
              job.arrivalWindowStart,
              job.arrivalWindowEnd,
            );
            return (
              <li key={job.id} className="py-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-gray-900">
                    {humanize(job.issueType)}
                  </span>
                  <span className="text-xs font-medium text-gray-600">
                    {humanize(job.status)}
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-gray-500">
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
        <p className="text-sm text-gray-500">No past service on record.</p>
      ) : (
        <ul className="divide-y divide-gray-100">
          {history.map((h) => (
            <li key={h.id} className="py-3">
              <p className="text-sm text-gray-900">
                {h.workPerformed ?? "Service visit"}
              </p>
              <p className="mt-0.5 text-xs text-gray-500">
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

  const data = await getPortalData(
    identity.organizationId,
    identity.customerId,
  );

  return (
    <main className="mx-auto max-w-2xl space-y-5 p-4 sm:p-6">
      <header className="pt-2">
        <h1 className="text-2xl font-bold tracking-tight text-gray-900">
          {data.customerName
            ? `Welcome back, ${data.customerName}`
            : "Your account"}
        </h1>
        <p className="mt-1 text-sm text-gray-600">
          View your estimates and invoices, pay a balance, and track upcoming
          service.
        </p>
      </header>

      <InvoicesSection token={token} invoices={data.invoices} />
      <EstimatesSection estimates={data.estimates} />
      <JobsSection jobs={data.jobs} />
      <HistorySection history={data.history} />

      <p className="pb-4 text-center text-xs text-gray-400">
        Questions? Reply to your confirmation message or give us a call.
      </p>
    </main>
  );
}
