'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, FileText, Paperclip } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  FILE_UPLOAD_FAILED, PHOTO_UPLOAD_FAILED, UPLOAD_CUSTOMER_REMOVED, isImageMime,
} from '@/lib/tech/job-page-state';
import { PHOTO_CANT_PREPARE, QUALITY_STORAGE_KEY, qualityFromStorage, type PhotoQuality } from '@/lib/tech/photo-resize';
import { preparePhoto } from '@/lib/tech/photo-prepare';
import { FILE_TOO_LARGE_COPY, TECH_UPLOAD_LIMIT_BYTES } from '@/lib/tech/upload-limits';

interface PhotoRow {
  readonly id: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly size: number;
  readonly createdAt: string;
  readonly url: string | null;
}

interface Failed {
  readonly blob: Blob;
  readonly name: string;
  readonly kind: 'photo' | 'file';
  readonly customerRemoved: boolean;
}

const QUALITY_LABEL: Record<PhotoQuality, string> = { standard: 'Standard', high: 'High' };

/**
 * Job photos and files (M3d spec §7.7): photos are resized on the phone to the
 * chosen quality (remembered per device), PDFs go up as they are, both at most
 * 4 MB. A failed upload keeps the prepared file for Try again or Discard.
 * `readOnly` (the summary hasn't loaded) shows the gallery only.
 */
