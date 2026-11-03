'use client';

import { useEffect, useRef, useState } from 'react';
import { Check } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface CopySignInLinkProps {
  /** Absolute technician sign-in URL (the step's `copyValue`). */
  readonly url: string;
  /** The step's instruction line. */
  readonly instruction: string;
}

const COPIED_MS = 1_500;

/**
 * "Copy sign-in link" action for the `tech_sign_in` step (spec §3). On a
 * successful copy the label reads "Copied" with a 14 px check for 1.5 s; a
 * failed copy shows no confirmation. The bare URL stays selectable below the
 * button so it can be read aloud or copied by hand.
 */
export function CopySignInLink({ url, instruction }: CopySignInLinkProps) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // No false confirmation: the URL below stays selectable.
      return;
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPIED_MS);
  }

  return (
    <div className="flex flex-col gap-2">
      <div>
        <Button type="button" onClick={() => void copy()} className="w-full sm:w-auto">
          {copied && <Check aria-hidden="true" className="size-[14px]" />}
          <span aria-live="polite">{copied ? 'Copied' : 'Copy sign-in link'}</span>
        </Button>
      </div>
      <p className="font-mono text-[12px] break-all text-foreground select-all">{url}</p>
      <p className="text-[13px] text-muted-foreground">{instruction}</p>
    </div>
  );
}
