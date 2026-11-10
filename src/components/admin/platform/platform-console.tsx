'use client';

import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { Check, Copy, Eye, Loader2, Plus, Download, Trash2, RefreshCw, Mail } from 'lucide-react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { selectLabel, type SelectOption } from '@/lib/admin/select-label';
import type { FeatureKey, Features } from '@/lib/tenancy/feature-flags';
import {
  initialSwitchRow,
  saveFailed,
  saveSucceeded,
  startSave,
  type SwitchRowState,
} from '@/lib/admin/platform-switch-state';
import { SkeletonTable } from '@/components/admin/ui/skeleton-table';
import { ownerInviteView } from '@/lib/admin/invite-result-view';

interface OrgRow {
  readonly id: string;
  readonly name: string;
  readonly status: 'active' | 'suspended' | 'trial' | 'past_due';
  readonly createdAt: string;
  readonly features: Features;
  /** True when the org has an owner email on file (the address never reaches the client). */
  readonly hasOwnerEmail: boolean;
}

/** Token-based status badge for org status — no raw palette classes. */
function OrgStatusBadge({ status }: { status: OrgRow['status'] }) {
  const classes: Record<string, string> = {
    active: 'bg-success-light text-success-strong border-success/30',
    suspended: 'bg-danger-light text-danger-strong border-danger/30',
    trial: 'bg-warning-light text-warning-foreground border-warning/30',
    past_due: 'bg-danger-light text-danger-strong border-danger/30',
  };
  const labels: Record<string, string> = {
    active: 'Active',
    suspended: 'Suspended',
    trial: 'Trial',
    past_due: 'Past due',
  };

  // Unknown/unexpected status: render the raw value with neutral styling
  // rather than an empty badge or crash.
  const className = classes[status] ?? 'bg-muted text-muted-foreground border-border';
  const label = labels[status] ?? status;

  return (
    <Badge variant="outline" className={className}>
      {label}
    </Badge>
  );
}

const SWITCHES: readonly { readonly key: FeatureKey; readonly label: string }[] = [
  { key: 'map', label: 'Map' },
  { key: 'reviewRequests', label: 'Review requests' },
  { key: 'payLinks', label: 'Pay links' },
  { key: 'showHistory', label: 'Show history' },
];

