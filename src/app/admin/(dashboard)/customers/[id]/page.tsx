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
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { useCustomerDetail } from '@/hooks/use-admin-customers';
import { EquipmentFormDialog } from '@/components/admin/equipment-form-dialog';
import { NoteFormDialog } from '@/components/admin/note-form-dialog';
import { ConfirmDialog } from '@/components/admin/confirm-dialog';

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

function StatusBadge({ status }: { readonly status: string }) {
  const colors: Record<string, string> = {
    pending: 'bg-yellow-100 text-yellow-800',
    completed: 'bg-green-100 text-green-800',
    overdue: 'bg-red-100 text-red-800',
    cancelled: 'bg-gray-100 text-gray-800',
  };
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${colors[status] ?? 'bg-gray-100 text-gray-800'}`}
    >
      {status}
    </span>
  );
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
  const [showNoteForm, setShowNoteForm] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

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

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (error || !customer) {
    return (
      <div className="py-12 text-center">
        <p className="text-muted-foreground">{error ?? 'Customer not found'}</p>
        <Link href="/admin/customers">
          <Button variant="outline" className="mt-4">
            Back to Customers
          </Button>
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Link href="/admin/customers">
          <Button variant="ghost" size="icon-sm">
            <ArrowLeft className="size-4" />
          </Button>
        </Link>
        <div className="flex-1">
          <h1 className="text-2xl font-bold tracking-tight">
            {customer.name ?? 'Unknown Customer'}
          </h1>
          <p className="text-sm text-muted-foreground">
            Customer since {formatDate(customer.createdAt)}
          </p>
        </div>
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

      {/* Equipment */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2 text-base">
              <Wrench className="size-4" />
              Equipment ({customer.equipment.length})
            </CardTitle>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setShowEquipmentForm(true)}
            >
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
                  <div className="flex items-center justify-between">
                    <p className="font-medium text-sm">
                      {EQUIPMENT_LABELS[eq.equipmentType] ?? eq.equipmentType}
                    </p>
                    {eq.warrantyExpiration && (
                      <Badge
                        variant={
                          new Date(eq.warrantyExpiration) < new Date()
                            ? 'destructive'
                            : 'outline'
                        }
                        className="text-xs"
                      >
                        Warranty:{' '}
                        {new Date(eq.warrantyExpiration) < new Date()
                          ? 'Expired'
                          : formatDate(eq.warrantyExpiration)}
                      </Badge>
                    )}
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
                    <Badge variant="outline" className="text-xs">
                      {n.noteType}
                    </Badge>
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
          <CardTitle className="flex items-center gap-2 text-base">
            <Bell className="size-4" />
            Follow-ups ({customer.followUps.length})
          </CardTitle>
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
                    <CheckCircle className="size-4 text-green-600" />
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
                  <StatusBadge status={f.status} />
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <EquipmentFormDialog
        open={showEquipmentForm}
        onOpenChange={setShowEquipmentForm}
        customerId={id}
        onSuccess={() => {
          setShowEquipmentForm(false);
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

      <ConfirmDialog
        open={showDeleteConfirm}
        onOpenChange={setShowDeleteConfirm}
        title="Delete customer?"
        description="This permanently deletes the customer along with their equipment, service history, notes, and follow-ups. This action cannot be undone."
        confirmLabel="Delete"
        isConfirming={isDeleting}
        error={deleteError}
        onConfirm={handleDelete}
      />
    </div>
  );
}
