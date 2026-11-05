'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Camera } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PHOTO_UPLOAD_FAILED } from '@/lib/tech/job-page-state';

interface PhotoRow {
  readonly id: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly size: number;
  readonly createdAt: string;
  readonly url: string | null;
}

/**
 * Job photos: a Take photo button that opens the camera (a hidden file input),
 * then the gallery. `readOnly` (a completed or cancelled job) shows the
 * gallery only.
 */
export function JobPhotosCard({ jobId, readOnly }: { readonly jobId: string; readonly readOnly: boolean }) {
  const [photos, setPhotos] = useState<PhotoRow[]>([]);
  const [uploading, setUploading] = useState(false);
  const [status, setStatus] = useState<{ readonly text: string; readonly error: boolean } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const loadPhotos = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch(`/api/tech/jobs/${jobId}/photo`);
      const body = await res.json().catch(() => ({ success: false }));
      if (res.ok && body.success) setPhotos(body.data.photos);
      // Non-critical: a failed list just leaves the gallery empty.
    } catch {
      /* non-critical */
    }
  }, [jobId]);

  useEffect(() => {
    void loadPhotos();
  }, [loadPhotos]);

  const handleChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
      const file = e.target.files?.[0];
      e.target.value = ''; // allow re-selecting the same file
      if (!file) return;
      setUploading(true);
      setStatus(null);
      try {
        const form = new FormData();
        form.append('file', file);
        const res = await fetch(`/api/tech/jobs/${jobId}/photo`, { method: 'POST', body: form });
        if (res.ok) {
          setStatus({ text: 'Photo uploaded.', error: false });
          await loadPhotos();
        } else {
          setStatus({ text: PHOTO_UPLOAD_FAILED, error: true });
        }
      } catch {
        setStatus({ text: PHOTO_UPLOAD_FAILED, error: true });
      } finally {
        setUploading(false);
      }
    },
    [jobId, loadPhotos],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-[17px]">Photos</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {!readOnly && (
          <>
            <input
              ref={inputRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="sr-only"
              tabIndex={-1}
              aria-hidden="true"
              disabled={uploading}
              onChange={(e) => void handleChange(e)}
            />
            <Button
              type="button"
              variant="outline"
              className="h-11 rounded-xl px-4 text-[15px]"
              disabled={uploading}
              onClick={() => inputRef.current?.click()}
            >
              <Camera className="size-4" aria-hidden="true" />
              {uploading ? 'Uploading…' : 'Take photo'}
            </Button>
            {status && (
              <p
                role={status.error ? 'alert' : 'status'}
                className={`text-[13px] ${status.error ? 'text-danger-strong' : 'text-muted-foreground'}`}
              >
                {status.text}
              </p>
            )}
          </>
        )}
        {photos.length === 0 ? (
          <p className="text-[15px] text-muted-foreground">No photos yet.</p>
        ) : (
          <div className="grid grid-cols-3 gap-2">
            {photos.map((p) =>
              p.url ? (
                <a key={p.id} href={p.url} target="_blank" rel="noreferrer">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={p.url}
                    alt={p.filename}
                    className="aspect-square w-full rounded-md border border-border object-cover"
                  />
                </a>
              ) : (
                <div
                  key={p.id}
                  className="flex aspect-square w-full items-center justify-center rounded-md border border-border text-[11px] text-muted-foreground"
                >
                  {p.filename}
                </div>
              ),
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
