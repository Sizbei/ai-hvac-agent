'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Paperclip, FileText, Image as ImageIcon, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * The entity an attachments section is scoped to. Exactly one prop should be set;
 * it both filters the list and links new uploads.
 */
interface AttachmentsSectionProps {
  readonly serviceRequestId?: string;
  readonly equipmentId?: string;
  readonly customerId?: string;
}

interface AttachmentRow {
  readonly id: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly size: number;
  readonly createdAt: string;
}

function scopeParams(props: AttachmentsSectionProps): URLSearchParams {
  const params = new URLSearchParams();
  if (props.serviceRequestId)
    params.set('serviceRequestId', props.serviceRequestId);
  else if (props.equipmentId) params.set('equipmentId', props.equipmentId);
  else if (props.customerId) params.set('customerId', props.customerId);
  return params;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Minimal admin attachments panel: lists linked files and lets an admin upload
 * a new one. Files are never served via a raw bucket URL — opening one fetches
 * a short-lived signed URL from the download route.
 */
export function AttachmentsSection(props: AttachmentsSectionProps) {
  const [rows, setRows] = useState<AttachmentRow[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchRows = useCallback(async (): Promise<void> => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/admin/attachments?${scopeParams(props).toString()}`,
      );
      const body = await res.json().catch(() => ({ success: false }));
      if (!res.ok || !body.success) {
        setError('Could not load attachments.');
        return;
      }
      setRows(body.data.attachments as AttachmentRow[]);
    } catch {
      setError('Could not load attachments.');
    } finally {
      setIsLoading(false);
    }
    // props are primitive ids — spread so the effect re-runs when scope changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.serviceRequestId, props.equipmentId, props.customerId]);

  useEffect(() => {
    void fetchRows();
  }, [fetchRows]);

  const handleUpload = useCallback(
    async (file: File): Promise<void> => {
      setIsUploading(true);
      setError(null);
      try {
        const form = new FormData();
        form.append('file', file);
        if (props.serviceRequestId)
          form.append('serviceRequestId', props.serviceRequestId);
        else if (props.equipmentId)
          form.append('equipmentId', props.equipmentId);
        else if (props.customerId) form.append('customerId', props.customerId);

        const res = await fetch('/api/admin/attachments', {
          method: 'POST',
          body: form,
        });
        const body = await res.json().catch(() => ({ success: false }));
        if (!res.ok || !body.success) {
          setError(body?.error?.message ?? 'Upload failed.');
          return;
        }
        await fetchRows();
      } catch {
        setError('Upload failed.');
      } finally {
        setIsUploading(false);
        if (fileInputRef.current) fileInputRef.current.value = '';
      }
    },
    [props.serviceRequestId, props.equipmentId, props.customerId, fetchRows],
  );

  const handleOpen = useCallback(async (id: string): Promise<void> => {
    try {
      const res = await fetch(`/api/admin/attachments/${id}/download`);
      const body = await res.json().catch(() => ({ success: false }));
      if (res.ok && body.success && body.data.url) {
        window.open(body.data.url, '_blank', 'noopener,noreferrer');
      } else {
        setError('Could not open file.');
      }
    } catch {
      setError('Could not open file.');
    }
  }, []);

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold">
          <Paperclip className="h-4 w-4" />
          Attachments
        </h3>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={isUploading}
          onClick={() => fileInputRef.current?.click()}
        >
          <Upload className="mr-1 h-3.5 w-3.5" />
          {isUploading ? 'Uploading…' : 'Upload'}
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/heic,application/pdf"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleUpload(file);
          }}
        />
      </div>

      {error ? (
        <p className="mb-2 text-sm text-destructive">{error}</p>
      ) : null}

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No attachments yet.</p>
      ) : (
        <div className="space-y-2">
          {rows.map((row) => {
            const isImage = row.mimeType.startsWith('image/');
            return (
              <button
                key={row.id}
                type="button"
                onClick={() => void handleOpen(row.id)}
                className="flex w-full items-center justify-between rounded-lg border p-3 text-left hover:bg-muted/30"
              >
                <span className="flex min-w-0 items-center gap-2">
                  {isImage ? (
                    <ImageIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className="truncate text-sm">{row.filename}</span>
                </span>
                <span className="ml-2 shrink-0 text-xs text-muted-foreground">
                  {formatSize(row.size)}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
