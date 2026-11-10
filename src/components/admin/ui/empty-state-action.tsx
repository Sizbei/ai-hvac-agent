import Link from 'next/link';
import { Button, buttonVariants } from '@/components/ui/button';
import type { EmptyAction } from '@/lib/admin/empty-state-actions';

/** Renders an `emptyActionFor` result as the empty state's single primary action. */
export function EmptyStateAction({
  action,
  onCallback,
}: {
  readonly action: EmptyAction | null;
  readonly onCallback?: () => void;
}) {
  if (!action) return null;
  if (action.kind === 'link') {
    return (
      <Link href={action.href} className={buttonVariants({ size: 'sm' })}>
        {action.label}
      </Link>
    );
  }
  if (!onCallback) return null;
  return (
    <Button size="sm" onClick={onCallback}>
      {action.label}
    </Button>
  );
}
