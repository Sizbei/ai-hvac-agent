const STYLES: Record<string, string> = {
  draft: 'border-gray-300 bg-gray-100 text-gray-600',
  open: 'border-blue-300 bg-blue-100 text-blue-800',
  paid: 'border-green-300 bg-green-100 text-green-800',
  void: 'border-gray-300 bg-gray-100 text-gray-600',
  refunded: 'border-amber-300 bg-amber-100 text-amber-800',
};

const LABELS: Record<string, string> = {
  draft: 'Draft',
  open: 'Open',
  paid: 'Paid',
  void: 'Void',
  refunded: 'Refunded',
};

export function InvoiceStateBadge({ state }: { readonly state: string }) {
  const className = STYLES[state] ?? 'border-gray-300 bg-gray-100 text-gray-600';
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${className}`}
    >
      {LABELS[state] ?? state}
    </span>
  );
}
