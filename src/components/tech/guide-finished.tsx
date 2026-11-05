import { Check } from 'lucide-react';
import { GUIDE_COPY } from '@/lib/tech/guide-copy';

/** The finished block (spec §6), shared by the card and the page. */
export function GuideFinished() {
  return (
    <div className="space-y-1.5">
      <p className="text-[17px] font-semibold">{GUIDE_COPY.finishedTitle}</p>
      <ul className="space-y-1">
        {GUIDE_COPY.finishedLines.map((line) => (
          <li key={line} className="flex items-center gap-2 text-[15px]">
            <Check className="size-4 shrink-0 text-success-strong" aria-hidden="true" />
            {line}
          </li>
        ))}
      </ul>
      <p className="text-[13px] text-muted-foreground">{GUIDE_COPY.finishedRest}</p>
    </div>
  );
}