export function JobPhotosCard({ jobId, readOnly }: { readonly jobId: string; readonly readOnly: boolean }) {
  const [photos, setPhotos] = useState<PhotoRow[]>([]);
  const [uploading, setUploading] = useState(false);
  const [status, setStatus] = useState<{ readonly text: string; readonly error: boolean } | null>(null);
  const [failed, setFailed] = useState<Failed | null>(null);
  const [quality, setQuality] = useState<PhotoQuality>('standard');
  const [qualityOpen, setQualityOpen] = useState(false);
  const photoRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    try {
      setQuality(qualityFromStorage(window.localStorage.getItem(QUALITY_STORAGE_KEY)));
    } catch {
      /* storage unavailable: standard */
    }
  }, []);

  const pickQuality = (q: PhotoQuality) => {
    setQuality(q);
    setQualityOpen(false);
    try {
      window.localStorage.setItem(QUALITY_STORAGE_KEY, q);
    } catch {
      /* storage unavailable: this session only */
    }
  };

  const loadPhotos = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch(`/api/tech/jobs/${jobId}/photo`);
      const body = await res.json().catch(() => ({ success: false }));
      if (res.ok && body.success) setPhotos(body.data.photos);
    } catch {
      /* non-critical: the gallery stays as it was */
    }
  }, [jobId]);

  useEffect(() => {
    void loadPhotos();
  }, [loadPhotos]);

  const upload = useCallback(async (blob: Blob, name: string, kind: 'photo' | 'file'): Promise<void> => {
    setUploading(true);
    setStatus(null);
    setFailed(null);
    try {
      const form = new FormData();
      form.append('file', blob, name);
      const res = await fetch(`/api/tech/jobs/${jobId}/photo`, { method: 'POST', body: form });
      if (res.ok) {
        setStatus({ text: kind === 'photo' ? 'Photo uploaded.' : 'File uploaded.', error: false });
        await loadPhotos();
        return;
      }
      const code = (await res.json().catch(() => null))?.error?.code;
      setFailed({ blob, name, kind, customerRemoved: code === 'CUSTOMER_REMOVED' });
    } catch {
      setFailed({ blob, name, kind, customerRemoved: false });
    } finally {
      setUploading(false);
    }
  }, [jobId, loadPhotos]);

  const onPhoto = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploading(true);
    const prepared = await preparePhoto(file, quality);
    setUploading(false);
    if (!prepared.ok) {
      setStatus({ text: PHOTO_CANT_PREPARE, error: true });
      return;
    }
    await upload(prepared.blob, prepared.name, 'photo');
  };

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > TECH_UPLOAD_LIMIT_BYTES) {
      setStatus({ text: FILE_TOO_LARGE_COPY, error: true });
      return;
    }
    await upload(file, file.name, 'file');
  };

  const busy = uploading || failed !== null;
  const failedText = failed?.customerRemoved ? UPLOAD_CUSTOMER_REMOVED : failed?.kind === 'file' ? FILE_UPLOAD_FAILED : PHOTO_UPLOAD_FAILED;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-[17px]">Photos</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {!readOnly && (
          <>
            <p className="flex items-center gap-2 text-[15px]">
              Quality: {QUALITY_LABEL[quality]} ·
              <button type="button" className="h-11 px-1 text-link" onClick={() => setQualityOpen((o) => !o)}>Change</button>
            </p>
            {qualityOpen && (
              <fieldset className="space-y-1">
                <legend className="text-[13px] text-muted-foreground">Standard saves data. High keeps more detail.</legend>
                {(['standard', 'high'] as const).map((q) => (
                  <label key={q} className="flex min-h-11 items-center gap-2 text-[15px]">
                    <input type="radio" name="photo-quality" checked={quality === q} onChange={() => pickQuality(q)} />
                    {QUALITY_LABEL[q]}
                  </label>
                ))}
              </fieldset>
            )}
            <input ref={photoRef} type="file" accept="image/*" capture="environment" className="sr-only" tabIndex={-1} aria-hidden="true" disabled={busy} onChange={(e) => void onPhoto(e)} />
            <input ref={fileRef} type="file" accept="application/pdf" className="sr-only" tabIndex={-1} aria-hidden="true" disabled={busy} onChange={(e) => void onFile(e)} />
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" className="h-11 rounded-xl px-4 text-[15px]" disabled={busy} onClick={() => photoRef.current?.click()}>
                <Camera className="size-4" aria-hidden="true" />
                {uploading ? 'Uploading…' : 'Take photo'}
              </Button>
              <Button type="button" variant="outline" className="h-11 rounded-xl px-4 text-[15px]" disabled={busy} onClick={() => fileRef.current?.click()}>
                <Paperclip className="size-4" aria-hidden="true" /> Add file
              </Button>
            </div>
            {failed && (
              <div role="alert" className="space-y-2">
                <p className="text-[13px] text-danger-strong">{failedText}</p>
                <div className="flex gap-2">
                  {!failed.customerRemoved && (
                    <Button type="button" className="h-11 rounded-xl px-4 text-[15px]" disabled={uploading} onClick={() => void upload(failed.blob, failed.name, failed.kind)}>
                      Try again
                    </Button>
                  )}
                  <Button type="button" variant="outline" className="h-11 rounded-xl px-4 text-[15px]" disabled={uploading} onClick={() => setFailed(null)}>
                    Discard
                  </Button>
                </div>
              </div>
            )}
            {status && (
              <p role={status.error ? 'alert' : 'status'} className={`text-[13px] ${status.error ? 'text-danger-strong' : 'text-muted-foreground'}`}>
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
              p.url && isImageMime(p.mimeType) ? (
                <a key={p.id} href={p.url} target="_blank" rel="noreferrer">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={p.url} alt={p.filename} className="aspect-square w-full rounded-md border border-border object-cover" />
                </a>
              ) : p.url ? (
                <a key={p.id} href={p.url} target="_blank" rel="noreferrer" className="flex aspect-square w-full flex-col items-center justify-center gap-1 rounded-md border border-border p-1 text-center text-[11px] text-muted-foreground">
                  <FileText className="size-5" aria-hidden="true" />
                  <span className="line-clamp-2 break-all">{p.filename}</span>
                </a>
              ) : (
                <div key={p.id} className="flex aspect-square w-full items-center justify-center rounded-md border border-border text-[11px] text-muted-foreground">
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
