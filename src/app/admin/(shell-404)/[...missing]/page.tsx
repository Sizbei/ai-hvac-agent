import { notFound } from 'next/navigation';

/**
 * Any /admin URL no page matches renders the in-shell 404 (sidebar and all)
 * instead of the bare site-wide one.
 */
export default function MissingAdminPage(): never {
  notFound();
}
