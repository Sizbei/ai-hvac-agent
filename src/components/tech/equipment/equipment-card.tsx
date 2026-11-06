'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { equipmentTypeLabel } from '@/lib/admin/display-labels';
import { EQUIPMENT_COPY, unitDescription, unitDetails } from '@/lib/tech/equipment-display';
import { ESTIMATE_INTENT, MAY_NOT_HAVE_SAVED } from '@/lib/tech/estimate-intents';
import type { TechEquipmentUnit, TechEquipmentView } from '@/lib/tech/equipment-input';
import { recoverEstimateIntents } from '@/components/tech/estimates/recover-intents';
import { EquipmentSheet } from './equipment-sheet';

async function fetchEquipment(jobId: string): Promise<{ kind: 'ok'; view: TechEquipmentView } | { kind: 'hidden' } | { kind: 'error' }> {
  try {
    const res = await fetch(`/api/tech/jobs/${jobId}/equipment`, { cache: 'no-store' });
    const body = (await res.json().catch(() => null)) as { success?: boolean; data?: TechEquipmentView } | null;
    if (res.ok && body?.success && body.data) return { kind: 'ok', view: body.data };
    if (res.status === 404 || res.status === 409) return { kind: 'hidden' };
    return { kind: 'error' };
  } catch {
    return { kind: 'error' };
  }
}

/** The job page's Equipment card (M3c spec §7.5): live units at this address, Add, Replace. */
export function EquipmentCard({ jobId, refreshKey }: { readonly jobId: string; readonly refreshKey: number }) {
  const [view, setView] = useState<TechEquipmentView | null>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'hidden' | 'error'>('loading');
  const [recovering, setRecovering] = useState(true);
  const [unresolved, setUnresolved] = useState(0);
  const [sheet, setSheet] = useState<{ readonly replacing: TechEquipmentUnit | null } | null>(null);

  const load = useCallback(async (): Promise<TechEquipmentView | null> => {
    const r = await fetchEquipment(jobId);
    if (r.kind === 'ok') {
      setView(r.view);
      setState('ok');
      return r.view;
    }
    setState((s) => (r.kind === 'hidden' ? 'hidden' : s === 'ok' ? s : 'error'));
    return null;
  }, [jobId, setView, setState]);

  /** Re-send stored equipment intents (old body, old key), then reload; state changes only after the awaits. */
  const runRecovery = useCallback(async (): Promise<void> => {
    const rec = await recoverEstimateIntents(jobId, (id) => id.startsWith('equipment:'));
    await load();
    setUnresolved(rec.unresolved);
    setRecovering(false);
  }, [jobId, load, setUnresolved, setRecovering]);

  /** Mount recovery runs once per job (StrictMode runs the effect twice). */
  const recovery = useRef<{ jobId: string; done: Promise<void> } | null>(null);
  useEffect(() => {
    if (recovery.current?.jobId !== jobId) recovery.current = { jobId, done: runRecovery() };
  }, [jobId, runRecovery]);

  // A status tap only reloads, after any recovery has finished.
  useEffect(() => {
    if (refreshKey > 0) void recovery.current?.done.then(() => load());
  }, [refreshKey, load]);

  /** Reload; for a replace, true once the old unit has left the list (the write landed). */
  const onSaved = useCallback(async (): Promise<boolean> => {
    const replacing = sheet?.replacing ?? null;
    const v = await load();
    if (!v) return false;
    return replacing !== null && !v.units.some((u) => u.id === replacing.id);
  }, [load, sheet]);

  if (state === 'loading' || state === 'hidden' || (state === 'error' && !view) || (view && !view.canWrite)) return null;
  const locked = recovering || unresolved > 0;
  const intentId = sheet?.replacing ? ESTIMATE_INTENT.equipmentReplace(sheet.replacing.id) : ESTIMATE_INTENT.equipmentAdd;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-[17px]">{EQUIPMENT_COPY.title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {state === 'error' || !view ? (
          <p role="alert" className="text-[15px] text-danger-strong">{EQUIPMENT_COPY.loadError}</p>
        ) : (
          <>
            {unresolved > 0 && (
              <div role="alert" className="flex items-center justify-between gap-3 rounded-md border border-warning-border bg-warning-light px-3 py-2 text-[15px]">
                <span>{MAY_NOT_HAVE_SAVED}</span>
                <Button variant="outline" className="h-11 shrink-0 rounded-xl px-4 text-[15px]" disabled={recovering}
                  onClick={() => { setRecovering(true); void runRecovery(); }}>
                  Try again
                </Button>
              </div>
            )}
            {view.units.length === 0 ? (
              <p className="text-[15px] text-muted-foreground">{EQUIPMENT_COPY.empty}</p>
            ) : (
              <ul className="divide-y divide-border" aria-label={EQUIPMENT_COPY.title}>
                {view.units.map((u) => (
                  <li key={u.id} className="flex min-h-14 items-center gap-2 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-[15px] font-medium">{equipmentTypeLabel(u.equipmentType)}</p>
                      {unitDescription(u) && <p className="text-[15px] break-words">{unitDescription(u)}</p>}
                      {unitDetails(u) && <p className="text-[13px] text-muted-foreground break-words">{unitDetails(u)}</p>}
                    </div>
                    {u.managedExternally ? (
                      <span className="shrink-0 text-[13px] text-muted-foreground">{EQUIPMENT_COPY.managed}</span>
                    ) : (
                      <Button variant="outline" className="h-11 shrink-0 rounded-xl px-4 text-[15px]" disabled={locked}
                        onClick={() => setSheet({ replacing: u })}>
                        {EQUIPMENT_COPY.replace}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <Button variant="outline" className="h-11 rounded-xl px-4 text-[15px]" disabled={locked} onClick={() => setSheet({ replacing: null })}>
              {EQUIPMENT_COPY.add}
            </Button>
          </>
        )}
      </CardContent>
      {sheet && (
        <EquipmentSheet key={intentId} jobId={jobId} replacing={sheet.replacing} onClose={() => setSheet(null)} onSaved={onSaved} />
      )}
    </Card>
  );
}
