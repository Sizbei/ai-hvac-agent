import { redirect } from 'next/navigation';

/**
 * The standalone Technicians screen has been superseded by the unified Staff
 * screen (/admin/staff), which manages both admins and technicians with the
 * full set of controls (roles, last-admin guard, password reset). This route
 * is kept only as a permanent redirect so old bookmarks/links don't 404.
 */
export default function TechniciansPage() {
  redirect('/admin/staff');
}
