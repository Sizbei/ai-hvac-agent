import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Chat - HVAC Assistant',
};

export default function ChatLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return <>{children}</>;
}