/** One org's feature switches. Optimistic: a failed save reverts the switch. */
function OrgSwitches({ org }: { readonly org: OrgRow }) {
  const [row, setRow] = useState<SwitchRowState>(() => initialSwitchRow(org.features));
  const [error, setError] = useState<string | null>(null);

  async function toggle(key: FeatureKey, next: boolean) {
    if (row.pending) return;
    const previous = row.features[key];
    setRow(startSave(row, key, next));
    setError(null);
    try {
      const res = await fetch(`/api/platform/organizations/${org.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ features: { [key]: next } }),
      });
      const json = await res.json().catch(() => ({ success: false }));
      if (res.ok && json.success) {
        setRow(saveSucceeded(json.data.features as Features));
        return;
      }
    } catch {
      // fall through to the revert below
    }
    setRow((current) => saveFailed(current, key, previous));
    setError('Couldn’t save the switch. Please try again.');
  }

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <span className="text-sm font-medium">Switches</span>
        {SWITCHES.map(({ key, label }) => {
          const id = `${org.id}-${key}`;
          return (
            <div key={key} className="flex items-center gap-2">
              <Switch
                id={id}
                size="sm"
                checked={row.features[key]}
                disabled={row.pending}
                onCheckedChange={(next) => void toggle(key, next)}
              />
              <Label htmlFor={id} className="text-sm font-normal">
                {label}
              </Label>
            </div>
          );
        })}
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/** Codes whose server message is already human copy for the operator. */
const OWNER_INVITE_SHOWN_CODES = new Set([
  'NO_OWNER_EMAIL',
  'INVITE_EXISTS',
  'EMAIL_CONFLICT',
  'SEAT_LIMIT_REACHED',
  'PLATFORM_PROTECTED',
]);

/** "Send owner invite": an admin invite to the org's owner email, which promotes
 * the owner to super_admin on accept. Shows "Invite emailed." when emailed, and
 * the one-time copy link whenever the server returns one. */
function OwnerInvite({ org }: { readonly org: OrgRow }) {
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<ReturnType<typeof ownerInviteView> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function send() {
    if (sending) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch(`/api/platform/organizations/${org.id}/owner-invite`, {
        method: 'POST',
      });
      const json = await res.json().catch(() => ({ success: false }));
      if (res.ok && json.success) {
        setCopied(false);
        setResult(
          ownerInviteView({
            emailed: json.data.emailed === true,
            url: typeof json.data.url === 'string' ? json.data.url : undefined,
          }),
        );
      } else {
        const code = json.error?.code;
        setError(
          typeof code === 'string' && OWNER_INVITE_SHOWN_CODES.has(code)
            ? String(json.error.message)
            : 'Couldn’t send the owner invite. Please try again.',
        );
      }
    } catch {
      setError('Couldn’t send the owner invite. Please try again.');
    } finally {
      setSending(false);
    }
  }

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard may be unavailable; the URL is still visible to copy manually.
    }
  }

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" variant="outline" onClick={() => void send()} disabled={sending}>
          {sending ? <Loader2 className="size-4 animate-spin" /> : <Mail className="size-4" />}
          Send owner invite
        </Button>
        {result?.line && (
          <p role="status" className="text-sm text-muted-foreground">
            {result.line}
          </p>
        )}
      </div>
      {result?.url && (
        <div className="max-w-xl space-y-1">
          <div className="flex items-center gap-2">
            <Input
              readOnly
              value={result.url ?? ''}
              aria-label="Owner invite link"
              onFocus={(e) => e.currentTarget.select()}
              className="font-mono text-xs"
            />
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={() => result.url && void copy(result.url)}
              aria-label="Copy invite link"
            >
              {copied ? <Check className="size-4 text-success" /> : <Copy className="size-4" />}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            This link is shown only once. It expires in 72 hours.
          </p>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

const ROLE_LABELS: Record<string, string> = {
  super_admin: 'Super admin',
  admin: 'Admin',
  technician: 'Technician',
};

/** "View as" (spec P7): render the admin as an active user of this org, read-only.
 * Start POSTs the preview route; the cookie it sets makes every page render as
 * the target until Exit (in the banner). */
export function ViewAs() {
  const [options, setOptions] = useState<SelectOption[] | null>(null);
  const [userId, setUserId] = useState('');
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const res = await fetch('/api/admin/preview');
        const json = await res.json().catch(() => ({ success: false }));
        if (!live) return;
        if (res.ok && json.success) {
          const targets = json.data.targets as { userId: string; name: string; role: string }[];
          setOptions(
            targets.map((t) => ({
              value: t.userId,
              label: `${t.name} · ${ROLE_LABELS[t.role] ?? t.role}`,
            })),
          );
          return;
        }
      } catch {
        // fall through to the error below
      }
      if (live) {
        setOptions([]);
        setError('Couldn’t load the people in this org. Please try again.');
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  async function start() {
    if (starting || userId === '') return;
    setStarting(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId }),
      });
      if (res.ok) {
        location.assign('/admin');
        return;
      }
      setError(
        res.status === 404
          ? 'That person is no longer an active user. Pick someone else.'
          : 'Couldn’t start the preview. Please try again.',
      );
    } catch {
      setError('Couldn’t start the preview. Please try again.');
    }
    setStarting(false);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>View as</CardTitle>
        <CardDescription>
          See the admin exactly as someone in your org sees it. Read-only: nothing can be
          saved until you exit.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={userId}
            onValueChange={(v) => setUserId(typeof v === 'string' ? v : '')}
            disabled={options === null || options.length === 0}
          >
            <SelectTrigger className="w-full sm:w-72" aria-label="Person to view as">
              <SelectValue>
                {(v: unknown) =>
                  selectLabel(
                    options ?? [],
                    v,
                    options === null ? 'Loading…' : options.length === 0 ? 'No one to view as' : 'Pick a person',
                  )
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {(options ?? []).map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="sm" onClick={() => void start()} disabled={starting || userId === ''}>
            {starting ? <Loader2 className="size-4 animate-spin" /> : <Eye className="size-4" />}
            View as
          </Button>
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/** Tenant console: a list of orgs + a "Create tenant" dialog that provisions an
 * org and surfaces the one-time owner invite URL to copy. */
export function PlatformConsole() {
  const [orgs, setOrgs] = useState<OrgRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [purgingOrg, setPurgingOrg] = useState<OrgRow | null>(null);
  // Tracks whether we have ever received data; avoids closing over orgs state
  // in loadOrgs while still suppressing the skeleton flash on refetch.
  const hasData = useRef(false);

  const loadOrgs = useCallback(async () => {
    setListError(null);
    if (!hasData.current) setLoading(true);
    try {
      const res = await fetch('/api/platform/organizations');
      const json = await res.json();
      if (res.ok && json.success) {
        hasData.current = true;
        setOrgs(json.data.organizations as OrgRow[]);
      } else {
        setListError(json.error?.message ?? 'Could not load organizations.');
      }
    } catch {
      setListError('Could not load organizations.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadOrgs();
  }, [loadOrgs]);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-4">
        <div>
          <CardTitle>Organizations</CardTitle>
          <CardDescription>
            Every tenant on the platform. Provision a new one to onboard a
            business.
          </CardDescription>
        </div>
        <CreateTenantDialog onCreated={loadOrgs} />
      </CardHeader>
      <CardContent>
        {listError && (
          <div className="flex items-center justify-between gap-3 text-sm text-destructive">
            <span>{listError}</span>
            <Button variant="outline" size="sm" onClick={() => void loadOrgs()}>
              <RefreshCw className="size-3.5" />
              Retry
            </Button>
          </div>
        )}
        {loading ? (
          <SkeletonTable rows={4} cols={4} />
        ) : orgs.length === 0 ? (
          <p className="text-sm text-muted-foreground">No organizations yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {orgs.map((o) => (
                <Fragment key={o.id}>
                <TableRow>
                  <TableCell className="font-medium">{o.name}</TableCell>
                  <TableCell>
                    <OrgStatusBadge status={o.status} />
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {new Date(o.createdAt).toLocaleDateString()}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      {/* Export is a plain download — the API streams a JSON
                          attachment, so a same-tab navigation is simplest. */}
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          window.location.href = `/api/platform/organizations/${o.id}/export`;
                        }}
                      >
                        <Download className="size-4" /> Export
                      </Button>
                      {/* Purge is irreversible; ghost variant keeps it less
                          prominent in the row — the confirmation dialog is the
                          real guard. */}
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive hover:text-destructive hover:bg-danger-light"
                        onClick={() => setPurgingOrg(o)}
                      >
                        <Trash2 className="size-4" /> Purge
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell colSpan={4} className="bg-surface-sunken/40 py-2.5">
                    <div className="space-y-2.5">
                      <OrgSwitches org={o} />
                      {o.hasOwnerEmail && <OwnerInvite org={o} />}
                    </div>
                  </TableCell>
                </TableRow>
                </Fragment>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>

      <PurgeTenantDialog
        org={purgingOrg}
        onClose={() => setPurgingOrg(null)}
        onPurged={() => {
          setPurgingOrg(null);
          void loadOrgs();
        }}
      />
    </Card>
  );
}

/** Purge confirmation: the operator must type the org's exact name to enable
 * the irreversible delete. The org row + everything it owns is destroyed. */
function PurgeTenantDialog({
  org,
  onClose,
  onPurged,
}: {
  readonly org: OrgRow | null;
  readonly onClose: () => void;
  readonly onPurged: () => void;
}) {
  const [confirmText, setConfirmText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset the typed confirmation whenever a different org is targeted.
  useEffect(() => {
    setConfirmText('');
    setError(null);
    setSubmitting(false);
  }, [org?.id]);

  const matches = org !== null && confirmText.trim() === org.name;

  async function handlePurge() {
    if (!org || !matches) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/platform/organizations/${org.id}`, {
        method: 'DELETE',
      });
      const json = await res.json().catch(() => ({ success: false }));
      if (res.ok && json.success) {
        onPurged();
      } else {
        setError(json.error?.message ?? 'Could not purge the tenant.');
        setSubmitting(false);
      }
    } catch {
      setError('Could not purge the tenant.');
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={org !== null}
      onOpenChange={(next) => {
        if (!next && !submitting) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Purge tenant</DialogTitle>
          <DialogDescription>
            This permanently deletes{' '}
            <span className="font-semibold">{org?.name}</span> and ALL of its
            data — customers, jobs, invoices, conversations, files. This cannot
            be undone. Type the organization name to confirm.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="purge-confirm">Organization name</Label>
            <Input
              id="purge-confirm"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={org?.name ?? ''}
              autoComplete="off"
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => void handlePurge()}
              disabled={!matches || submitting}
            >
              {submitting && <Loader2 className="size-4 animate-spin" />}
              Purge permanently
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function CreateTenantDialog({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [ownerEmail, setOwnerEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  function reset() {
    setName('');
    setOwnerEmail('');
    setError(null);
    setInviteUrl(null);
    setCopied(false);
    setSubmitting(false);
  }

  async function handleSubmit() {
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch('/api/platform/organizations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, ownerEmail }),
      });
      const json = await res.json();
      if (res.ok && json.success) {
        setInviteUrl(json.data.inviteUrl as string);
        onCreated();
      } else {
        setError(json.error?.message ?? 'Could not create the tenant.');
      }
    } catch {
      setError('Could not create the tenant.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCopy() {
    if (!inviteUrl) return;
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard may be unavailable; the URL is still visible to copy manually.
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger render={<Button size="sm" />}>
        <Plus className="size-4" /> Create tenant
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create tenant</DialogTitle>
          <DialogDescription>
            Provision a new organization and invite its owner. The owner accepts
            the link, signs in, and runs the org.
          </DialogDescription>
        </DialogHeader>

        {inviteUrl ? (
          <div className="space-y-3">
            <p className="text-sm">
              Tenant created. Share this one-time invite link with the owner:
            </p>
            <div className="flex items-center gap-2">
              <Input readOnly value={inviteUrl} className="font-mono text-xs" />
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={() => void handleCopy()}
                aria-label="Copy invite link"
              >
                {copied ? (
                  <Check className="size-4 text-success" />
                ) : (
                  <Copy className="size-4" />
                )}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              This link is shown only once. It expires in 72 hours.
            </p>
            <DialogFooter>
              <Button type="button" onClick={() => setOpen(false)}>
                Done
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="tenant-name">Business name</Label>
              <Input
                id="tenant-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={200}
                placeholder="Acme HVAC"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="tenant-owner-email">Owner email</Label>
              <Input
                id="tenant-owner-email"
                type="email"
                value={ownerEmail}
                onChange={(e) => setOwnerEmail(e.target.value)}
                maxLength={320}
                placeholder="owner@acme.com"
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <DialogFooter>
              <Button
                type="button"
                onClick={() => void handleSubmit()}
                disabled={
                  submitting ||
                  name.trim().length === 0 ||
                  ownerEmail.trim().length === 0
                }
              >
                {submitting && <Loader2 className="size-4 animate-spin" />}
                Create tenant
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
