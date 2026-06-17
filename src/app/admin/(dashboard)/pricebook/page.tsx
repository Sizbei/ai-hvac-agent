'use client';

import { useState } from 'react';
import { Plus, AlertCircle } from 'lucide-react';
import { usePricebook } from '@/hooks/use-pricebook';
import { PricebookTable } from '@/components/admin/pricebook/pricebook-table';
import { PricebookFormDialog } from '@/components/admin/pricebook/pricebook-form-dialog';
import { TaxRatesPanel } from '@/components/admin/pricebook/tax-rates-panel';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Separator } from '@/components/ui/separator';
import { PageShell } from '@/components/admin/ui/page-shell';
import { PageHeader } from '@/components/admin/ui/page-header';
import type { PricebookItem } from '@/hooks/use-pricebook';

export default function PricebookPage() {
  const { items, taxRates, isLoading, error, refetch } = usePricebook();
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<PricebookItem | null>(null);

  function handleAddClick(): void {
    setEditing(null);
    setFormOpen(true);
  }

  function handleEditClick(item: PricebookItem): void {
    setEditing(item);
    setFormOpen(true);
  }

  async function handleDeactivate(item: PricebookItem): Promise<void> {
    const res = await fetch(`/api/admin/pricebook/${item.id}`, {
      method: 'DELETE',
    });
    if (res.ok) void refetch();
  }

  return (
    <PageShell>
      <PageHeader
        title="Pricebook"
        subtitle="Manage priced services, materials, equipment, and tax rates."
        actions={
          <Button onClick={handleAddClick}>
            <Plus className="mr-2 h-4 w-4" />
            Add Item
          </Button>
        }
      />

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <PricebookTable
        items={items}
        isLoading={isLoading}
        onEdit={handleEditClick}
        onDeactivate={(item) => void handleDeactivate(item)}
      />

      <Separator />

      <TaxRatesPanel
        taxRates={taxRates}
        isLoading={isLoading}
        onChanged={() => void refetch()}
      />

      <PricebookFormDialog
        open={formOpen}
        onClose={() => setFormOpen(false)}
        onSuccess={() => void refetch()}
        editing={editing}
      />
    </PageShell>
  );
}
