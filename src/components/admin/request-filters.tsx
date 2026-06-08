'use client';

import { Button } from '@/components/ui/button';

interface RequestFiltersProps {
  readonly currentStatus: string;
  readonly onStatusChange: (status: string) => void;
}

const FILTER_OPTIONS: readonly { readonly label: string; readonly value: string }[] = [
  { label: 'All', value: '' },
  { label: 'Pending', value: 'pending' },
  { label: 'Scheduled', value: 'scheduled' },
  { label: 'Assigned', value: 'assigned' },
  { label: 'In Progress', value: 'in_progress' },
  { label: 'On Hold', value: 'on_hold' },
  { label: 'Completed', value: 'completed' },
  { label: 'Cancelled', value: 'cancelled' },
];

export function RequestFilters({ currentStatus, onStatusChange }: RequestFiltersProps) {
  return (
    <div className="flex flex-wrap gap-2">
      {FILTER_OPTIONS.map((option) => {
        const isActive = currentStatus === option.value;
        return (
          <Button
            key={option.value}
            variant={isActive ? 'default' : 'outline'}
            size="sm"
            onClick={() => onStatusChange(option.value)}
          >
            {option.label}
          </Button>
        );
      })}
    </div>
  );
}
