'use client';

import { useState } from 'react';
import { UserPlus, AlertCircle } from 'lucide-react';
import { useAdminTechnicians } from '@/hooks/use-admin-technicians';
import { TechnicianTable } from '@/components/admin/technician-table';
import { TechnicianFormDialog } from '@/components/admin/technician-form-dialog';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import type { TechnicianRecord } from '@/lib/admin/types';

export default function TechniciansPage() {
  const { technicians, isLoading, error, refetch } = useAdminTechnicians();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingTech, setEditingTech] = useState<TechnicianRecord | null>(null);

  function handleAddClick(): void {
    setEditingTech(null);
    setDialogOpen(true);
  }

  function handleEditClick(tech: TechnicianRecord): void {
    setEditingTech(tech);
    setDialogOpen(true);
  }

  function handleDialogSuccess(): void {
    void refetch();
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Technicians</h1>
        <Button onClick={handleAddClick}>
          <UserPlus className="mr-2 h-4 w-4" />
          Add Technician
        </Button>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <TechnicianTable
        technicians={technicians}
        isLoading={isLoading}
        onEdit={handleEditClick}
      />

      <TechnicianFormDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onSuccess={handleDialogSuccess}
        technician={editingTech}
      />
    </div>
  );
}
