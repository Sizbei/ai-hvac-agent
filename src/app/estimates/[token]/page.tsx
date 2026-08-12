import { getEstimateForApproval } from '@/lib/admin/estimate-queries';
import { formatCentsExact } from '@/lib/admin/money-format';
import { ApproveForm, type ApproveOption } from './approve-form';

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

export default async function EstimateApprovalPage({
  params,
}: {
  readonly params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const estimate = await getEstimateForApproval(token);

  if (!estimate) {
    return (
      <MessageState
        title="Estimate not found"
        body="This link may be incorrect or is no longer available. Please contact us if you need a new copy."
      />
    );
  }

  if (estimate.status !== 'open') {
    return (
      <MessageState
        title="This estimate has already been decided"
        body="Thank you — there's nothing more to do here. Please contact us with any questions."
      />
    );
  }

  // This is an async Server Component: it renders once per request on the
  // server, so Date.now() is a correct, deterministic-per-request expiry check
  // (the React Compiler's purity rule targets client re-renders, N/A here).
  // eslint-disable-next-line react-hooks/purity
  if (estimate.expiresAt && estimate.expiresAt.getTime() < Date.now()) {
    return (
      <MessageState
        title="This estimate has expired"
        body="Please contact us and we'll be happy to send you an updated quote."
      />
    );
  }

  const options: ApproveOption[] = estimate.options.map((o) => ({
    id: o.id,
    name: o.name,
    totalCents: o.totalCents,
  }));

  return (
    <main className="min-h-screen bg-canvas p-4 sm:p-6">
      <div className="mx-auto max-w-2xl rounded-lg border border-border-strong bg-surface p-6 sm:p-8">
        <header className="mb-6">
          <h1 className="font-heading text-[26px] leading-[30px] font-semibold tracking-[-0.02em] text-foreground">
            Your estimate
          </h1>
          <p className="mt-1.5 text-[15px] text-muted-foreground">
            Review the options below, then choose one and sign to approve.
          </p>
        </header>

        {/* Itemized breakdown per option */}
        <div className="mb-8 space-y-6">
          {estimate.options.map((opt) => (
            <section
              key={opt.id}
              className="rounded-lg border border-border-strong p-4"
            >
              <div className="mb-3 flex items-baseline justify-between gap-3">
                <h2 className="text-[17px] font-semibold text-foreground">
                  {opt.name}
                </h2>
                <span className="font-mono text-[20px] font-medium tabular-nums text-foreground">
                  {formatCentsExact(opt.totalCents)}
                </span>
              </div>
              <ul className="space-y-1.5">
                {opt.lineItems.map((li) => (
                  <li
                    key={li.id}
                    className="flex justify-between gap-3 text-[15px] text-foreground"
                  >
                    <span>
                      {li.name}
                      {li.quantity > 1 ? ` × ${li.quantity}` : ''}
                    </span>
                    <span className="font-mono tabular-nums">
                      {formatCentsExact(li.lineTotalCents)}
                    </span>
                  </li>
                ))}
              </ul>
              <div className="mt-3 space-y-1 border-t border-border pt-3 text-[15px]">
                <div className="flex justify-between gap-3 text-muted-foreground">
                  <span>Subtotal</span>
                  <span className="font-mono tabular-nums">
                    {formatCentsExact(opt.subtotalCents)}
                  </span>
                </div>
                <div className="flex justify-between gap-3 text-muted-foreground">
                  <span>Tax</span>
                  <span className="font-mono tabular-nums">
                    {formatCentsExact(opt.taxCents)}
                  </span>
                </div>
              </div>
            </section>
          ))}
        </div>

        <ApproveForm token={token} options={options} />
      </div>
    </main>
  );
}
