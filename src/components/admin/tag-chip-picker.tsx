'use client';

import { useEffect, useMemo, useState } from 'react';
import { Plus, X, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import {
  TAG_COLOR_TOKENS,
  tagBadgeClass,
  type TagColor,
  type TagEntity,
  type TagTypeRecord,
} from '@/lib/admin/tag-types';

const SAVE_COPY = "Couldn't save tags. Please try again.";
const DUPLICATE_COPY = 'A tag with that name already exists for this type.';
const CREATE_COPY = "Couldn't create the tag. Please try again.";
const COLOR_ITEMS = TAG_COLOR_TOKENS.map((c) => ({ value: c, label: c.charAt(0).toUpperCase() + c.slice(1) }));

export interface TagChipPickerProps {
  readonly entity: TagEntity;
  /** Bound mode: PUTs on every change. Controlled mode (null): no network; value/onChange drive state. */
  readonly entityId: string | null;
  readonly initialTags?: readonly TagTypeRecord[];
  readonly value?: readonly string[];
  readonly onChange?: (ids: readonly string[]) => void;
  readonly size?: 'sm' | 'md';
}

async function fetchTags(url: string): Promise<readonly TagTypeRecord[] | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: { tags?: TagTypeRecord[] } };
    return json.data?.tags ?? null;
  } catch {
    return null;
  }
}

export function TagChipPicker({
  entity,
  entityId,
  initialTags,
  value,
  onChange,
  size = 'md',
}: TagChipPickerProps) {
  const bound = entityId !== null;
  const [options, setOptions] = useState<readonly TagTypeRecord[]>([]);
  const [boundTags, setBoundTags] = useState<readonly TagTypeRecord[]>(initialTags ?? []);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState<TagColor>('graphite');

  useEffect(() => {
    let cancelled = false;
    void fetchTags(`/api/admin/settings/tags?entity=${entity}&active=1`).then((tags) => {
      if (!cancelled && tags) setOptions(tags);
    });
    return () => {
      cancelled = true;
    };
  }, [entity]);

  useEffect(() => {
    if (!bound || initialTags) return;
    let cancelled = false;
    void fetchTags(`/api/admin/tags/${entity}/${entityId}`).then((tags) => {
      if (cancelled) return;
      if (tags) setBoundTags(tags);
      else setError(SAVE_COPY);
    });
    return () => {
      cancelled = true;
    };
  }, [bound, entity, entityId, initialTags]);

  const selected: readonly TagTypeRecord[] = useMemo(
    () =>
      bound
        ? boundTags
        : (value ?? [])
            .map((id) => options.find((o) => o.id === id))
            .filter((t): t is TagTypeRecord => t !== undefined),
    [bound, boundTags, value, options],
  );
  const selectedIds = useMemo(() => new Set(selected.map((t) => t.id)), [selected]);

  async function commit(nextIds: readonly string[]): Promise<void> {
    if (!bound) {
      onChange?.(nextIds);
      return;
    }
    const previous = boundTags;
    const catalog = [...options, ...previous];
    setBoundTags(
      nextIds
        .map((id) => catalog.find((t) => t.id === id))
        .filter((t): t is TagTypeRecord => t !== undefined),
    );
    setError(null);
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/tags/${entity}/${entityId}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tagTypeIds: nextIds }),
      });
      if (!res.ok) throw new Error('bad status');
      const json = (await res.json()) as { data?: { tags?: TagTypeRecord[] } };
      if (json.data?.tags) setBoundTags(json.data.tags);
      onChange?.(nextIds);
    } catch {
      setBoundTags(previous);
      setError(SAVE_COPY);
    } finally {
      setSaving(false);
    }
  }

  function toggle(id: string, on: boolean): void {
    const ids = selected.map((t) => t.id);
    void commit(on ? [...ids.filter((i) => i !== id), id] : ids.filter((i) => i !== id));
  }

  async function createTag(): Promise<void> {
    const name = newName.trim();
    if (!name) return;
    setError(null);
    try {
      const res = await fetch('/api/admin/settings/tags', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ entity, name, color: newColor }),
      });
      if (res.status === 409) {
        setError(DUPLICATE_COPY);
        return;
      }
      if (!res.ok) throw new Error('bad status');
      const json = (await res.json()) as { data?: { tag?: TagTypeRecord } };
      const tag = json.data?.tag;
      if (!tag) throw new Error('no tag');
      setOptions((prev) => [...prev, tag]);
      setCreating(false);
      setNewName('');
      setNewColor('graphite');
      if (bound) {
        await commit([...selected.map((t) => t.id), tag.id]);
      } else {
        onChange?.([...selected.map((t) => t.id), tag.id]);
      }
    } catch {
      setError(CREATE_COPY);
    }
  }

  const chipText = size === 'sm' ? 'text-[11px]' : 'text-[12px]';

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {selected.map((tag) => (
          <span
            key={tag.id}
            tabIndex={0}
            title={tag.visibleOnBoard ? 'Shown on board' : undefined}
            onKeyDown={(e) => {
              if (e.key === 'Backspace') {
                e.preventDefault();
                toggle(tag.id, false);
              }
            }}
            className={cn(
              'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 outline-none focus-visible:ring-2 focus-visible:ring-ring',
              chipText,
              tagBadgeClass(tag.color),
            )}
          >
            {tag.name}
            <button
              type="button"
              aria-label={`Remove tag ${tag.name}`}
              className="-mr-1 rounded-sm p-0.5 hover:bg-black/10"
              onClick={() => toggle(tag.id, false)}
            >
              <X className="size-3" />
            </button>
          </span>
        ))}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant="ghost" size="xs" aria-label="Add tag" />}
          >
            <Plus className="size-3" />
            Add tag
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {options.map((o) => (
              <DropdownMenuCheckboxItem
                key={o.id}
                checked={selectedIds.has(o.id)}
                onCheckedChange={(checked) => toggle(o.id, checked)}
              >
                {o.name}
              </DropdownMenuCheckboxItem>
            ))}
            {options.length > 0 && <DropdownMenuSeparator />}
            <DropdownMenuItem onClick={() => setCreating(true)}>New tag…</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {saving && <Loader2 className="size-3 animate-spin text-muted-foreground" />}
      </div>

      {creating && (
        <div className="flex flex-wrap items-center gap-2">
          <Input
            aria-label="New tag name"
            className="h-8 w-44"
            placeholder="Tag name"
            maxLength={40}
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void createTag();
              }
              if (e.key === 'Escape') setCreating(false);
            }}
          />
          <Select
            items={COLOR_ITEMS}
            value={newColor}
            onValueChange={(v) => v && setNewColor(v as TagColor)}
          >
            <SelectTrigger aria-label="New tag colour" className="h-8 w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {COLOR_ITEMS.map((c) => (
                <SelectItem key={c.value} value={c.value}>
                  <span className={cn('inline-block size-3 rounded-sm border', tagBadgeClass(c.value))} />
                  {c.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="sm" onClick={() => void createTag()} disabled={newName.trim().length === 0}>
            Create
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setCreating(false)}>
            Cancel
          </Button>
        </div>
      )}

      {error && (
        <p role="alert" className="text-[12px] text-danger-strong">
          {error}
        </p>
      )}
    </div>
  );
}
