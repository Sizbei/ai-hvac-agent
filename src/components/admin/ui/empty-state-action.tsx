import Link from 'next/link';
import { Button, buttonVariants } from '@/components/ui/button';
import type { EmptyAction } from '@/lib/admin/empty-state-actions';

/** Renders an `emptyActionFor` result as the empty state's action (outline when the header repeats it). */
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
      <Link href={action.href} className={buttonVariants({ size: 'sm', variant: action.variant })}>
        {action.label}
      </Link>
    );
  }
  if (!onCallback) return null;
  return (
    <Button size="sm" variant={action.variant} onClick={onCallback}>
      {action.label}
    </Button>
  );
}
