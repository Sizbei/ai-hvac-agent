'use client';

import { useState } from 'react';
import { previewText, readableDescription } from '@/lib/admin/long-text';

/**
 * A request description as paragraphs (line breaks kept), clamped to a
 * preview with a "Show more" toggle when it is long. Imported FieldPulse
 * job notes can run past 6,000 characters.
 */
export function ExpandableDescription({ text }: { readonly text: string }) {
  const [expanded, setExpanded] = useState(false);
  const full = readableDescription(text);
  if (!full) return null;
  const preview = previewText(full);
  return (
    <div className="mt-1">
      <p className="whitespace-pre-line break-words text-sm text-muted-foreground">
        {expanded ? full : preview.text}
      </p>
      {preview.truncated && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
          className="mt-1.5 rounded-sm text-sm font-medium text-link underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring"
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}
