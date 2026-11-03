import type { Metadata } from 'next';
import { SetupPageClient } from '@/components/admin/setup/setup-page-client';

export const metadata: Metadata = { title: 'Setup guide · Spears Admin' };

export default function SetupPage() {
  return <SetupPageClient />;
}
