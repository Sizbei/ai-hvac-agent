'use client';

import { useCallback, useState } from 'react';
import { Wind } from 'lucide-react';
import { cn } from '@/lib/utils';

interface BrandMarkProps {
  /** Org display name; defaults to the Spears wordmark for legacy callers. */
  readonly name?: string;
  /** Hide the wordmark text and show only the logo lozenge (collapsed sidebar). */
  readonly compact?: boolean;
  /** Render the wordmark in light ink for dark/navy surfaces (the sidebar). */
  readonly onDark?: boolean;
  /** The org's own logo (square mark). Replaces the lozenge; falls back to it if unset or it fails to load. */
  readonly logoUrl?: string | null;
  readonly className?: string;
}

/**
 * The Spears Services brand mark used across the admin shell: a cyan logo
 * lozenge plus a two-line wordmark ("Spears Services" / "Service Console").
 * Colors come from the brand tokens so light and dark themes both read well.
 */
export function BrandMark({ name = 'Spears Services', compact = false, onDark = false, logoUrl, className }: BrandMarkProps) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const showLogo = Boolean(logoUrl) && failedUrl !== logoUrl;
  // A server-rendered <img> can fail before React hydrates and attaches
  // onError, which left a broken-image icon in the shell. Check on mount too.
  const checkLoaded = useCallback(
    (img: HTMLImageElement | null) => {
      if (img && img.complete && img.naturalWidth === 0) setFailedUrl(logoUrl ?? null);
    },
    [logoUrl],
  );
  return (
    <div className={cn('flex items-center gap-2.5', className)}>
      {showLogo ? (
        // eslint-disable-next-line @next/next/no-img-element -- org-supplied URL on any host; a 36px mark gains nothing from next/image
        <img
          ref={checkLoaded}
          src={logoUrl as string}
          alt=""
          referrerPolicy="no-referrer"
          width={36}
          height={36}
          onError={() => setFailedUrl(logoUrl ?? null)}
          className="size-9 shrink-0 rounded-xl object-contain"
        />
      ) : (
      <span
        className={cn(
          'flex size-9 shrink-0 items-center justify-center rounded-xl',
          // Brand tokens, NOT --primary: primary is now the navy action color, so
          // painting the lozenge from it would silently turn the logo navy. The
          // Spears cyan lives in --brand-cyan / --brand-navy.
          'bg-gradient-to-br from-brand-cyan to-brand-navy text-primary-foreground',
        )}
      >
        <Wind className="size-5" />
      </span>
      )}
      {!compact && (
        <span className="flex min-w-0 flex-col leading-none">
          <span
            className={cn(
              'font-heading text-[15px] font-bold tracking-tight',
              onDark ? 'text-white' : 'text-foreground',
            )}
          >
            {name}
          </span>
          <span
            className={cn(
              'mt-1 text-[11px] font-medium tracking-tight',
              onDark ? 'text-white/55' : 'text-muted-foreground',
            )}
          >
            Service console
          </span>
        </span>
      )}
    </div>
  );
}
