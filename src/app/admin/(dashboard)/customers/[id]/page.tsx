'use client';

import { use, useCallback, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Building2,
  Wrench,
  Plus,
  StickyNote,
  Bell,
  Clock,
  CheckCircle,
  Trash2,
  Pencil,
  Archive,
  ArchiveRestore,
  Phone,
  Mail,
  ShieldX,
  MoreHorizontal,
  User,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { PageShell } from '@/components/admin/ui/page-shell';
import { PageHeader } from '@/components/admin/ui/page-header';
import { SectionCard } from '@/components/admin/ui/section-card';
import { EmptyState } from '@/components/admin/ui/empty-state';
import { StatusBadge } from '@/components/admin/status-badge';
import { useCustomerDetail } from '@/hooks/use-admin-customers';
import { EquipmentFormDialog } from '@/components/admin/equipment-form-dialog';
import { NoteFormDialog } from '@/components/admin/note-form-dialog';
import { FollowUpFormDialog } from '@/components/admin/follow-up-form-dialog';
import { CustomerEditDialog } from '@/components/admin/customer-edit-dialog';
import { ConfirmDialog } from '@/components/admin/confirm-dialog';
import { LocationsSection } from '@/components/admin/customers/locations-section';
import { ContactsSection } from '@/components/admin/customers/contacts-section';
import { TagChipPicker } from '@/components/admin/tag-chip-picker';
import { CustomerBookingsSection } from '@/components/admin/customers/customer-bookings-section';
import { CustomerEstimatesCard } from '@/components/admin/customers/customer-estimates-card';
import { CustomerInvoicesCard } from '@/components/admin/customers/customer-invoices-card';
import { CustomerMembershipCard } from '@/components/admin/memberships/customer-membership-card';
import { PortalLinkCard } from '@/components/admin/portal-link-card';
import { FieldpulseDetails } from '@/components/admin/fieldpulse-details';
import { SyncPill } from '@/components/admin/sync-pill';
import type { EquipmentRecord } from '@/lib/admin/crm-types';
import { equipmentDetailsLine, equipmentRowActions, replacedOnLabel } from '@/lib/admin/crm-equipment-records';
import { formatCentsExact } from '@/lib/admin/money-format';
import {
  equipmentTypeLabel,
  humanizeCode,
  issueTypeLabel,
  noteTypeLabel,
} from '@/lib/admin/display-labels';
import { customerActivity } from '@/lib/admin/customer-display';
import { customerNameLabel } from '@/lib/admin/customer-name-display';
import { formatAddressDisplay, formatPhoneDisplay } from '@/lib/admin/contact-format';

/** Another row in this org sharing the target's email or phone hash — id +
 * server-side decrypted name only (customer-identity SPEC §5.1 disclosure). */
interface ContactSibling {
  readonly id: string;
  readonly name: string | null;
}

/** Bullet list caps here; the rest collapse into a single "+N more…" row. */
const MAX_SIBLINGS_SHOWN = 8;


/**
 * Ruled definition row — 140 px label, value right-aligned, one hairline per
 * pair. The detail-page pattern for the redesign; replaces the label-above-value
 * card grid.
 */
function DetailRow({
  label,
  value,
  mono = false,
}: {
  readonly label: string;
  readonly value: React.ReactNode;
  readonly mono?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-6 border-b border-border py-2 last:border-b-0 last:pb-0">
      <dt className="w-24 shrink-0 text-[13px] leading-5 text-muted-foreground sm:w-[140px]">
        {label}
      </dt>
      <dd
        className={`min-w-0 flex-1 break-words text-right text-[13px] leading-5 text-foreground${
          mono ? ' font-mono tabular-nums' : ''
        }`}
      >
        {value}
      </dd>
    </div>
  );
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/** Warranty status badge text from the tracked expiry: "Expired" once past,
 * otherwise "Expires in N days" (the column the reminder sweep keys off). */
function warrantyStatusLabel(iso: string): string {
  const days = Math.ceil(
    (new Date(iso).getTime() - Date.now()) / (24 * 60 * 60 * 1000),
  );
  if (days < 0) return 'Expired';
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
  const [eraseSiblings, setEraseSiblings] = useState<readonly ContactSibling[]>([]);
  const [isLoadingSiblings, setIsLoadingSiblings] = useState(false);
  const [completingId, setCompletingId] = useState<string | null>(null);
  const [followUpError, setFollowUpError] = useState<string | null>(null);
  const [isUnarchiving, setIsUnarchiving] = useState(false);
  const [unarchiveError, setUnarchiveError] = useState<string | null>(null);

  const handleCompleteFollowUp = useCallback(
    async (followUpId: string): Promise<void> => {
      setCompletingId(followUpId);
      setFollowUpError(null);
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
        } else {
          setFollowUpError("Couldn't complete the follow-up. Please try again.");
          // A 404 means it was already completed elsewhere — show that state.
          if (res.status === 404) refetch();
        }
      } catch {
        setFollowUpError("Couldn't complete the follow-up. Please try again.");
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

      setDeleteError(
        res.status === 403
          ? 'Only a super admin can delete customers.'
          : "Couldn't delete the customer. Please try again.",
      );
      setIsDeleting(false);
    } catch {
      setDeleteError("Couldn't delete the customer. Please try again.");
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
        // Stay on the profile: the "Archived" banner confirms it and offers
        // the undo.
        setShowArchiveConfirm(false);
        setIsArchiving(false);
        refetch();
        return;
      }

      setArchiveError("Couldn't archive the customer. Please try again.");
      setIsArchiving(false);
    } catch {
      setArchiveError("Couldn't archive the customer. Please try again.");
      setIsArchiving(false);
    }
  }, [id, refetch]);

  const handleUnarchive = useCallback(async (): Promise<void> => {
    setIsUnarchiving(true);
    setUnarchiveError(null);
    try {
      const res = await fetch(`/api/admin/customers/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'unarchive' }),
      });
      const json = await res.json().catch(() => ({ success: false }));
      if (res.ok && json.success) {
        refetch();
      } else {
        setUnarchiveError("Couldn't unarchive the customer. Please try again.");
      }
    } catch {
      setUnarchiveError("Couldn't unarchive the customer. Please try again.");
    } finally {
      setIsUnarchiving(false);
    }
  }, [id, refetch]);

  // Opens the erase confirmation and loads the sibling disclosure (SPEC §5.1):
  // other rows in the org sharing this contact's email or phone. Informational
  // only — a failed lookup does not block the confirm dialog or the erase
  // itself, it just leaves the "also on this contact" list empty.
  const handleOpenEraseConfirm = useCallback(async (): Promise<void> => {
    setEraseError(null);
    setEraseSiblings([]);
    setShowEraseConfirm(true);
    setIsLoadingSiblings(true);

    try {
      const res = await fetch(`/api/admin/customers/${id}/erase`);
      const json = await res.json().catch(() => ({ success: false }));
      if (res.ok && json.success) {
        setEraseSiblings(json.data.siblings ?? []);
      }
    } catch {
      // Non-blocking — see comment above.
    } finally {
      setIsLoadingSiblings(false);
    }
  }, [id]);

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

      setEraseError(
        res.status === 403
          ? 'Only a super admin can erase customer data.'
          : "Couldn't erase the customer's data. Please try again.",
      );
      setIsErasing(false);
    } catch {
      setEraseError("Couldn't erase the customer's data. Please try again.");
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
        setEquipmentDeleteError("Couldn't delete the equipment. Please try again.");
      }
    } catch {
      setEquipmentDeleteError("Couldn't delete the equipment. Please try again.");
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
        {/* Back link + title row */}
        <div className="space-y-2">
          <Skeleton className="h-4 w-24" />
          <div className="flex items-center justify-between gap-4">
            <Skeleton className="h-8 w-56" />
            <div className="flex gap-2">
              <Skeleton className="h-9 w-16 rounded-md" />
              <Skeleton className="h-9 w-9 rounded-md" />
            </div>
          </div>
          <Skeleton className="h-4 w-40" />
        </div>
        {/* Contact info card */}
        <Skeleton className="h-36 w-full rounded-xl" />
        {/* These sections need only the id from the URL, so they load alongside
            the profile, not after it. The keys match the loaded page below, so
            React keeps them (and their fetched data) when the profile arrives. */}
        <CustomerBookingsSection key="bookings" customerId={id} />
        <LocationsSection key="locations" customerId={id} />
        <ContactsSection key="contacts" customerId={id} />
        <CustomerMembershipCard key="membership" customerId={id} />
        <CustomerEstimatesCard key={`estimates-${id}`} customerId={id} />
        <CustomerInvoicesCard key={`invoices-${id}`} customerId={id} />
      </PageShell>
    );
  }

  if (error || !customer) {
    return (
      <PageShell>
        <EmptyState
          icon={Building2}
          title={error ? "Couldn't load this customer" : 'Customer not found'}
          description={error ?? 'This customer may have been deleted or archived.'}
          action={
            <Link href="/admin/customers">
              <Button variant="outline">Back to customers</Button>
            </Link>
          }
        />
      </PageShell>
    );
  }

  return (
    <PageShell>
      {/* Header */}
      <PageHeader
        back={{ href: '/admin/customers', label: 'Customers' }}
        title={customerNameLabel(customer.name)}
        subtitle={`Customer since ${formatDate(customer.customerSince)} · ${
          customerActivity(customer).label
        }`}
        actions={
          <>
            {/* Type + tax-exempt badges. Residential is the column default (every
                FieldPulse import got it, churches and schools included), so
                only the deliberate Commercial mark is shown. */}
            {customer.customerType === 'commercial' && (
              <Badge variant="outline" className="bg-info-light text-info border-info/30">
                Commercial
              </Badge>
            )}
            {customer.isTaxExempt === true && (
              <Badge variant="outline" className="bg-warning-light text-warning border-warning/30">
                Tax-exempt
              </Badge>
            )}
            {customer.phone && (
              <a
                href={`tel:${customer.phone}`}
                className="inline-flex h-[30px] items-center gap-1.5 rounded-[4.8px] max-sm:min-h-11 border border-input bg-surface-raised px-2.5 text-sm font-medium transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Phone className="size-4" />
                Call
              </a>
            )}
            {customer.email && (
              <a
                href={`mailto:${customer.email}`}
                className="inline-flex h-[30px] items-center gap-1.5 rounded-[4.8px] max-sm:min-h-11 border border-input bg-surface-raised px-2.5 text-sm font-medium transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Mail className="size-4" />
                Email
              </a>
            )}
            <Button variant="outline" onClick={() => setShowEditForm(true)}>
              <Pencil className="size-4" />
              Edit
            </Button>
            {/* Destructive actions in overflow menu */}
            <DropdownMenu>
              <DropdownMenuTrigger
                className="inline-flex size-[30px] max-sm:min-h-11 max-sm:min-w-11 items-center justify-center rounded-[4.8px] border border-input bg-surface-raised text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
                aria-label="More actions"
              >
                <MoreHorizontal className="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {customer.archivedAt ? (
                  <DropdownMenuItem
                    disabled={isUnarchiving}
                    onClick={() => {
                      void handleUnarchive();
                    }}
                  >
                    <ArchiveRestore className="size-4" />
                    Unarchive customer
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem
                    onClick={() => {
                      setArchiveError(null);
                      setShowArchiveConfirm(true);
                    }}
                  >
                    <Archive className="size-4" />
                    Archive customer
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onClick={() => {
                    setDeleteError(null);
                    setShowDeleteConfirm(true);
                  }}
                >
                  <Trash2 className="size-4" />
                  Delete customer
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onClick={() => {
                    void handleOpenEraseConfirm();
                  }}
                >
                  <ShieldX className="size-4" />
                  Erase data (GDPR)
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      />

      {customer.archivedAt && (
        <div
          role="status"
          className="flex flex-wrap items-center gap-3 rounded-md border border-warning/30 bg-warning-light px-3 py-2.5 text-[13px] leading-5"
        >
          <Archive className="size-4 shrink-0 text-warning" aria-hidden />
          <div className="min-w-[12rem] flex-1">
            <p className="font-medium text-foreground">
              Archived on {formatDate(customer.archivedAt)}
            </p>
            <p className={unarchiveError ? 'text-destructive' : 'text-muted-foreground'}>
              {unarchiveError ??
                'Hidden from the customer list. Their records are kept; unarchive to bring them back.'}
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={isUnarchiving}
            onClick={() => {
              void handleUnarchive();
            }}
          >
            <ArchiveRestore className="size-3.5" />
            {isUnarchiving ? 'Unarchiving…' : 'Unarchive'}
          </Button>
        </div>
      )}

      <TagChipPicker entity="customer" entityId={customer.id} />

      {/* Contact info */}
      <SectionCard
        title="Contact information"
        icon={customer.customerType === 'commercial' ? Building2 : User}
      >
        <dl className="flex flex-col">
          {customer.phone && (
            <DetailRow
              label="Phone"
              value={
                <a href={`tel:${customer.phone}`} className="inline-flex text-link hover:underline max-sm:min-h-11 max-sm:items-center">
                  {formatPhoneDisplay(customer.phone)}
                </a>
              }
              mono
            />
          )}
          {customer.email && (
            <DetailRow
              label="Email"
              value={
                <a href={`mailto:${customer.email}`} className="inline-flex max-w-full text-link [overflow-wrap:anywhere] hover:underline max-sm:min-h-11 max-sm:items-center">
                  {customer.email}
                </a>
              }
            />
          )}
          {customer.address && (
            <DetailRow label="Service address" value={formatAddressDisplay(customer.address)} />
          )}
          {customer.propertyType && (
            <DetailRow
              label="Property type"
              value={`${humanizeCode(customer.propertyType)}${customer.propertySqft ? ` (${customer.propertySqft.toLocaleString('en-US')} sq ft)` : ''}`}
            />
          )}
          {/* Billing address — only when present and different from service address */}
          {customer.billingAddress &&
            formatAddressDisplay(customer.billingAddress) !== formatAddressDisplay(customer.address) && (
              <DetailRow label="Billing address" value={formatAddressDisplay(customer.billingAddress)} />
            )}
        </dl>
        {!customer.phone && !customer.email && !customer.address && !customer.billingAddress && (
          <p className="text-sm text-muted-foreground">
            No phone, email or address on file. Use Edit to add them.
          </p>
        )}
      </SectionCard>

      {/* Bookings — real service_requests (service_history is empty for imports).
          High on the page: "what did you do last time?" is the first question
          on a call. */}
      <CustomerBookingsSection key="bookings" customerId={id} />

      {/* Service locations (hidden when none are recorded) */}
      <LocationsSection key="locations" customerId={id} />

      <ContactsSection key="contacts" customerId={id} />

      {/* FieldPulse details — collapsed panel (custom fields + structured data) */}
      <FieldpulseDetails
        data={customer.fieldpulseData}
        customFields={customer.fieldpulseCustomFields}
      />

      {/* Membership */}
      <CustomerMembershipCard key="membership" customerId={id} />

      {/* Customer self-service portal link */}
      <PortalLinkCard
        customerId={id}
        portalActive={customer.portalActive}
        onChanged={refetch}
      />

      {/* Equipment */}
      <SectionCard
        title="Equipment"
        icon={Wrench}
        count={customer.equipmentCount}
        action={
          <Button size="sm" variant="outline" onClick={handleAddEquipment}>
            <Plus className="mr-1 size-3" />
            Add
          </Button>
        }
      >
        {customer.equipment.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No equipment registered yet.
          </p>
        ) : (
          <div className="space-y-3">
            {customer.equipment.map((eq) => (
              <div
                key={eq.id}
                id={`equipment-${eq.id}`}
                className={`rounded-lg border bg-muted/20 p-3 ${eq.retiredAt ? 'opacity-60' : ''}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="flex items-center gap-1.5 text-sm font-medium">
                    {equipmentTypeLabel(eq.equipmentType)}
                    {eq.fieldpulseAssetId && (
                      <SyncPill source="fieldpulse" size="md" />
                    )}
                  </p>
                  <div className="flex items-center gap-1">
                    {eq.warrantyExpiration && (
                      <Badge
                        variant="outline"
                        className={
                          new Date(eq.warrantyExpiration) < new Date()
                            ? 'bg-danger-light text-danger border-danger/30 text-xs'
                            : 'bg-warning-light text-warning border-warning/30 text-xs'
                        }
                      >
                        {warrantyStatusLabel(eq.warrantyExpiration)}
                      </Badge>
                    )}
                    {/* A replaced unit is history: no Edit; Delete keeps its confirm. */}
                    {equipmentRowActions(eq).edit && (
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        onClick={() => handleEditEquipment(eq)}
                        aria-label="Edit equipment"
                      >
                        <Pencil className="size-3.5" />
                      </Button>
                    )}
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
                <p className="mt-1 text-xs text-muted-foreground break-words">
                  {equipmentDetailsLine(eq)}
                </p>
                {eq.retiredAt && (
                  <p className="text-xs text-muted-foreground">
                    {replacedOnLabel(eq.retiredAt)}
                    {eq.replacedByEquipmentId && (
                      <>
                        {' · '}
                        <a href={`#equipment-${eq.replacedByEquipmentId}`} className="text-link underline-offset-2 hover:underline">
                          See the replacement
                        </a>
                      </>
                    )}
                  </p>
                )}
                {eq.locationInHome && (
                  <p className="text-xs text-muted-foreground">
                    Location: {eq.locationInHome}
                  </p>
                )}
                {(eq.installDate || eq.warrantyExpiration) && (
                  <p className="text-xs text-muted-foreground">
                    {[
                      eq.installDate ? `Installed ${formatDate(eq.installDate)}` : null,
                      eq.warrantyExpiration
                        ? `Warranty until ${formatDate(eq.warrantyExpiration)}`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </SectionCard>

      {/* Service history (native manual work logs; hidden when empty — imports
          have no native history; real history is in the Bookings card above) */}
      {customer.serviceHistory.length > 0 && (
        <SectionCard title="Service history" icon={Clock} count={customer.serviceHistory.length}>
          <div className="space-y-3">
            {customer.serviceHistory.map((h) => (
              <div key={h.id} className="rounded-lg border bg-muted/20 p-3">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium">
                    {h.referenceNumber ?? 'Manual entry'}
                  </p>
                  <span className="text-xs text-muted-foreground">
                    {formatDate(h.createdAt)}
                  </span>
                </div>
                {h.issueType && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {issueTypeLabel(h.issueType)}
                  </p>
                )}
                {h.workPerformed && (
                  <p className="mt-1 text-sm">{h.workPerformed}</p>
                )}
                {h.cost !== null && h.cost !== undefined && (
                  <p className="mt-1 text-sm font-medium">
                    {formatCentsExact(h.cost)}
                  </p>
                )}
              </div>
            ))}
          </div>
        </SectionCard>
      )}

      {/* Estimates */}
      <CustomerEstimatesCard key={`estimates-${id}`} customerId={id} />

      {/* Invoices */}
      <CustomerInvoicesCard key={`invoices-${id}`} customerId={id} />

      {/* Notes */}
      <SectionCard
        title="Notes"
        icon={StickyNote}
        count={customer.customerNotes.length}
        action={
          <Button size="sm" variant="outline" onClick={() => setShowNoteForm(true)}>
            <Plus className="mr-1 size-3" />
            Add note
          </Button>
        }
      >
        {customer.customerNotes.length === 0 ? (
          <p className="text-sm text-muted-foreground">No notes yet.</p>
        ) : (
          <div className="space-y-3">
            {customer.customerNotes.map((n) => (
              <div key={n.id} className="rounded-lg border bg-muted/20 p-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <Badge variant="outline" className="text-xs">
                      {noteTypeLabel(n.noteType)}
                    </Badge>
                    {n.fieldpulseCommentId && (
                      <SyncPill source="fieldpulse" size="md" />
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
      </SectionCard>

      {/* Follow-ups */}
      <SectionCard
        title="Follow-ups"
        icon={Bell}
        count={customer.followUps.length}
        action={
          <Button size="sm" variant="outline" onClick={() => setShowFollowUpForm(true)}>
            <Plus className="mr-1 size-3" />
            Add
          </Button>
        }
      >
        {followUpError && (
          <p role="alert" className="mb-2 text-sm text-destructive">
            {followUpError}
          </p>
        )}
        {customer.followUps.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No follow-ups scheduled.
          </p>
        ) : (
          <div className="space-y-3">
            {customer.followUps.map((f) => (
              <div key={f.id} className="flex flex-wrap items-center gap-3 rounded-lg border bg-muted/20 p-3">
                {f.status === 'completed' ? (
                  <CheckCircle className="size-4 text-success" />
                ) : (
                  <Clock className="size-4 text-muted-foreground" />
                )}
                <div className="min-w-[10rem] flex-1">
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
                    {completingId === f.id ? 'Saving…' : 'Complete'}
                  </Button>
                )}
                <StatusBadge status={f.status} />
              </div>
            ))}
          </div>
        )}
      </SectionCard>

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
        confirmingLabel="Archiving…"
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
        confirmingLabel="Deleting…"
        isConfirming={isDeleting}
        error={deleteError}
        onConfirm={handleDelete}
      />

      <Dialog
        open={showEraseConfirm}
        onOpenChange={(open) => {
          if (!isErasing) setShowEraseConfirm(open);
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Erase customer data (GDPR)?</DialogTitle>
            <DialogDescription>
              This permanently anonymizes the customer: their name, contact
              details, address, chat messages, notes, attachments, and
              signatures are erased and cannot be recovered. De-identified
              financial records (invoices, payments) are kept for accounting.
              This action is terminal.
            </DialogDescription>
          </DialogHeader>

          {isLoadingSiblings && (
            <p className="text-sm text-muted-foreground">
              Checking for other rows on this contact…
            </p>
          )}

          {!isLoadingSiblings && eraseSiblings.length > 0 && (
            <div className="rounded-md border bg-muted/20 p-3 text-sm">
              <p className="font-medium">
                Also on this contact ({eraseSiblings.length}{' '}
                other {eraseSiblings.length === 1 ? 'row' : 'rows'}):
              </p>
              <ul className="mt-1 list-disc space-y-0.5 pl-4 text-muted-foreground">
                {eraseSiblings.slice(0, MAX_SIBLINGS_SHOWN).map((sibling) => (
                  <li key={sibling.id}>{customerNameLabel(sibling.name)}</li>
                ))}
                {eraseSiblings.length > MAX_SIBLINGS_SHOWN && (
                  <li>
                    +{eraseSiblings.length - MAX_SIBLINGS_SHOWN} more…
                  </li>
                )}
              </ul>
              <p className="mt-2 text-xs text-muted-foreground">
                Erasing this customer does not affect them. A shared email or
                phone is usually a different customer — review each row and
                erase it separately only if it is the same person.
              </p>
            </div>
          )}

          {eraseError && <p className="text-sm text-destructive">{eraseError}</p>}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setShowEraseConfirm(false)}
              disabled={isErasing}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={handleErase}
              disabled={isErasing}
            >
              {isErasing ? 'Erasing…' : 'Erase permanently'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
        confirmingLabel="Deleting…"
        isConfirming={isDeletingEquipment}
        error={equipmentDeleteError}
        onConfirm={handleDeleteEquipment}
      />
    </PageShell>
  );
}
