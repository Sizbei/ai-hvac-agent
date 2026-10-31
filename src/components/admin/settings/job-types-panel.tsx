'use client';

import { useCallback, useEffect, useState } from 'react';
import { Plus, Loader2, AlertCircle } from 'lucide-react';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import { jobTypeValues, urgencyValues } from '@/lib/ai/extraction-schema';
import { JOB_TYPE_LABELS, URGENCY_LABELS } from '@/lib/admin/create-request';
import type {
  JobTypeRecord,
  JobTypeInput,
  JobTypePatch,
} from '@/lib/admin/job-type-types';

const DUPLICATE_COPY = 'A job type with that name already exists.';
const LIMIT_COPY = 'You can have at most 100 job types.';
const GENERIC_COPY = "Couldn't save the job type. Please try again.";

const KIND_ITEMS = jobTypeValues.map((v) => ({ value: v, label: JOB_TYPE_LABELS[v] }));
const PRIORITY_ITEMS = urgencyValues.map((v) => ({ value: v, label: URGENCY_LABELS[v] }));

type SaveResult =
  | { readonly ok: true; readonly jobType: JobTypeRecord }
  | { readonly ok: false; readonly message: string };

async function send(
  url: string,
  method: 'POST' | 'PATCH',
  payload: JobTypeInput | JobTypePatch,
): Promise<SaveResult> {
  try {
    const res = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (res.status === 409) {
      const json = (await res.json().catch(() => null)) as
        | { error?: { code?: string } }
        | null;
      if (json?.error?.code === 'DUPLICATE_NAME') {
        return { ok: false, message: DUPLICATE_COPY };
      }
      if (json?.error?.code === 'LIMIT_REACHED') {
        return { ok: false, message: LIMIT_COPY };
      }
      return { ok: false, message: GENERIC_COPY };
    }
    if (!res.ok) return { ok: false, message: GENERIC_COPY };
    const json = (await res.json()) as { data?: { jobType?: JobTypeRecord } };
    if (!json.data?.jobType) return { ok: false, message: GENERIC_COPY };
    return { ok: true, jobType: json.data.jobType };
  } catch {
    return { ok: false, message: GENERIC_COPY };
  }
}

interface RowProps {
  readonly jobType: JobTypeRecord;
  readonly onSaved: (jobType: JobTypeRecord) => void;
  readonly onError: (message: string | null) => void;
}

