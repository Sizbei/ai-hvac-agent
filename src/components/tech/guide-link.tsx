'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { BookOpen } from 'lucide-react';
import { GUIDE_COPY } from '@/lib/tech/guide-copy';

/** Header link to the getting-started guide; current-page aware (spec §2). */
export function GuideLink() {
  const current = usePathname() === '/tech/guide';
  return (
    <Link
      href="/tech/guide"
      aria-current={current ? 'page' : undefined}
      className="inline-flex min-h-11 items-center gap-1.5 rounded-md px-2 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground aria-[current=page]:text-foreground"
    >
      <BookOpen className="size-4" aria-hidden="true" />
      {GUIDE_COPY.guideLink}
    </Link>
  );
}
