'use client';

import { useEffect, useRef, useState } from 'react';
import { Play } from 'lucide-react';
import { SectionCard } from '@/components/admin/ui/section-card';
import {
  clockLabel,
  minutesLabel,
  spokenDuration,
  TUTORIAL_TOPICS,
  TUTORIAL_VIDEO,
} from '@/lib/admin/tutorial-video';

const LENGTH = TUTORIAL_VIDEO.durationSeconds;
const TITLE = `Watch the ${minutesLabel(LENGTH)} walkthrough`;

function Fallback() {
  return (
    <div role="status" className="space-y-2 rounded-md border border-border bg-surface-sunken p-4 text-[13px] leading-5">
      <p className="font-medium text-foreground">The video couldn&apos;t play here.</p>
      <p className="text-muted-foreground">
        It covers the same ground as the quick tour on this page:
      </p>
      <ul className="list-disc space-y-0.5 pl-5 text-muted-foreground">
        {TUTORIAL_TOPICS.map((topic) => (
          <li key={topic}>{topic}</li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Narrated walkthrough at the top of /admin/setup. The native player loads
 * nothing until it is played (`preload="none"`); the poster overlay is one
 * big play button, after which the browser's own controls take over.
 */
export function TutorialVideo() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [started, setStarted] = useState(false);
  const [failed, setFailed] = useState(false);

  function start(): void {
    const video = videoRef.current;
    if (!video) return;
    setStarted(true);
    // A rejected play() (autoplay policy, decode error) leaves a dead box:
    // show the text fallback instead.
    video.play().catch((err: unknown) => {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setFailed(true);
    });
  }

  // Once the overlay is gone, keyboard users land on the native controls.
  useEffect(() => {
    if (started) videoRef.current?.focus({ preventScroll: true });
  }, [started]);

  return (
    <SectionCard
      title={TITLE}
      meta={clockLabel(LENGTH)}
      description="A narrated look around, shown with a sample company: requests, scheduling, customers, invoices and where to get help."
    >
      {failed ? (
        <Fallback />
      ) : (
        <div className="relative aspect-video w-full overflow-hidden rounded-md border border-border bg-surface-sunken">
          <video
            ref={videoRef}
            controls={started}
            src={TUTORIAL_VIDEO.src}
            preload="none"
            poster={TUTORIAL_VIDEO.poster}
            width={TUTORIAL_VIDEO.width}
            height={TUTORIAL_VIDEO.height}
            playsInline
            onPlay={() => setStarted(true)}
            onError={() => setFailed(true)}
            className="absolute inset-0 size-full object-contain outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
            aria-label="Walkthrough video"
          >
            <track kind="captions" src={TUTORIAL_VIDEO.captions} srcLang="en" label="English" default />
          </video>
          {!started && (
            <button
              type="button"
              onClick={start}
              aria-label={`Play the walkthrough, ${spokenDuration(LENGTH)}`}
              className="group/play absolute inset-0 flex cursor-pointer items-center justify-center bg-gradient-to-t from-black/45 via-black/10 to-transparent outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
            >
              <span
                aria-hidden="true"
                className="flex size-16 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg transition-transform duration-150 ease-[cubic-bezier(.23,1,.32,1)] group-active/play:scale-95 motion-reduce:transition-none [@media(hover:hover)_and_(pointer:fine)]:group-hover/play:scale-105 sm:size-20"
              >
                {/* Nudged right: a centred triangle reads as left-heavy. */}
                <Play className="ml-1 size-7 fill-current sm:size-8" />
              </span>
              <span
                aria-hidden="true"
                className="absolute bottom-3 left-3 rounded-sm bg-black/70 px-2 py-0.5 font-mono text-[12px] leading-5 tabular-nums text-white"
              >
                {clockLabel(LENGTH)} · Captions on
              </span>
            </button>
          )}
        </div>
      )}
    </SectionCard>
  );
}
