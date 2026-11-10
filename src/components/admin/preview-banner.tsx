'use client';

import { useState } from 'react';
import { Eye, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * "View as" banner (spec P7): on every admin page while a preview is on.
 * Exit POSTs the exit route (the one write the read-only proxy allows), then
 * returns to the platform console.
 */
export function PreviewBanner({ line }: { readonly line: string }) {
  const [exiting, setExiting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function exit() {
    if (exiting) return;
    setExiting(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/preview/exit', { method: 'POST' });
      if (res.ok) {
        location.assign('/admin/platform');
        return;
      }
    } catch {
      // fall through to the error below
    }
    setExiting(false);
    setError('Couldn’t exit the preview. Please try again.');
  }

  return (
    <div
      role="region"
      aria-label="Preview"
      className="flex items-center gap-3 border-b border-info-border bg-info-light px-4 py-2 text-sm text-info-foreground"
    >
      <Eye className="size-4 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="font-medium">{line}</p>
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
      </div>
      <Button size="sm" variant="outline" onClick={() => void exit()} disabled={exiting}>
        {exiting && <Loader2 className="size-3.5 animate-spin" />}
        Exit
      </Button>
    </div>
  );
}
