'use client';

import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { buildFieldpulseSections } from '@/lib/admin/fieldpulse-details-format';

interface FieldpulseDetailsProps {
  /** The fieldpulse_data jsonb value from the DB row. Null/empty → renders nothing. */
  readonly data: Record<string, unknown> | null | undefined;
  /**
   * Custom fields from fieldpulse_custom_fields. When non-empty, rendered as
   * the first "Custom fields" section inside the same collapsible panel.
   */
  readonly customFields?: readonly { readonly name: string; readonly value: string }[] | null;
}

/**
 * Collapsible "FieldPulse details" section for admin detail surfaces.
 *
 * Renders nothing when both `data` and `customFields` are null/empty.
 * Collapsed header shows "FieldPulse details · N fields" with preview chips
 * of the most informative values (custom fields first, then Money/Dates).
 * Expanded view shows a "Custom fields" section first (when present), then
 * grouped sections (Money, Dates, Flags, IDs, Other) with a min-w-40 label
 * column. If nested objects were truncated, a footer line "+N nested fields
 * not shown" is displayed.
 *
 * Accessibility: toggle is a <button> with aria-expanded; the detail panel
 * unmounts when collapsed (no DOM node, so no aria-hidden needed). Respects
 * prefers-reduced-motion (no animation in that case).
 */
export function FieldpulseDetails({ data, customFields }: FieldpulseDetailsProps) {
  const [open, setOpen] = useState(false);

  const { sections, preview, hiddenCount } = buildFieldpulseSections(data);
  const normalizedCustomFields =
    customFields && customFields.length > 0 ? customFields : null;

  if (sections.length === 0 && hiddenCount === 0 && !normalizedCustomFields) return null;

  const customFieldCount = normalizedCustomFields ? normalizedCustomFields.length : 0;
  const totalFields =
    customFieldCount + sections.reduce((acc, s) => acc + s.entries.length, 0) + hiddenCount;

  // Preview: up to 3 chips — custom fields first, then Money/Dates entries
  const combinedPreview: string[] = [];
  if (normalizedCustomFields) {
    for (const cf of normalizedCustomFields) {
      if (combinedPreview.length >= 3) break;
      combinedPreview.push(`${cf.name}: ${cf.value}`);
    }
  }
  if (combinedPreview.length < 3) {
    for (const chip of preview) {
      if (combinedPreview.length >= 3) break;
      combinedPreview.push(chip);
    }
  }

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
        <span>details · {totalFields} {totalFields === 1 ? 'field' : 'fields'}</span>
        {!open && combinedPreview.length > 0 && (
          <span className="ml-2 flex min-w-0 flex-1 gap-1.5 overflow-hidden">
            {combinedPreview.map((chip) => (
              <span
                key={chip}
                className="truncate rounded bg-violet-100 px-1.5 py-px text-[10px] text-violet-600"
              >
                {chip}
              </span>
            ))}
          </span>
        )}
      </button>

      {open && (
        <div className="border-t border-violet-200 px-3 pb-3 pt-2">
          <div className="flex flex-col gap-3">
            {normalizedCustomFields && (
              <div>
                <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-violet-500">
                  Custom fields
                </p>
                <dl className="flex flex-col gap-1">
                  {normalizedCustomFields.map((cf) => (
                    <div key={cf.name} className="flex gap-2 text-xs">
                      <dt className="min-w-40 shrink-0 text-violet-700">{cf.name}</dt>
                      <dd className="break-words text-foreground">{cf.value}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            )}
            {sections.map((section) => (
              <div key={section.title}>
                <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-violet-500">
                  {section.title}
                </p>
                <dl className="flex flex-col gap-1">
                  {section.entries.map((entry) => (
                    <div key={entry.label} className="flex gap-2 text-xs">
                      <dt className="min-w-40 shrink-0 text-violet-700">{entry.label}</dt>
                      <dd
                        className={
                          section.title === 'IDs'
                            ? 'break-all font-mono text-foreground'
                            : 'break-words text-foreground'
                        }
                      >
                        {entry.value}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            ))}
          </div>
          {hiddenCount > 0 && (
            <p className="mt-2 text-[10px] text-violet-500">
              +{hiddenCount} nested {hiddenCount === 1 ? 'field' : 'fields'} not shown
            </p>
          )}
        </div>
      )}
    </div>
  );
}
