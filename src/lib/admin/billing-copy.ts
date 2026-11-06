/**
 * Owner-facing wording for the billing page: plan features, the plan line and
 * the subscription status. Plan feature ids (src/lib/billing/plans.ts) are
 * code keys and never reach the UI raw.
 */
const FEATURE_LABELS: Record<string, string> = {
  chat: 'AI chat assistant on your website',
  scheduling: 'Online scheduling',
  integrations: 'Connections to your field service and calendar apps',
  voice: 'AI phone answering',
  reporting: 'Reports',
  priority_support: 'Priority support',
};

export function billingFeatureLabel(feature: string): string {
  const known = FEATURE_LABELS[feature];
  if (known) return known;
  const words = feature.replace(/[_.-]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** "Free plan" or "Starter plan · $49.00/month" (never "Free · Free"). */
export function billingPlanLine(
  plan: { readonly label: string; readonly priceCents: number; readonly interval: string },
  formatPrice: (cents: number) => string,
): string {
  const name = `${plan.label} plan`;
  return plan.priceCents > 0 ? `${name} · ${formatPrice(plan.priceCents)}/${plan.interval}` : name;
}

const STATUS_LABELS: Record<string, string> = {
  active: 'Active',
  trialing: 'Trial',
  past_due: 'Payment overdue',
  canceled: 'Cancelled',
  cancelled: 'Cancelled',
  incomplete: 'Payment incomplete',
  incomplete_expired: 'Payment expired',
  unpaid: 'Unpaid',
  paused: 'Paused',
};

export function billingStatusLabel(status: string): string {
  return STATUS_LABELS[status] ?? billingFeatureLabel(status);
}
