const STYLES: Record<string, string> = {
  open: 'border-blue-300 bg-blue-100 text-blue-800',
  sold: 'border-green-300 bg-green-100 text-green-800',
  dismissed: 'border-gray-300 bg-gray-100 text-gray-600',
  expired: 'border-amber-300 bg-amber-100 text-amber-800',
};

const LABELS: Record<string, string> = {
  open: 'Open',
  sold: 'Sold',
  dismissed: 'Dismissed',
  expired: 'Expired',
};

export function EstimateStatusBadge({ status }: { readonly status: string }) {
  const className = STYLES[status] ?? 'border-gray-300 bg-gray-100 text-gray-600';
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${className}`}
    >
      {LABELS[status] ?? status}
    </span>
  );
}