function JobTypeRow({ jobType, onSaved, onError }: RowProps) {
  const [name, setName] = useState(jobType.name);
  const [duration, setDuration] = useState(String(jobType.defaultDurationMinutes));
  const [position, setPosition] = useState(String(jobType.position));
  const [saving, setSaving] = useState(false);

  async function save(patch: JobTypePatch): Promise<void> {
    setSaving(true);
    const result = await send(
      `/api/admin/settings/job-types/${jobType.id}`,
      'PATCH',
      patch,
    );
    setSaving(false);
    if (result.ok) {
      onError(null);
      onSaved(result.jobType);
      setName(result.jobType.name);
      setDuration(String(result.jobType.defaultDurationMinutes));
      setPosition(String(result.jobType.position));
    } else {
      onError(result.message);
      setName(jobType.name);
      setDuration(String(jobType.defaultDurationMinutes));
      setPosition(String(jobType.position));
    }
  }

  function commitName(): void {
    const trimmed = name.trim();
    if (trimmed === jobType.name) return setName(jobType.name);
    void save({ name: trimmed });
  }

  function commitDuration(): void {
    const n = Number(duration);
    if (n === jobType.defaultDurationMinutes) return;
    void save({ defaultDurationMinutes: n });
  }

  function commitPosition(): void {
    const n = Number(position);
    if (n === jobType.position) return;
    void save({ position: n });
  }

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-0 border-b py-2 last:border-b-0">
      <Input
        aria-label="Name"
        className="min-w-40 flex-1"
        value={name}
        maxLength={80}
        onChange={(e) => setName(e.target.value)}
        onBlur={commitName}
      />
      <Select
        items={KIND_ITEMS}
        value={jobType.kind}
        onValueChange={(v) => v && v !== jobType.kind && void save({ kind: v as JobTypeRecord['kind'] })}
      >
        <SelectTrigger aria-label="Kind" className="w-40">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {KIND_ITEMS.map((o) => (
            <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Input
        aria-label="Default duration in minutes"
        type="number"
        step={15}
        min={15}
        max={1440}
        className="w-24 font-mono"
        value={duration}
        onChange={(e) => setDuration(e.target.value)}
        onBlur={commitDuration}
      />
      <Select
        items={PRIORITY_ITEMS}
        value={jobType.defaultPriority}
        onValueChange={(v) => v && v !== jobType.defaultPriority && void save({ defaultPriority: v as JobTypeRecord['defaultPriority'] })}
      >
        <SelectTrigger aria-label="Default priority" className="w-32">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {PRIORITY_ITEMS.map((o) => (
            <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Input
        aria-label="Position"
        type="number"
        min={0}
        max={999}
        className="w-16"
        value={position}
        onChange={(e) => setPosition(e.target.value)}
        onBlur={commitPosition}
      />
      <Switch
        aria-label="Active"
        checked={jobType.active}
        disabled={saving}
        onCheckedChange={(checked) => void save({ active: checked })}
      />
      <span className="size-4">
        {saving && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
      </span>
    </div>
  );
}

export function JobTypesPanel() {
  const [jobTypes, setJobTypes] = useState<readonly JobTypeRecord[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [newName, setNewName] = useState('');
  const [newKind, setNewKind] = useState<JobTypeRecord['kind']>('service_call');
  const [newDuration, setNewDuration] = useState('60');
  const [newPriority, setNewPriority] = useState<JobTypeRecord['defaultPriority']>('medium');
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/admin/settings/job-types');
        if (!res.ok) throw new Error('bad status');
        const json = (await res.json()) as { data?: { jobTypes?: JobTypeRecord[] } };
        if (!cancelled) setJobTypes(json.data?.jobTypes ?? []);
      } catch {
        if (!cancelled) setLoadFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSaved = useCallback((saved: JobTypeRecord) => {
    setJobTypes((prev) =>
      prev
        ? [...prev.map((j) => (j.id === saved.id ? saved : j))].sort(
            (a, b) => a.position - b.position || a.name.localeCompare(b.name),
          )
        : prev,
    );
  }, []);

  async function handleAdd(): Promise<void> {
    setAdding(true);
    const result = await send('/api/admin/settings/job-types', 'POST', {
      name: newName.trim(),
      kind: newKind,
      defaultDurationMinutes: Number(newDuration),
      defaultPriority: newPriority,
    });
    setAdding(false);
    if (result.ok) {
      setError(null);
      setJobTypes((prev) => [...(prev ?? []), result.jobType]);
      setNewName('');
    } else {
      setError(result.message);
    }
  }

  const canAdd = newName.trim().length > 0 && Number(newDuration) >= 15;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Job types</CardTitle>
        <CardDescription>
          The kinds of work you book, with a default duration and priority.
          Turning one off hides it from the picker but keeps existing requests.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <Alert variant="destructive">
            <AlertCircle className="size-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {loadFailed ? (
          <p className="text-sm text-muted-foreground">
            Couldn&apos;t load job types. Refresh to try again.
          </p>
        ) : jobTypes === null ? (
          <div className="space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : (
          <div>
            <div
              aria-hidden
              className="hidden flex-wrap items-center gap-x-2 pb-1 text-[12px] sm:flex text-muted-foreground"
            >
              <span className="min-w-40 flex-1">Name</span>
              <span className="w-40">Kind</span>
              <span className="w-24">Minutes</span>
              <span className="w-32">Priority</span>
              <span className="w-16">Order</span>
              <span className="w-[32px]">Active</span>
              <span className="size-4" />
            </div>
            {jobTypes.map((jt) => (
              <JobTypeRow key={jt.id} jobType={jt} onSaved={handleSaved} onError={setError} />
            ))}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 border-t pt-4">
          <Input
            aria-label="New job type name"
            className="min-w-40 flex-1"
            placeholder="Add a job type"
            value={newName}
            maxLength={80}
            onChange={(e) => setNewName(e.target.value)}
          />
          <Select
            items={KIND_ITEMS}
            value={newKind}
            onValueChange={(v) => v && setNewKind(v as JobTypeRecord['kind'])}
          >
            <SelectTrigger aria-label="New job type kind" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {KIND_ITEMS.map((o) => (
                <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            aria-label="New job type default duration in minutes"
            type="number"
            step={15}
            min={15}
            max={1440}
            className="w-24 font-mono"
            value={newDuration}
            onChange={(e) => setNewDuration(e.target.value)}
          />
          <Select
            items={PRIORITY_ITEMS}
            value={newPriority}
            onValueChange={(v) => v && setNewPriority(v as JobTypeRecord['defaultPriority'])}
          >
            <SelectTrigger aria-label="New job type default priority" className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PRIORITY_ITEMS.map((o) => (
                <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button onClick={() => void handleAdd()} disabled={!canAdd || adding}>
            {adding ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
            Add
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
