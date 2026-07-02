'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { MapPin } from 'lucide-react';

// Coalesce posts: the browser fires watchPosition often, but dispatch only needs
// a fix roughly every minute. The server's per-instance rate limit is a backstop;
// this is the real limiter.
const POST_INTERVAL_MS = 60_000;

/**
 * Consent toggle + live-location tracker for the technician PWA. When the tech
 * turns it ON we persist consent, prompt the OS permission, and stream throttled
 * GeolocationPosition fixes to /api/tech/location (which re-checks consent per
 * fix). Turning it OFF clears the watch and stops ingestion. Best-effort: a
 * denied permission or offline post never throws — it just surfaces a hint.
 */
export function TechLocationTracker() {
  const [enabled, setEnabled] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const watchIdRef = useRef<number | null>(null);
  const lastPostRef = useRef(0);

  // Load the tech's saved consent on mount.
  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/tech/location/consent');
        const body = await res.json().catch(() => null);
        if (res.ok && body?.success) setEnabled(body.data.enabled === true);
      } catch {
        /* non-critical */
      }
    })();
  }, []);

  const postFix = useCallback(async (pos: GeolocationPosition): Promise<void> => {
    const now = Date.now();
    if (now - lastPostRef.current < POST_INTERVAL_MS) return;
    lastPostRef.current = now;
    try {
      await fetch('/api/tech/location', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracyM: pos.coords.accuracy ?? null,
          heading: Number.isFinite(pos.coords.heading) ? pos.coords.heading : null,
          capturedAt: new Date(pos.timestamp).toISOString(),
        }),
      });
    } catch {
      /* best-effort; the next fix will retry */
    }
  }, []);

  // Start / stop the geolocation watch as consent flips.
  useEffect(() => {
    if (!enabled) return;
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setStatus('Location is not available on this device.');
      return;
    }
    lastPostRef.current = 0; // send the first fix immediately
    const id = navigator.geolocation.watchPosition(
      (pos) => {
        setStatus(null);
        void postFix(pos);
      },
      (err) => {
        setStatus(
          err.code === err.PERMISSION_DENIED
            ? 'Sharing is on, but your phone is blocking location. Enable it in browser settings.'
            : 'Could not get your location right now.',
        );
      },
      { enableHighAccuracy: true, maximumAge: 30_000, timeout: 20_000 },
    );
    watchIdRef.current = id;
    return () => {
      navigator.geolocation.clearWatch(id);
      watchIdRef.current = null;
    };
  }, [enabled, postFix]);

  const toggle = useCallback(async (): Promise<void> => {
    const next = !enabled;
    setBusy(true);
    try {
      const res = await fetch('/api/tech/location/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      });
      if (res.ok) {
        setEnabled(next);
        setStatus(next ? null : 'Location sharing turned off.');
        // Surface the OS permission prompt right away on enable.
        if (next && typeof navigator !== 'undefined' && navigator.geolocation) {
          navigator.geolocation.getCurrentPosition(
            () => {},
            () => {},
          );
        }
      } else {
        setStatus("Couldn't update location sharing.");
      }
    } catch {
      setStatus('Could not connect to server.');
    } finally {
      setBusy(false);
    }
  }, [enabled]);

  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
      <div className="flex items-center gap-2">
        <MapPin
          className={`size-4 ${enabled ? 'text-emerald-600' : 'text-muted-foreground'}`}
        />
        <div>
          <p className="text-sm font-medium">Share my location</p>
          <p className="text-xs text-muted-foreground">
            {status ??
              (enabled
                ? 'On while you work — helps dispatch route jobs.'
                : 'Off')}
          </p>
        </div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label="Share my location while working"
        disabled={busy}
        onClick={() => void toggle()}
        className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
          enabled ? 'bg-emerald-600' : 'bg-muted'
        } ${busy ? 'opacity-50' : ''}`}
      >
        <span
          className={`absolute top-0.5 size-5 rounded-full bg-white shadow transition-transform ${
            enabled ? 'translate-x-5' : 'translate-x-0.5'
          }`}
        />
      </button>
    </div>
  );
}
