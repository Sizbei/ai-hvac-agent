'use client';

import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { FORM_LIMITS, type FieldType } from '@/lib/forms/form-schema';
import { changeType, newOptionId, TYPE_LABELS, TYPE_ORDER, UNIT_SUGGESTIONS, type BuilderField } from '@/lib/admin/form-builder';

const TYPE_ITEMS = TYPE_ORDER.map((t) => ({ value: t, label: TYPE_LABELS[t] }));

/** One question in the builder (M3d spec §7.1). Pure presentation: every change goes through `onChange`. */
export function FormFieldEditor({
  field,
  index,
  count,
  longTextFull,
  canAdd,
  errors,
  onChange,
  onMove,
  onAddBelow,
  onRemove,
}: {
  readonly field: BuilderField;
  readonly index: number;
  readonly count: number;
  /** 10 long answers already: `Long answer` is disabled for other questions. */
  readonly longTextFull: boolean;
  readonly canAdd: boolean;
  readonly errors: readonly string[];
  readonly onChange: (next: BuilderField) => void;
  readonly onMove: (dir: -1 | 1) => void;
  readonly onAddBelow: () => void;
  readonly onRemove: () => void;
}) {
  const set = (patch: Partial<BuilderField>) => onChange({ ...field, ...patch });
  const isHeading = field.type === 'heading';
  return (
    <li id={`field-${field.id}`} className="space-y-3 px-4 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs tabular-nums text-muted-foreground">{index + 1}</span>
        <Select
          items={TYPE_ITEMS}
          value={field.type}
          onValueChange={(v) => v && v !== field.type && onChange(changeType(field, v as FieldType))}
        >
          <SelectTrigger aria-label="Question type" className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TYPE_ITEMS.map((t) => (
              <SelectItem key={t.value} value={t.value} disabled={t.value === 'long_text' && longTextFull && field.type !== 'long_text'}>
                {t.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="ml-auto flex items-center gap-1">
          <Button type="button" size="sm" variant="ghost" id={`move-up-${field.id}`} aria-label={`Move question ${index + 1} up`} disabled={index === 0} onClick={() => onMove(-1)}>
            <ArrowUp className="size-4" />
          </Button>
          <Button type="button" size="sm" variant="ghost" id={`move-down-${field.id}`} aria-label={`Move question ${index + 1} down`} disabled={index === count - 1} onClick={() => onMove(1)}>
            <ArrowDown className="size-4" />
          </Button>
          <Button type="button" size="sm" variant="ghost" aria-label={`Remove question ${index + 1}`} onClick={onRemove}>
            <Trash2 className="size-4" />
          </Button>
        </div>
      </div>

      <Input aria-label="Label" placeholder={isHeading ? 'Section title' : 'Question'} value={field.label} maxLength={FORM_LIMITS.label + 20} onChange={(e) => set({ label: e.target.value })} />
      <Input aria-label="Help" placeholder="Help (optional)" value={field.help} onChange={(e) => set({ help: e.target.value })} />

      {!isHeading && (
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={field.required} onCheckedChange={(v) => set({ required: v })} />
          Required
        </label>
      )}

      {field.type === 'yes_no' && (
        <label className="flex items-start gap-2 text-sm">
          <Switch checked={field.allowNa} onCheckedChange={(v) => set({ allowNa: v })} aria-labelledby={`na-label-${field.id}`} aria-describedby={`na-help-${field.id}`} />
          <span>
            <span id={`na-label-${field.id}`}>Allow N/A</span>
            <span id={`na-help-${field.id}`} className="block text-xs text-muted-foreground">Use N/A for items that don&apos;t apply to every system.</span>
          </span>
        </label>
      )}

      {field.type === 'number' && (
        <div className="grid gap-2 sm:grid-cols-3">
          <label className="space-y-1 text-sm">
            <span className="text-xs text-muted-foreground">Unit</span>
            <Input list={`units-${field.id}`} value={field.unit} onChange={(e) => set({ unit: e.target.value })} />
            <datalist id={`units-${field.id}`}>
              {UNIT_SUGGESTIONS.map((u) => <option key={u} value={u} />)}
            </datalist>
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-xs text-muted-foreground">Usual range from</span>
            <Input inputMode="decimal" value={field.usualMin} onChange={(e) => set({ usualMin: e.target.value })} />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-xs text-muted-foreground">to</span>
            <Input inputMode="decimal" value={field.usualMax} onChange={(e) => set({ usualMax: e.target.value })} />
          </label>
          <p className="text-xs text-muted-foreground sm:col-span-3">Readings outside it are still saved, with a note.</p>
        </div>
      )}

      {field.type === 'choice' && (
        <div className="space-y-2">
          {field.options.map((o, i) => (
            <div key={o.id} className="flex items-center gap-2">
              <Input
                aria-label={`Option ${i + 1}`}
                value={o.label}
                onChange={(e) => set({ options: field.options.map((x) => (x.id === o.id ? { ...x, label: e.target.value } : x)) })}
              />
              <Button
                type="button" size="sm" variant="ghost" aria-label={`Remove option ${i + 1}`}
                onClick={() => set({ options: field.options.filter((x) => x.id !== o.id) })}
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          ))}
          <Button
            type="button" size="sm" variant="outline" disabled={field.options.length >= FORM_LIMITS.maxOptions}
            onClick={() => set({ options: [...field.options, { id: newOptionId(), label: '' }] })}
          >
            <Plus className="size-4" /> Add option
          </Button>
        </div>
      )}

      {errors.length > 0 && (
        <ul className="space-y-0.5 text-xs text-destructive">
          {errors.map((m) => <li key={m}>{m}</li>)}
        </ul>
      )}

      <Button type="button" size="sm" variant="ghost" disabled={!canAdd} onClick={onAddBelow}>
        <Plus className="size-4" /> Add question below
      </Button>
    </li>
  );
}
