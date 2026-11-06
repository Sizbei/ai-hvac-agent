'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { TechSheet } from '@/components/tech/invoice/tech-sheet';
import { EQUIPMENT_TYPE_OPTIONS } from '@/lib/admin/display-labels';
import { EQUIPMENT_ERROR_COPY, parseEquipmentInput, todayInZone, type TechEquipmentUnit } from '@/lib/tech/equipment-input';
import { EQUIPMENT_COPY, emptyForm, formBody, formForReplace, replaceHeading, type EquipmentForm } from '@/lib/tech/equipment-display';
import { ESTIMATE_INTENT, estimateWriteCopy } from '@/lib/tech/estimate-intents';
import { useEstimateWrite, type EstimateSend } from '@/components/tech/estimates/use-estimate-write';

const FIELD = 'h-11 rounded-xl text-[16px]';
const UNKNOWN_COPY = 'Your last save may not have gone through. Try again.';
const EARLIER_COPY = 'Your earlier save went through first. Check the equipment list.';

/**
 * Add a unit, or replace `replacing` (M3c spec §7.5). Mount with
 * `key={intentId}` so each unit's replace has its own idempotency intent.
 * `onSaved` reloads the card and resolves true when the reload shows the write
 * landed (for a replace: the old unit left the list).
 */
export function EquipmentSheet({
  jobId,
  replacing,
  onClose,
  onSaved,
}: {
  readonly jobId: string;
  readonly replacing: TechEquipmentUnit | null;
  readonly onClose: () => void;
  readonly onSaved: () => Promise<boolean>;
}) {
  const intentId = replacing ? ESTIMATE_INTENT.equipmentReplace(replacing.id) : ESTIMATE_INTENT.equipmentAdd;
  const { phase, send, settle } = useEstimateWrite(jobId, intentId, true);
  const [form, setForm] = useState<EquipmentForm>(() => (replacing ? formForReplace(replacing) : emptyForm()));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const resent = useRef(false);
  const today = todayInZone(new Date());
  const path = `/api/tech/jobs/${jobId}/equipment`;
  const set = (k: keyof EquipmentForm) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  /** Shared answer handling for a save and for the rehydrated re-send. */
  async function handle(r: EstimateSend): Promise<void> {
    if (!r.sent) return;
    if (r.outcome === 'success_refetch' || r.outcome === 'already_saved_refetch') {
      settle(r.outcome, false);
      await onSaved();
      setSaving(false);
      if (r.resentOld) {
        setError(EARLIER_COPY); // the OLD body landed; the edited form was not sent
        return;
      }
      onClose();
      return;
    }
    const unknown = r.outcome === 'retry_same_key_after_refetch' || r.outcome === 'wait_then_refetch';
    const landed = unknown ? await onSaved() : false;
    settle(r.outcome, landed);
    setSaving(false);
    if (landed) {
      onClose();
      return;
    }
    setError(unknown ? UNKNOWN_COPY : estimateWriteCopy(r.outcome, r.envelope));
  }

  // Rehydrated as `unknown` (a reload or a closed sheet left it unanswered):
  // re-send the stored body with the stored key before anything else. `send`
  // re-sends the stored body whatever payload it is given while `unknown`.
  useEffect(() => {
    if (phase !== 'unknown' || resent.current) return;
    resent.current = true;
    void send(path, {}).then(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire once per rehydrated intent
  }, [phase]);

  async function save(): Promise<void> {
    const body = formBody(form, replacing?.id ?? null);
    if (phase !== 'unknown') {
      const check = parseEquipmentInput(body, today);
      if (!check.ok) {
        setError(EQUIPMENT_ERROR_COPY[check.error]);
        return;
      }
    }
    setSaving(true);
    setError(null);
    const r = await send(path, body);
    if (!r.sent) {
      setSaving(false);
      return;
    }
    await handle(r);
  }

  const locked = saving || phase === 'sent';

  return (
    <TechSheet
      open
      onClose={onClose}
      busy={locked}
      title={replacing ? replaceHeading(replacing) : EQUIPMENT_COPY.add}
      description={EQUIPMENT_COPY.sheetDescription}
    >
      <div className="space-y-3 px-4">
        <label className="block space-y-1.5">
          <span className="text-[13px] font-medium text-muted-foreground">{EQUIPMENT_COPY.type}</span>
          <select
            value={form.equipmentType}
            onChange={set('equipmentType')}
            disabled={locked}
            className="flex h-11 w-full rounded-xl border border-border-input bg-surface-raised px-3 text-[16px]"
          >
            <option value="">Choose…</option>
            {EQUIPMENT_TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
        {form.equipmentType === 'other' && (
          <label className="block space-y-1.5">
            <span className="text-[13px] font-medium text-muted-foreground">{EQUIPMENT_COPY.describe}</span>
            <Input value={form.notes} onChange={set('notes')} maxLength={120} disabled={locked} className={FIELD} />
          </label>
        )}
        {([['make', EQUIPMENT_COPY.make], ['model', EQUIPMENT_COPY.model], ['serialNumber', EQUIPMENT_COPY.serial], ['locationInHome', EQUIPMENT_COPY.location]] as const).map(([k, label]) => (
          <label key={k} className="block space-y-1.5">
            <span className="text-[13px] font-medium text-muted-foreground">{label}</span>
            <Input value={form[k]} onChange={set(k)} maxLength={120} disabled={locked} className={FIELD} autoComplete="off" />
          </label>
        ))}
        <label className="block space-y-1.5">
          <span className="text-[13px] font-medium text-muted-foreground">{EQUIPMENT_COPY.installDate}</span>
          <Input type="date" max={today} value={form.installDate} onChange={set('installDate')} disabled={locked} className={FIELD} />
        </label>
        {error && <p role="alert" className="text-[15px] text-danger-strong">{error}</p>}
        <Button className="h-12 w-full rounded-xl text-[16px]" disabled={locked} onClick={() => void save()}>
          {locked ? EQUIPMENT_COPY.saving : phase === 'unknown' ? 'Try again' : EQUIPMENT_COPY.save}
        </Button>
      </div>
    </TechSheet>
  );
}
