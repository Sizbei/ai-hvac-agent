import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Chat',
  // The embed is framed by the contractor's site; don't let search engines
  // index the bare panel.
  robots: { index: false, follow: false },
};

/**
 * Layout for the embeddable chat panel (rendered inside the widget iframe).
 * Deliberately minimal — the panel itself (full-height) fills the iframe; the
 * root layout already provides <html>/<body>.
 */
export default function EmbedLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return <>{children}</>;
}
