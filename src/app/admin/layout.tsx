import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Admin - HVAC Dashboard',
};

export default function AdminLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return <>{children}</>;
}
