'use client';

import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, Loader2, Plus, Download, Trash2 } from 'lucide-react';
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

interface OrgRow {
  readonly id: string;
  readonly name: string;
  readonly status: 'active' | 'suspended' | 'trial';
  readonly createdAt: string;
}

/** Tenant console: a list of orgs + a "Create tenant" dialog that provisions an
 * org and surfaces the one-time owner invite URL to copy. */
export function PlatformConsole() {
  const [orgs, setOrgs] = useState<OrgRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [purgingOrg, setPurgingOrg] = useState<OrgRow | null>(null);

  const loadOrgs = useCallback(async () => {
    setListError(null);
    try {
      const res = await fetch('/api/platform/organizations');
      const json = await res.json();
      if (res.ok && json.success) {
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
        {listError && <p className="text-sm text-destructive">{listError}</p>}
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </div>
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
                <TableRow key={o.id}>
                  <TableCell className="font-medium">{o.name}</TableCell>
                  <TableCell>
                    <Badge
                      variant={o.status === 'active' ? 'default' : 'secondary'}
                    >
                      {o.status}
                    </Badge>
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
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={() => setPurgingOrg(o)}
                      >
                        <Trash2 className="size-4" /> Purge
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
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
                  <Check className="size-4 text-emerald-600" />
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
