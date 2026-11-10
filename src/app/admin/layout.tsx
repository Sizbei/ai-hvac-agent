import type { Metadata } from 'next';
import { ADMIN_TITLE_FALLBACK } from '@/lib/admin/admin-title';

export const metadata: Metadata = {
  title: ADMIN_TITLE_FALLBACK,
};

export default function AdminLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return <>{children}</>;
}
