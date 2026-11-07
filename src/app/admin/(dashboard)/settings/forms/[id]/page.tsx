import { notFound } from 'next/navigation';
import { FormBuilderClient } from '@/components/admin/forms/form-builder-client';
import { isUuid } from '@/lib/validation/uuid';

/**
 * The office form builder (M3d spec §7.1). `/admin/settings/forms/new` is this
 * page with no row: nothing is inserted until the first valid Save. Next.js 16:
 * params is a Promise.
 */
export default async function FormBuilderPage({ params }: { readonly params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (id !== 'new' && !isUuid(id)) notFound();
  return <FormBuilderClient formId={id === 'new' ? null : id.toLowerCase()} />;
}
