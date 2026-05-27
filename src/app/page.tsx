import Link from 'next/link';
import { ArrowRight, Thermometer } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function Home() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-4 text-center">
      <div className="flex max-w-md flex-col items-center gap-6">
        <Thermometer className="size-16 text-primary" strokeWidth={1.5} />

        <div className="flex flex-col gap-2">
          <h1 className="text-4xl font-bold tracking-tight">
            Need HVAC Help?
          </h1>
          <p className="text-lg text-muted-foreground">
            Our AI assistant can help diagnose your issue and schedule a service
            visit.
          </p>
        </div>

        <Button
          size="lg"
          className="bg-orange-500 hover:bg-orange-600 text-white"
          render={<Link href="/chat" />}
        >
          Get Help Now
          <ArrowRight className="size-4" data-icon="inline-end" />
        </Button>

        <p className="text-sm text-muted-foreground">
          Available 24/7 &mdash; typical response within 2 hours
        </p>
      </div>
    </main>
  );
}
