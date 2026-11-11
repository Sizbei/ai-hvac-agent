import { notFound } from 'next/navigation';
import { getViewerContext } from '@/lib/auth/viewer';
import { seesPlatformUi } from '@/lib/admin/preview-view';
import { FieldpulseImportBoard } from '@/components/admin/fp-import/fieldpulse-import-board';

/**
 * FieldPulse import progress board: an operator tool, so platform users only
 * (not while a "View as" preview is on). Everyone else gets the in-shell 404,
 * and the status API keeps its own platform gate.
 */
export default async function FieldpulseImportPage() {
  const viewer = await getViewerContext();
  if (!viewer || !seesPlatformUi(viewer)) {
    notFound();
  }
  return <FieldpulseImportBoard />;
}
