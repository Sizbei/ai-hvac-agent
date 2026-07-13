'use client';

import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAdminTechnicians } from '@/hooks/use-admin-technicians';
import type { RequestSortKey } from '@/lib/admin/types';

const SORT_OPTIONS: ReadonlyArray<{ readonly value: RequestSortKey; readonly label: string }> = [
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'urgency', label: 'Urgency' },
];

interface RequestFiltersProps {
  readonly currentStatus: string;
  readonly onStatusChange: (status: string) => void;
  readonly currentUrgency: string;
  readonly onUrgencyChange: (urgency: string) => void;
  readonly currentAssignedTo: string;
  readonly onAssignedToChange: (techId: string) => void;
  readonly isAfterHours: boolean;
  readonly onAfterHoursChange: (value: boolean) => void;
  readonly currentSort: RequestSortKey;
  readonly onSortChange: (sort: RequestSortKey) => void;
}

const STATUS_OPTIONS: readonly { readonly label: string; readonly value: string }[] = [
  { label: 'All', value: '' },
  { label: 'Pending', value: 'pending' },
  { label: 'Scheduled', value: 'scheduled' },
  { label: 'Assigned', value: 'assigned' },
  { label: 'In Progress', value: 'in_progress' },
  { label: 'On Hold', value: 'on_hold' },
  { label: 'Completed', value: 'completed' },
  { label: 'Cancelled', value: 'cancelled' },
];

const URGENCY_OPTIONS: readonly { readonly label: string; readonly value: string }[] = [
  { label: 'All urgencies', value: '' },
  { label: 'Low', value: 'low' },
  { label: 'Medium', value: 'medium' },
  { label: 'High', value: 'high' },
  { label: 'Emergency', value: 'emergency' },
];

export function RequestFilters({
  currentStatus,
  onStatusChange,
  currentUrgency,
  onUrgencyChange,
  currentAssignedTo,
  onAssignedToChange,
  isAfterHours,
  onAfterHoursChange,
  currentSort,
  onSortChange,
}: RequestFiltersProps) {
  const { technicians } = useAdminTechnicians();

  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* Status chips */}
      {STATUS_OPTIONS.map((option) => {
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

      {/* Urgency selector */}
      <Select
        value={currentUrgency}
        onValueChange={(v) => onUrgencyChange(v ?? '')}
      >
        <SelectTrigger aria-label="Filter by urgency" className="w-[150px]">
          <SelectValue placeholder="All urgencies" />
        </SelectTrigger>
        <SelectContent>
          {URGENCY_OPTIONS.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Technician dropdown */}
      <Select
        value={currentAssignedTo}
        onValueChange={(v) => onAssignedToChange(v ?? '')}
      >
        <SelectTrigger aria-label="Filter by technician" className="w-[180px]">
          <SelectValue placeholder="All technicians" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="">All technicians</SelectItem>
          {technicians.map((tech) => (
            <SelectItem key={tech.id} value={tech.id}>
              {tech.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Sort selector */}
      <Select
        value={currentSort}
        onValueChange={(v) => onSortChange(v as RequestSortKey)}
      >
        <SelectTrigger aria-label="Sort requests" className="w-[150px]">
          <SelectValue placeholder="Newest first" />
        </SelectTrigger>
        <SelectContent>
          {SORT_OPTIONS.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* After-hours toggle */}
      <Button
        variant={isAfterHours ? 'default' : 'outline'}
        size="sm"
        onClick={() => onAfterHoursChange(!isAfterHours)}
      >
        After Hours
      </Button>
    </div>
  );
}
