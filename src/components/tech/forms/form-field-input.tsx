'use client';

import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { FORM_LIMITS, type FormField } from '@/lib/forms/form-schema';
import { answerText, numberInputState, rangeNote, stripControlChars } from '@/lib/forms/form-values';
import { numberNote } from '@/lib/tech/form-copy';
import { toggleSign, type InputValue } from '@/lib/tech/form-fill-state';

const COUNT_FROM = 0.8;

function Counter({ value, max }: { readonly value: string; readonly max: number }) {
  if (value.length < max * COUNT_FROM) return null;
  return <span className="block text-right font-mono text-[13px] tabular-nums text-muted-foreground">{value.length}/{max}</span>;
}

/** One answer control (M3d spec §7.3). `readOnly` renders the answer text. */
export function FormFieldInput({
  field,
  value,
  readOnly,
  highlight,
  onChange,
  onBlur,
  onFocusInput,
}: {
  readonly field: FormField;
  readonly value: InputValue | undefined;
  readonly readOnly: boolean;
  /** "Answer this." or "Fix the highlighted answers." target. */
  readonly highlight: string | null;
  readonly onChange: (v: InputValue) => void;
  /** Text and number inputs: blur saves at once and frees the footer. */
  readonly onBlur: () => void;
  readonly onFocusInput: () => void;
}) {
  const label = (
    <span className="flex items-baseline gap-2">
      <span className="text-[15px] font-medium">{field.label}</span>
      {field.required && <span className="text-[13px] text-muted-foreground">Required</span>}
    </span>
  );
  const help = field.help ? <span className="block text-[13px] text-muted-foreground">{field.help}</span> : null;
  const flag = highlight ? <span role="alert" className="block text-[13px] text-danger-strong">{highlight}</span> : null;

  if (field.type === 'heading') {
    return <h3 className="pt-2 text-[15px] font-semibold">{field.label}</h3>;
  }

  if (readOnly) {
    const v = field.type === 'number' ? numberInputState(typeof value === 'string' ? value : '') : null;
    const parsed = field.type === 'number' ? (v?.kind === 'value' ? v.value : undefined)
      : field.type === 'checkbox' ? (value === true ? true : undefined)
      : (typeof value === 'string' && value !== '' ? value : undefined);
    return (
      <div className="space-y-0.5">
        {label}
        <p className="text-[15px]">{answerText(field, parsed)}</p>
      </div>
    );
  }

  switch (field.type) {
    case 'checkbox':
      return (
        <label className="flex min-h-11 items-center gap-3">
          <input type="checkbox" className="size-5" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
          <span className="flex-1">{label}{help}{flag}</span>
        </label>
      );
    case 'yes_no':
    case 'choice': {
      const options = field.type === 'yes_no'
        ? [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }, ...(field.allowNa ? [{ id: 'na', label: 'N/A' }] : [])]
        : field.options;
      return (
        <fieldset className="space-y-1">
          <legend>{label}</legend>
          {help}
          <div className={field.type === 'yes_no' ? 'flex flex-wrap gap-2' : 'space-y-1'}>
            {options.map((o) => (
              <label key={o.id} className="flex min-h-11 items-center gap-2 rounded-xl border border-border-input px-3">
                <input type="radio" name={field.id} checked={value === o.id} onChange={() => onChange(o.id)} />
                {o.label}
              </label>
            ))}
          </div>
          {flag}
        </fieldset>
      );
    }
    case 'short_text':
    case 'long_text': {
      const max = field.type === 'short_text' ? FORM_LIMITS.shortText : FORM_LIMITS.longText;
      const text = typeof value === 'string' ? value : '';
      const common = {
        value: text,
        maxLength: max,
        onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange(stripControlChars(e.target.value)),
        onBlur,
        onFocus: onFocusInput,
        className: 'rounded-xl text-[15px] md:text-[15px]',
      };
      return (
        <label className="block space-y-1">
          {label}
          {help}
          {field.type === 'short_text' ? <Input {...common} className={`h-11 ${common.className}`} /> : <Textarea rows={4} {...common} />}
          <Counter value={text} max={max} />
          {flag}
        </label>
      );
    }
    case 'number': {
      const raw = typeof value === 'string' ? value : '';
      const st = numberInputState(raw);
      const note = numberNote(st.kind) ?? (st.kind === 'value' ? rangeNote(field, st.value) : null);
      const showSign = field.usualMin === undefined || field.usualMin < 0;
      return (
        <div className="space-y-1">
          <label className="block space-y-1">
            {label}
            {help}
            <span className="flex items-center gap-2">
              <Input
                inputMode="decimal"
                value={raw}
                onChange={(e) => onChange(e.target.value)}
                onBlur={onBlur}
                onFocus={onFocusInput}
                className="h-11 rounded-xl font-mono text-[15px] tabular-nums md:text-[15px]"
              />
              {field.unit && <span className="text-[15px] text-muted-foreground">{field.unit}</span>}
            </span>
          </label>
          {showSign && (
            <button type="button" aria-label="Switch sign" className="h-11 min-w-11 rounded-xl border border-border-input px-3 text-[15px]" onClick={() => onChange(toggleSign(raw))}>
              ±
            </button>
          )}
          {note && <span className="block text-[13px] text-muted-foreground">{note}</span>}
          {flag}
        </div>
      );
    }
  }
}
