'use client';

import { use, useCallback, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft,
  Building2,
  Phone,
  Mail,
  MapPin,
  Wrench,
  Plus,
  StickyNote,
  Bell,
  Clock,
  CheckCircle,
  Trash2,
  Pencil,
  Archive,
  ShieldX,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { PageShell } from '@/components/admin/ui/page-shell';
import { EmptyState } from '@/components/admin/ui/empty-state';
import { StatusBadge } from '@/components/admin/status-badge';
import { useCustomerDetail } from '@/hooks/use-admin-customers';
import { EquipmentFormDialog } from '@/components/admin/equipment-form-dialog';
import { NoteFormDialog } from '@/components/admin/note-form-dialog';
import { FollowUpFormDialog } from '@/components/admin/follow-up-form-dialog';
import { CustomerEditDialog } from '@/components/admin/customer-edit-dialog';
import { ConfirmDialog } from '@/components/admin/confirm-dialog';
import { ScopedEstimatesSection } from '@/components/admin/estimates/scoped-estimates-section';
import { ScopedInvoicesSection } from '@/components/admin/invoices/scoped-invoices-section';
import { CustomerMembershipCard } from '@/components/admin/memberships/customer-membership-card';
import { PortalLinkCard } from '@/components/admin/portal-link-card';
import type { EquipmentRecord } from '@/lib/admin/crm-types';

const EQUIPMENT_LABELS: Record<string, string> = {
  ac: 'Air Conditioner',
  furnace: 'Furnace',
  heat_pump: 'Heat Pump',
  boiler: 'Boiler',
  mini_split: 'Mini Split',
  thermostat: 'Thermostat',
  other: 'Other',
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/** Warranty status badge text from the tracked expiry: "EXPIRED" once past,
 * otherwise "Expires in N days" (the column the reminder sweep keys off). */
function warrantyStatusLabel(iso: string): string {
  const days = Math.ceil(
    (new Date(iso).getTime() - Date.now()) / (24 * 60 * 60 * 1000),
  );
  if (days < 0) return 'EXPIRED';
  if (days === 0) return 'Expires today';
  return `Expires in ${days} day${days === 1 ? '' : 's'}`;
}

export default function CustomerDetailPage({
  params,
}: {
  readonly params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const { customer, isLoading, error, refetch } = useCustomerDetail(id);
  const [showEquipmentForm, setShowEquipmentForm] = useState(false);
  const [editingEquipment, setEditingEquipment] =
    useState<EquipmentRecord | null>(null);
  const [deletingEquipment, setDeletingEquipment] =
    useState<EquipmentRecord | null>(null);
  const [isDeletingEquipment, setIsDeletingEquipment] = useState(false);
  const [equipmentDeleteError, setEquipmentDeleteError] = useState<string | null>(
    null,
  );
  const [showNoteForm, setShowNoteForm] = useState(false);
  const [showFollowUpForm, setShowFollowUpForm] = useState(false);
  const [showEditForm, setShowEditForm] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [showArchiveConfirm, setShowArchiveConfirm] = useState(false);
  const [isArchiving, setIsArchiving] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [showEraseConfirm, setShowEraseConfirm] = useState(false);
  const [isErasing, setIsErasing] = useState(false);
  const [eraseError, setEraseError] = useState<string | null>(null);
  const [completingId, setCompletingId] = useState<string | null>(null);

  const handleCompleteFollowUp = useCallback(
    async (followUpId: string): Promise<void> => {
      setCompletingId(followUpId);
      try {
        const res = await fetch(`/api/admin/customers/${id}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'complete_follow_up',
            followUpId,
          }),
        });
        const json = await res.json().catch(() => ({ success: false }));
        if (res.ok && json.success) {
          refetch();
        }
      } catch {
        // Surfaced by the unchanged status on refetch; no destructive failure.
      } finally {
        setCompletingId(null);
      }
    },
    [id, refetch],
  );

  const handleDelete = useCallback(async (): Promise<void> => {
    setIsDeleting(true);
    setDeleteError(null);

    try {
      const res = await fetch(`/api/admin/customers/${id}`, {
        method: 'DELETE',
      });

      const json = await res.json().catch(() => ({
        error: { message: 'Failed to delete customer' },
      }));

      if (res.ok && json.success) {
        // Keep the button disabled — navigation unmounts this page, and
        // re-enabling here would briefly allow a second (404-ing) delete.
        router.push('/admin/customers');
        return;
      }

      setDeleteError(json.error?.message ?? 'Failed to delete customer');
      setIsDeleting(false);
    } catch {
      setDeleteError('Network error');
      setIsDeleting(false);
    }
  }, [id, router]);

  const handleArchive = useCallback(async (): Promise<void> => {
    setIsArchiving(true);
    setArchiveError(null);

    try {
      const res = await fetch(`/api/admin/customers/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'archive' }),
      });

      const json = await res.json().catch(() => ({
        error: { message: 'Failed to archive customer' },
      }));

      if (res.ok && json.success) {
        // Archived customers drop out of the list — leave disabled and navigate
        // (unmounts this page) so a second archive can't fire.
        router.push('/admin/customers');
        return;
      }

      setArchiveError(json.error?.message ?? 'Failed to archive customer');
      setIsArchiving(false);
    } catch {
      setArchiveError('Network error');
      setIsArchiving(false);
    }
  }, [id, router]);

  const handleErase = useCallback(async (): Promise<void> => {
    setIsErasing(true);
    setEraseError(null);

    try {
      const res = await fetch(`/api/admin/customers/${id}/erase`, {
        method: 'POST',
      });

      const json = await res.json().catch(() => ({
        error: { message: 'Failed to erase customer data' },
      }));

      if (res.ok && json.success) {
        // The customer row is retained (anonymized), but the PII is gone — send
        // the admin back to the list rather than re-render a "[deleted]" record.
        router.push('/admin/customers');
        return;
      }

      setEraseError(json.error?.message ?? 'Failed to erase customer data');
      setIsErasing(false);
    } catch {
      setEraseError('Network error');
      setIsErasing(false);
    }
  }, [id, router]);

  const handleDeleteEquipment = useCallback(async (): Promise<void> => {
    if (!deletingEquipment) return;
    setIsDeletingEquipment(true);
    setEquipmentDeleteError(null);

    try {
      const res = await fetch(`/api/admin/customers/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'delete_equipment',
          equipmentId: deletingEquipment.id,
        }),
      });
      const json = await res.json().catch(() => ({
        error: { message: 'Failed to delete equipment' },
      }));

      if (res.ok && json.success) {
        setDeletingEquipment(null);
        refetch();
      } else {
        setEquipmentDeleteError(
          json.error?.message ?? 'Failed to delete equipment',
        );
      }
    } catch {
      setEquipmentDeleteError('Network error');
    } finally {
      setIsDeletingEquipment(false);
    }
  }, [id, deletingEquipment, refetch]);

  function handleAddEquipment(): void {
    setEditingEquipment(null);
    setShowEquipmentForm(true);
  }

  function handleEditEquipment(equipment: EquipmentRecord): void {
    setEditingEquipment(equipment);
    setShowEquipmentForm(true);
  }

  if (isLoading) {
    return (
      <PageShell>
        <div className="flex items-center gap-4">
          <Skeleton className="size-7 shrink-0 rounded-lg" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-7 w-48" />
            <Skeleton className="h-4 w-32" />
          </div>
        </div>
        <Skeleton className="h-40 w-full rounded-xl" />
        <Skeleton className="h-48 w-full rounded-xl" />
        <Skeleton className="h-48 w-full rounded-xl" />
      </PageShell>
    );
  }

  if (error || !customer) {
    return (
      <PageShell>
        <EmptyState
          icon={Building2}
          title="Customer not found"
          description={error ?? 'This customer may have been deleted or archived.'}
          action={
            <Link href="/admin/customers">
              <Button variant="outline">Back to Customers</Button>
            </Link>
          }
        />
      </PageShell>
    );
  }

  return (
    <PageShell>
      {/* Header */}
      <div className="flex items-center gap-4">
        <Link href="/admin/customers">
          <Button variant="ghost" size="icon-sm" aria-label="Back to customers">
            <ArrowLeft className="size-4" />
          </Button>
        </Link>
        <div className="flex-1">
          <h1 className="font-heading text-2xl font-bold tracking-tight">
            {customer.name ?? 'Unknown Customer'}
          </h1>
          <p className="text-sm text-muted-foreground">
            Customer since {formatDate(customer.createdAt)}
          </p>
        </div>
        <Button variant="outline" onClick={() => setShowEditForm(true)}>
          <Pencil className="size-4" />
          Edit
        </Button>
        <Button
          variant="outline"
          onClick={() => {
            setArchiveError(null);
            setShowArchiveConfirm(true);
          }}
        >
          <Archive className="size-4" />
          Archive
        </Button>
        <Button
          variant="destructive"
          onClick={() => {
            setDeleteError(null);
            setShowDeleteConfirm(true);
          }}
        >
          <Trash2 className="size-4" />
          Delete
        </Button>
        <Button
          variant="destructive"
          onClick={() => {
            setEraseError(null);
            setShowEraseConfirm(true);
          }}
        >
          <ShieldX className="size-4" />
          Erase data (GDPR)
        </Button>
      </div>

      {/* Contact Info */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Building2 className="size-4" />
            Contact Information
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-2">
            {customer.phone && (
              <div className="flex items-center gap-2 text-sm">
                <Phone className="size-4 text-muted-foreground" />
                {customer.phone}
              </div>
            )}
            {customer.email && (
              <div className="flex items-center gap-2 text-sm">
                <Mail className="size-4 text-muted-foreground" />
                {customer.email}
              </div>
            )}
            {customer.address && (
              <div className="flex items-center gap-2 text-sm sm:col-span-2">
                <MapPin className="size-4 text-muted-foreground" />
                {customer.address}
              </div>
            )}
            {customer.propertyType && (
              <div className="text-sm text-muted-foreground">
                Property: {customer.propertyType}
                {customer.propertySqft ? ` (${customer.propertySqft} sq ft)` : ''}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* FieldPulse custom fields */}
      {customer.fieldpulseCustomFields && customer.fieldpulseCustomFields.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <span className="rounded border bg-violet-50 px-1.5 py-px text-[10px] font-medium text-violet-700">FieldPulse</span>
              Details
            </CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-1 text-sm sm:grid-cols-2">
              {customer.fieldpulseCustomFields.map((field) => (
                <div key={field.name} className="flex gap-2">
                  <dt className="text-muted-foreground shrink-0">{field.name}:</dt>
                  <dd>{field.value}</dd>
                </div>
              ))}
            </dl>
          </CardContent>
        </Card>
      )}

      {/* Membership */}
      <CustomerMembershipCard customerId={id} />

      {/* Customer self-service portal link */}
      <PortalLinkCard
        customerId={id}
        portalActive={customer.portalActive}
        onChanged={refetch}
      />

      {/* Equipment */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2 text-base">
              <Wrench className="size-4" />
              Equipment ({customer.equipment.length})
            </CardTitle>
            <Button size="sm" variant="outline" onClick={handleAddEquipment}>
              <Plus className="mr-1 size-3" />
              Add
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {customer.equipment.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No equipment registered yet.
            </p>
          ) : (
            <div className="space-y-3">
              {customer.equipment.map((eq) => (
                <div
                  key={eq.id}
                  className="rounded-lg border p-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="flex items-center gap-1.5 font-medium text-sm">
                      {EQUIPMENT_LABELS[eq.equipmentType] ?? eq.equipmentType}
                      {eq.fieldpulseAssetId && (
                        <span className="rounded border bg-violet-50 px-1.5 py-px text-[10px] font-medium text-violet-700">FieldPulse</span>
                      )}
                    </p>
                    <div className="flex items-center gap-1">
                      {eq.warrantyExpiration && (
                        <Badge
                          variant={
                            new Date(eq.warrantyExpiration) < new Date()
                              ? 'destructive'
                              : 'outline'
                          }
                          className="text-xs"
                        >
                          {warrantyStatusLabel(eq.warrantyExpiration)}
                        </Badge>
                      )}
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        onClick={() => handleEditEquipment(eq)}
                        aria-label="Edit equipment"
                      >
                        <Pencil className="size-3.5" />
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        onClick={() => setDeletingEquipment(eq)}
                        aria-label="Delete equipment"
                        className="text-muted-foreground hover:text-destructive"
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {[eq.make, eq.model].filter(Boolean).join(' ') || 'No details'}
                    {eq.serialNumber ? ` — S/N: ${eq.serialNumber}` : ''}
                  </p>
                  {eq.locationInHome && (
                    <p className="text-xs text-muted-foreground">
                      Location: {eq.locationInHome}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Service History */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Clock className="size-4" />
            Service History ({customer.serviceHistory.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {customer.serviceHistory.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No service history yet.
            </p>
          ) : (
            <div className="space-y-3">
              {customer.serviceHistory.map((h) => (
                <div key={h.id} className="rounded-lg border p-3">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-medium">
                      {h.referenceNumber ?? 'Manual Entry'}
                    </p>
                    <span className="text-xs text-muted-foreground">
                      {formatDate(h.createdAt)}
                    </span>
                  </div>
                  {h.issueType && (
                    <p className="text-xs text-muted-foreground mt-1">
                      {h.issueType.replace(/_/g, ' ')}
                    </p>
                  )}
                  {h.workPerformed && (
                    <p className="text-sm mt-1">{h.workPerformed}</p>
                  )}
                  {h.cost !== null && h.cost !== undefined && (
                    <p className="text-sm font-medium mt-1">
                      ${(h.cost / 100).toFixed(2)}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Estimates */}
      <ScopedEstimatesSection customerId={id} variant="card" />

      {/* Invoices */}
      <ScopedInvoicesSection customerId={id} variant="card" />

      {/* Notes */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2 text-base">
              <StickyNote className="size-4" />
              Notes ({customer.customerNotes.length})
            </CardTitle>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setShowNoteForm(true)}
            >
              <Plus className="mr-1 size-3" />
              Add Note
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {customer.customerNotes.length === 0 ? (
            <p className="text-sm text-muted-foreground">No notes yet.</p>
          ) : (
            <div className="space-y-3">
              {customer.customerNotes.map((n) => (
                <div key={n.id} className="rounded-lg border p-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5">
                      <Badge variant="outline" className="text-xs">
                        {n.noteType}
                      </Badge>
                      {n.fieldpulseCommentId && (
                        <span className="rounded border bg-violet-50 px-1.5 py-px text-[10px] font-medium text-violet-700">FieldPulse</span>
                      )}
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {n.authorName ? `${n.authorName} — ` : ''}
                      {formatDate(n.createdAt)}
                    </span>
                  </div>
                  <p className="mt-2 text-sm">{n.content}</p>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Follow-ups */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2 text-base">
              <Bell className="size-4" />
              Follow-ups ({customer.followUps.length})
            </CardTitle>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setShowFollowUpForm(true)}
            >
              <Plus className="mr-1 size-3" />
              Add
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {customer.followUps.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No follow-ups scheduled.
            </p>
          ) : (
            <div className="space-y-3">
              {customer.followUps.map((f) => (
                <div key={f.id} className="flex items-center gap-3 rounded-lg border p-3">
                  {f.status === 'completed' ? (
                    <CheckCircle className="size-4 text-success" />
                  ) : (
                    <Clock className="size-4 text-muted-foreground" />
                  )}
                  <div className="flex-1">
                    <p className="text-sm">{f.reason}</p>
                    <p className="text-xs text-muted-foreground">
                      Due: {formatDate(f.dueDate)}
                      {f.assignedToName ? ` — ${f.assignedToName}` : ''}
                    </p>
                  </div>
                  {f.status === 'pending' && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={completingId === f.id}
                      onClick={() => handleCompleteFollowUp(f.id)}
                    >
                      {completingId === f.id ? 'Saving...' : 'Complete'}
                    </Button>
                  )}
                  <StatusBadge status={f.status} />
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <EquipmentFormDialog
        open={showEquipmentForm}
        onOpenChange={(open) => {
          setShowEquipmentForm(open);
          if (!open) setEditingEquipment(null);
        }}
        customerId={id}
        equipment={editingEquipment}
        onSuccess={() => {
          setShowEquipmentForm(false);
          setEditingEquipment(null);
          refetch();
        }}
      />

      <NoteFormDialog
        open={showNoteForm}
        onOpenChange={setShowNoteForm}
        customerId={id}
        onSuccess={() => {
          setShowNoteForm(false);
          refetch();
        }}
      />

      <FollowUpFormDialog
        open={showFollowUpForm}
        onOpenChange={setShowFollowUpForm}
        customerId={id}
        onSuccess={() => {
          setShowFollowUpForm(false);
          refetch();
        }}
      />

      <CustomerEditDialog
        open={showEditForm}
        onOpenChange={setShowEditForm}
        customerId={id}
        initial={{
          name: customer.name,
          phone: customer.phone,
          email: customer.email,
          address: customer.address,
          propertyType: customer.propertyType,
          propertySqft: customer.propertySqft,
        }}
        onSuccess={() => {
          setShowEditForm(false);
          refetch();
        }}
      />

      <ConfirmDialog
        open={showArchiveConfirm}
        onOpenChange={setShowArchiveConfirm}
        title="Archive customer?"
        description="This hides the customer from your active list but keeps all their records. If they contact you again, they're automatically reactivated."
        confirmLabel="Archive"
        confirmingLabel="Archiving..."
        isConfirming={isArchiving}
        error={archiveError}
        onConfirm={handleArchive}
      />

      <ConfirmDialog
        open={showDeleteConfirm}
        onOpenChange={setShowDeleteConfirm}
        title="Delete customer?"
        description="This permanently deletes the customer along with their equipment, service history, notes, and follow-ups. This action cannot be undone."
        confirmLabel="Delete"
        confirmingLabel="Deleting..."
        isConfirming={isDeleting}
        error={deleteError}
        onConfirm={handleDelete}
      />

      <ConfirmDialog
        open={showEraseConfirm}
        onOpenChange={setShowEraseConfirm}
        title="Erase customer data (GDPR)?"
        description="This permanently anonymizes the customer: their name, contact details, address, chat messages, notes, attachments, and signatures are erased and cannot be recovered. De-identified financial records (invoices, payments) are kept for accounting. This action is terminal."
        confirmLabel="Erase permanently"
        confirmingLabel="Erasing..."
        isConfirming={isErasing}
        error={eraseError}
        onConfirm={handleErase}
      />

      <ConfirmDialog
        open={deletingEquipment !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeletingEquipment(null);
            setEquipmentDeleteError(null);
          }
        }}
        title="Delete equipment?"
        description="This permanently removes this equipment record from the customer. This action cannot be undone."
        confirmLabel="Delete"
        confirmingLabel="Deleting..."
        isConfirming={isDeletingEquipment}
        error={equipmentDeleteError}
        onConfirm={handleDeleteEquipment}
      />
    </PageShell>
  );
}
