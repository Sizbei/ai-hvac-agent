'use client';

import { useEffect, useState } from 'react';
import { Plus, Loader2, AlertCircle } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
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
import { cn } from '@/lib/utils';
import {
  TAG_COLOR_TOKENS,
  tagBadgeClass,
  type TagColor,
  type TagEntity,
  type TagTypeRecord,
  type TagTypeInput,
  type TagTypePatch,
} from '@/lib/admin/tag-types';

const DUPLICATE_COPY = 'A tag with that name already exists for this type.';
const LIMIT_COPY = 'You can have at most 100 tags.';
const GENERIC_COPY = "Couldn't save the tag. Please try again.";

const GROUPS: readonly { entity: TagEntity; title: string; description: string }[] = [
  { entity: 'customer', title: 'Customers', description: 'Labels on customer profiles, such as VIP or Commercial.' },
  { entity: 'location', title: 'Locations', description: 'Labels on service locations, such as Gate code or Dog.' },
  { entity: 'job', title: 'Requests', description: 'Labels on requests. Tags marked "Show on board" appear on dispatch cards.' },
];

const COLOR_ITEMS = TAG_COLOR_TOKENS.map((c) => ({ value: c, label: c.charAt(0).toUpperCase() + c.slice(1) }));

type SaveResult =
  | { readonly ok: true; readonly tag: TagTypeRecord }
  | { readonly ok: false; readonly message: string };

async function send(
  url: string,
  method: 'POST' | 'PATCH',
  payload: TagTypeInput | TagTypePatch,
): Promise<SaveResult> {
  try {
    const res = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (res.status === 409) {
      const json = (await res.json().catch(() => null)) as { error?: { code?: string } } | null;
      if (json?.error?.code === 'DUPLICATE_NAME') return { ok: false, message: DUPLICATE_COPY };
      if (json?.error?.code === 'LIMIT_REACHED') return { ok: false, message: LIMIT_COPY };
      return { ok: false, message: GENERIC_COPY };
    }
    if (!res.ok) return { ok: false, message: GENERIC_COPY };
    const json = (await res.json()) as { data?: { tag?: TagTypeRecord } };
    if (!json.data?.tag) return { ok: false, message: GENERIC_COPY };
    return { ok: true, tag: json.data.tag };
  } catch {
    return { ok: false, message: GENERIC_COPY };
  }
}

function ColorSelect({
  value,
  onChange,
  label,
}: {
  readonly value: TagColor;
  readonly onChange: (c: TagColor) => void;
  readonly label: string;
}) {
  return (
    <Select items={COLOR_ITEMS} value={value} onValueChange={(v) => v && onChange(v as TagColor)}>
      <SelectTrigger aria-label={label} className="w-36">
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
  );
}

interface RowProps {
  readonly tag: TagTypeRecord;
  readonly showBoard: boolean;
  readonly onSaved: (tag: TagTypeRecord) => void;
  readonly onError: (message: string | null) => void;
}

function TagRow({ tag, showBoard, onSaved, onError }: RowProps) {
  const [name, setName] = useState(tag.name);
  const [saving, setSaving] = useState(false);

  async function save(patch: TagTypePatch): Promise<void> {
    setSaving(true);
    const result = await send(`/api/admin/settings/tags/${tag.id}`, 'PATCH', patch);
    setSaving(false);
    if (result.ok) {
      onError(null);
      onSaved(result.tag);
      setName(result.tag.name);
    } else {
      onError(result.message);
      setName(tag.name);
    }
  }

  function commitName(): void {
    const trimmed = name.trim();
    if (trimmed === tag.name) return setName(tag.name);
    void save({ name: trimmed });
  }

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b py-2 last:border-b-0">
      <Input
        aria-label="Name"
        className="min-w-40 flex-1"
        value={name}
        maxLength={40}
        onChange={(e) => setName(e.target.value)}
        onBlur={commitName}
      />
      <ColorSelect
        label="Colour"
        value={tag.color}
        onChange={(c) => c !== tag.color && void save({ color: c })}
      />
      {showBoard && (
        <label className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
          <Switch
            aria-label="Show on board"
            checked={tag.visibleOnBoard}
            disabled={saving}
            onCheckedChange={(checked) => void save({ visibleOnBoard: checked })}
          />
          Show on board
        </label>
      )}
      <label className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
        <Switch
          aria-label="Active"
          checked={tag.active}
          disabled={saving}
          onCheckedChange={(checked) => void save({ active: checked })}
        />
        Active
      </label>
      <span className="size-4">
        {saving && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
      </span>
    </div>
  );
}

interface GroupProps {
  readonly entity: TagEntity;
  readonly title: string;
  readonly description: string;
  readonly tags: readonly TagTypeRecord[];
  readonly onSaved: (tag: TagTypeRecord) => void;
  readonly onCreated: (tag: TagTypeRecord) => void;
  readonly onError: (message: string | null) => void;
}

function TagGroup({ entity, title, description, tags, onSaved, onCreated, onError }: GroupProps) {
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState<TagColor>('graphite');
  const [adding, setAdding] = useState(false);

  async function handleAdd(): Promise<void> {
    setAdding(true);
    const result = await send('/api/admin/settings/tags', 'POST', {
      entity,
      name: newName.trim(),
      color: newColor,
    });
    setAdding(false);
    if (result.ok) {
      onError(null);
      onCreated(result.tag);
      setNewName('');
    } else {
      onError(result.message);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {tags.length === 0 ? (
          <p className="text-sm text-muted-foreground">No tags yet.</p>
        ) : (
          <div>
            {tags.map((t) => (
              <TagRow key={t.id} tag={t} showBoard={entity === 'job'} onSaved={onSaved} onError={onError} />
            ))}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2 border-t pt-3">
          <Input
            aria-label={`New ${title.toLowerCase()} tag name`}
            className="min-w-40 flex-1"
            placeholder="Add a tag"
            value={newName}
            maxLength={40}
            onChange={(e) => setNewName(e.target.value)}
          />
          <ColorSelect label={`New ${title.toLowerCase()} tag colour`} value={newColor} onChange={setNewColor} />
          <Button onClick={() => void handleAdd()} disabled={newName.trim().length === 0 || adding}>
            {adding ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
            Add
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function TagsPanel() {
  const [tags, setTags] = useState<readonly TagTypeRecord[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/admin/settings/tags');
        if (!res.ok) throw new Error('bad status');
        const json = (await res.json()) as { data?: { tags?: TagTypeRecord[] } };
        if (!cancelled) setTags(json.data?.tags ?? []);
      } catch {
        if (!cancelled) setLoadFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function handleSaved(saved: TagTypeRecord): void {
    setTags((prev) => prev && prev.map((t) => (t.id === saved.id ? saved : t)));
  }
  function handleCreated(created: TagTypeRecord): void {
    setTags((prev) => [...(prev ?? []), created]);
  }

  if (loadFailed) {
    return (
      <p className="text-sm text-muted-foreground">
        Couldn&apos;t load tags. Refresh to try again.
      </p>
    );
  }
  if (tags === null) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {error && (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {GROUPS.map((g) => (
        <TagGroup
          key={g.entity}
          {...g}
          tags={tags.filter((t) => t.entity === g.entity)}
          onSaved={handleSaved}
          onCreated={handleCreated}
          onError={setError}
        />
      ))}
    </div>
  );
}
