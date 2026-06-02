'use client';

import { useState } from 'react';
import {
  Check,
  Copy,
  KeyRound,
  Loader2,
  Plus,
  ShieldAlert,
  Trash2,
} from 'lucide-react';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useWidgetKeys } from '@/hooks/use-widget-keys';
import type { OrgConfig, OrgConfigUpdate } from '@/lib/admin/org-config-types';

interface EmbedPanelProps {
  readonly config: OrgConfig;
  readonly onSave: (update: OrgConfigUpdate) => Promise<boolean>;
}

function CopyButton({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => {
        void navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
      {label ?? (copied ? 'Copied' : 'Copy')}
    </Button>
  );
}

export function EmbedPanel({ config, onSave }: EmbedPanelProps) {
  const { keys, createKey, revokeKey, error } = useWidgetKeys();
  const [label, setLabel] = useState('');
  const [creating, setCreating] = useState(false);
  // The plaintext key is shown exactly once, right after creation.
  const [revealed, setRevealed] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Origins
  const [origins, setOrigins] = useState<string[]>([...config.allowedOrigins]);
  const [originInput, setOriginInput] = useState('');
  const [savingOrigins, setSavingOrigins] = useState(false);
  const [originsSaved, setOriginsSaved] = useState(false);

  const publishable = keys.find((k) => k.keyType === 'publishable' && k.isActive);
  const snippetKey = publishable?.keyPrefix
    ? `${publishable.keyPrefix}…`
    : 'pk_live_…';
  const snippet = `<script src="https://ai-hvac-agent-lovat.vercel.app/widget.js"\n        data-hvac-key="${snippetKey}" async></script>`;

  async function handleCreate(type: 'publishable' | 'secret'): Promise<void> {
    setCreating(true);
    setRevealed(null);
    const result = await createKey(type, label);
    setCreating(false);
    if (result) {
      setRevealed(result.plaintext);
      setLabel('');
    }
  }

  async function handleRevoke(id: string): Promise<void> {
    setBusyId(id);
    await revokeKey(id);
    setBusyId(null);
  }

  function addOrigin(): void {
    const v = originInput.trim().toLowerCase();
    if (v && !origins.includes(v)) {
      setOrigins((prev) => [...prev, v]);
    }
    setOriginInput('');
  }

  async function saveOrigins(): Promise<void> {
    setSavingOrigins(true);
    setOriginsSaved(false);
    const ok = await onSave({ allowedOrigins: origins });
    setSavingOrigins(false);
    if (ok) {
      setOriginsSaved(true);
      setTimeout(() => setOriginsSaved(false), 2000);
    }
  }

  return (
    <div className="space-y-6">
      {error && (
        <Alert variant="destructive">
          <ShieldAlert className="size-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Embed snippet */}
      <Card>
        <CardHeader>
          <CardTitle>Add the widget to your site</CardTitle>
          <CardDescription>
            Paste this snippet just before the closing{' '}
            <code className="rounded bg-muted px-1">&lt;/body&gt;</code> tag.
            Replace the key with a publishable key below.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="relative">
            <pre className="overflow-x-auto rounded-lg bg-muted p-4 text-xs leading-relaxed">
              <code>{snippet}</code>
            </pre>
            <div className="absolute right-2 top-2">
              <CopyButton value={snippet} />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* API keys */}
      <Card>
        <CardHeader>
          <CardTitle>API keys</CardTitle>
          <CardDescription>
            Use a <strong>publishable</strong> key in the snippet (it&apos;s safe
            to expose). Keep <strong>secret</strong> keys server-side only.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {revealed && (
            <Alert>
              <KeyRound className="size-4" />
              <AlertDescription>
                <p className="mb-2 font-medium">
                  Copy your new key now — you won&apos;t see it again.
                </p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 truncate rounded bg-muted px-2 py-1 text-xs">
                    {revealed}
                  </code>
                  <CopyButton value={revealed} />
                </div>
              </AlertDescription>
            </Alert>
          )}

          <div className="flex flex-wrap items-end gap-2">
            <div className="flex-1 space-y-2">
              <Label htmlFor="key-label">Label (optional)</Label>
              <Input
                id="key-label"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Production site"
                maxLength={80}
              />
            </div>
            <Button
              variant="outline"
              disabled={creating}
              onClick={() => handleCreate('publishable')}
            >
              {creating ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Plus className="size-4" />
              )}
              Publishable
            </Button>
            <Button
              variant="outline"
              disabled={creating}
              onClick={() => handleCreate('secret')}
            >
              <Plus className="size-4" />
              Secret
            </Button>
          </div>

          <div className="space-y-2">
            {keys.length === 0 ? (
              <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
                No keys yet. Create a publishable key to use the snippet.
              </p>
            ) : (
              keys.map((k) => (
                <div
                  key={k.id}
                  className="flex items-center justify-between rounded-lg border px-3 py-2"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <code className="text-sm">{k.keyPrefix}…</code>
                      <Badge
                        variant={
                          k.keyType === 'secret' ? 'destructive' : 'secondary'
                        }
                      >
                        {k.keyType}
                      </Badge>
                      {!k.isActive && <Badge variant="outline">revoked</Badge>}
                    </div>
                    {k.label && (
                      <p className="truncate text-xs text-muted-foreground">
                        {k.label}
                      </p>
                    )}
                  </div>
                  {k.isActive && (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      disabled={busyId === k.id}
                      onClick={() => handleRevoke(k.id)}
                      aria-label="Revoke key"
                      className="text-muted-foreground hover:text-destructive"
                    >
                      {busyId === k.id ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <Trash2 className="size-4" />
                      )}
                    </Button>
                  )}
                </div>
              ))
            )}
          </div>
        </CardContent>
      </Card>

      {/* Allowed domains */}
      <Card>
        <CardHeader>
          <CardTitle>Allowed domains</CardTitle>
          <CardDescription>
            Only these domains can run your widget. Leave empty to allow any
            domain (the publishable key alone gates access). Use{' '}
            <code className="rounded bg-muted px-1">acme.com</code> or{' '}
            <code className="rounded bg-muted px-1">*.acme.com</code>.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2">
            <Input
              value={originInput}
              onChange={(e) => setOriginInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addOrigin();
                }
              }}
              placeholder="acme.com"
            />
            <Button variant="outline" onClick={addOrigin}>
              Add
            </Button>
          </div>
          <div className="flex flex-wrap gap-2">
            {origins.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No domains added — any domain with a valid key is allowed.
              </p>
            ) : (
              origins.map((o) => (
                <Badge key={o} variant="secondary" className="gap-1">
                  {o}
                  <button
                    type="button"
                    onClick={() =>
                      setOrigins((prev) => prev.filter((x) => x !== o))
                    }
                    className="ml-1 text-muted-foreground hover:text-destructive"
                    aria-label={`Remove ${o}`}
                  >
                    ×
                  </button>
                </Badge>
              ))
            )}
          </div>
        </CardContent>
        <CardFooter>
          <Button onClick={saveOrigins} disabled={savingOrigins}>
            {savingOrigins ? (
              <Loader2 className="size-4 animate-spin" />
            ) : originsSaved ? (
              <Check className="size-4" />
            ) : null}
            {originsSaved ? 'Saved' : 'Save domains'}
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
