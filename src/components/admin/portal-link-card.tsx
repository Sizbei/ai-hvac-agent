'use client';

import { useCallback, useState } from 'react';
import { Link2, Copy, Check, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

/**
 * Admin control to generate / rotate a customer's self-service portal link.
 * POSTs to the admin-gated portal-token route, which returns the plaintext link
 * exactly ONCE. We hold it in component state for copy-to-clipboard — it is not
 * persisted anywhere client-side beyond this render.
 */
export function PortalLinkCard({
  customerId,
  portalActive,
  onChanged,
}: {
  readonly customerId: string;
  readonly portalActive: boolean;
  readonly onChanged?: () => void;
}) {
  const [link, setLink] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const handleGenerate = useCallback(async (): Promise<void> => {
    setIsGenerating(true);
    setError(null);
    setCopied(false);
    try {
      const res = await fetch(
        `/api/admin/customers/${customerId}/portal-token`,
        { method: 'POST' },
      );
      const json = await res.json().catch(() => ({ success: false }));
      if (res.ok && json.success && json.data?.url) {
        setLink(json.data.url as string);
        onChanged?.();
        return;
      }
      setError(json?.error?.message ?? 'Failed to generate link');
    } catch {
      setError('Network error');
    } finally {
      setIsGenerating(false);
    }
  }, [customerId, onChanged]);

  const handleCopy = useCallback(async (): Promise<void> => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Could not copy to clipboard');
    }
  }, [link]);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <Link2 className="size-4" />
            Customer portal
          </CardTitle>
          {portalActive && (
            <Badge variant="outline" className="text-xs">
              Active link
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          {portalActive
            ? 'A self-service portal link is active. Rotating issues a new link and disables the old one.'
            : 'Generate a secure link the customer can use to view estimates and invoices and pay a balance — no login required.'}
        </p>

        {link && (
          <div className="flex items-center gap-2 rounded-lg border bg-muted/40 p-2">
            <code className="flex-1 truncate text-xs">{link}</code>
            <Button
              size="sm"
              variant="outline"
              onClick={handleCopy}
              aria-label="Copy portal link"
            >
              {copied ? (
                <Check className="size-3.5 text-green-600" />
              ) : (
                <Copy className="size-3.5" />
              )}
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
        )}

        {link && (
          <p className="text-xs text-amber-700">
            Copy this link now — for security it&apos;s shown only once.
          </p>
        )}

        {error && <p className="text-xs text-destructive">{error}</p>}

        <Button
          variant={portalActive ? 'outline' : 'default'}
          size="sm"
          onClick={handleGenerate}
          disabled={isGenerating}
        >
          <RefreshCw className="size-3.5" />
          {isGenerating
            ? 'Generating…'
            : portalActive
              ? 'Rotate link'
              : 'Generate link'}
        </Button>
      </CardContent>
    </Card>
  );
}
