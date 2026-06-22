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
    <main className="mx-auto flex min-h-screen max-w-lg items-center justify-center p-6">
      <div className="w-full rounded-xl border border-gray-200 bg-white p-8 text-center shadow-sm">
        <h1 className="text-xl font-semibold text-gray-900">{title}</h1>
        <p className="mt-2 text-sm text-gray-600">{body}</p>
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
    <main className="mx-auto max-w-2xl p-6">
      <div className="rounded-xl border border-gray-200 bg-white p-8 shadow-sm">
        <header className="mb-6">
          <h1 className="text-2xl font-bold tracking-tight text-gray-900">
            Your estimate
          </h1>
          <p className="mt-1 text-sm text-gray-600">
            Review the options below, then choose one and sign to approve.
          </p>
        </header>

        {/* Itemized breakdown per option */}
        <div className="mb-8 space-y-6">
          {estimate.options.map((opt) => (
            <section
              key={opt.id}
              className="rounded-lg border border-gray-200 p-4"
            >
              <div className="mb-3 flex items-baseline justify-between">
                <h2 className="text-base font-semibold text-gray-900">
                  {opt.name}
                </h2>
                <span className="text-lg font-bold text-gray-900">
                  {formatCentsExact(opt.totalCents)}
                </span>
              </div>
              <ul className="space-y-1.5">
                {opt.lineItems.map((li) => (
                  <li
                    key={li.id}
                    className="flex justify-between text-sm text-gray-700"
                  >
                    <span>
                      {li.name}
                      {li.quantity > 1 ? ` × ${li.quantity}` : ''}
                    </span>
                    <span>{formatCentsExact(li.lineTotalCents)}</span>
                  </li>
                ))}
              </ul>
              <div className="mt-3 space-y-1 border-t border-gray-100 pt-3 text-sm">
                <div className="flex justify-between text-gray-600">
                  <span>Subtotal</span>
                  <span>{formatCentsExact(opt.subtotalCents)}</span>
                </div>
                <div className="flex justify-between text-gray-600">
                  <span>Tax</span>
                  <span>{formatCentsExact(opt.taxCents)}</span>
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
