import { notFound, redirect } from 'next/navigation';
import { FormFillClient } from '@/components/tech/forms/form-fill-client';
import { isUuid } from '@/lib/validation/uuid';

/**
 * The fill page (M3d spec §7.3): `?visit=<aid>` is required (without it, the job page); `&from=<aid>`
 * marks a read-only look at another visit's answers (its back link returns to
 * `from`). Next.js 16: params and searchParams are Promises.
 */
export default async function TechFormFillPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ id: string; formId: string }>;
  readonly searchParams: Promise<{ visit?: string | string[]; from?: string | string[] }>;
}) {
  const { id, formId } = await params;
  const { visit, from } = await searchParams;
  if (!isUuid(id) || !isUuid(formId)) notFound();
  // No (or a bad) visit: the job page picks the visit and lists its forms.
  if (typeof visit !== 'string' || !isUuid(visit)) redirect(`/tech/jobs/${id.toLowerCase()}`);
  const fromVisit = typeof from === 'string' && isUuid(from) ? from.toLowerCase() : null;
  const f = formId.toLowerCase();
  const v = visit.toLowerCase();
  // Keyed: `View visit #1's answers` and its Back stay on this route with other params; a fresh
  // instance per form, visit and `from` keeps refs and the submit intent from leaking across visits.
  return <FormFillClient key={`${f}:${v}:${fromVisit ?? ''}`} jobId={id} formId={f} visitId={v} from={fromVisit} />;
}
