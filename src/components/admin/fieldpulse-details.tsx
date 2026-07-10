'use client';

import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { buildFieldpulseEntries } from '@/lib/admin/fieldpulse-details-format';

interface FieldpulseDetailsProps {
  /** The fieldpulse_data jsonb value from the DB row. Null/empty → renders nothing. */
  readonly data: Record<string, unknown> | null | undefined;
}

/**
 * Collapsible "FieldPulse details" section for admin detail surfaces.
 *
 * Renders nothing when `data` is null/empty. When data is present, shows a
 * violet-tinted "FieldPulse details" toggle; on expand, a key/value grid of
 * humanized labels and formatted values (booleans→Yes/No, dates→readable,
 * arrays→CSV). Keys are sorted alphabetically.
 *
 * Accessibility: toggle is a <button> with aria-expanded; the detail panel
 * unmounts when collapsed (no DOM node, so no aria-hidden needed). Respects
 * prefers-reduced-motion (no animation in that case).
 */
export function FieldpulseDetails({ data }: FieldpulseDetailsProps) {
  const [open, setOpen] = useState(false);

  const entries = buildFieldpulseEntries(data);
  if (!entries) return null;

  return (
    <div className="rounded-md border border-violet-200 bg-violet-50/40">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium text-violet-800 hover:bg-violet-50/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-md"
      >
        {open ? (
          <ChevronDown className="size-3.5 shrink-0 text-violet-600 motion-reduce:transition-none" aria-hidden="true" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0 text-violet-600 motion-reduce:transition-none" aria-hidden="true" />
        )}
        <span className="rounded border border-violet-300 bg-violet-100 px-1.5 py-px text-[10px] font-medium text-violet-700">
          FieldPulse
        </span>
        <span>Details</span>
        <span className="ml-auto text-xs font-normal text-violet-600">
          {entries.length} {entries.length === 1 ? 'field' : 'fields'}
        </span>
      </button>

      {open && (
        <div className="border-t border-violet-200 px-3 pb-3 pt-2">
          <dl className="grid gap-x-4 gap-y-1.5 text-xs sm:grid-cols-2">
            {entries.map((entry) => (
              <div key={entry.label} className="flex gap-1.5">
                <dt className="shrink-0 text-violet-700">{entry.label}:</dt>
                <dd className="text-foreground break-words">{entry.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </div>
  );
}
