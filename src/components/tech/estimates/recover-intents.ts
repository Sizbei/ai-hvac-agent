/**
 * Re-send estimate / equipment intents a reload left in flight (M3b rule, M3c
 * spec §7): OLD body, OLD key, before the surface unlocks. A definitive
 * answer clears the stored intent; an unknown one stays for "Try again".
 */
import { classifyWriteError } from '@/lib/tech/invoice-client-errors';
import { ESTIMATE_INTENTS_KEY, recoveryKeeps, storedToRecover, withoutIntent } from '@/lib/tech/estimate-intents';
import { postJson } from '@/components/tech/invoice/post-json';

export interface RecoveryResult {
  readonly unresolved: number;
  readonly succeeded: ReadonlyArray<{ readonly intentId: string; readonly data: Record<string, unknown> }>;
}

export async function recoverEstimateIntents(requestId: string, match: (intentId: string) => boolean): Promise<RecoveryResult> {
  const storageKey = ESTIMATE_INTENTS_KEY(requestId);
  let raw: string | null;
  try {
    raw = window.sessionStorage.getItem(storageKey);
  } catch {
    return { unresolved: 0, succeeded: [] };
  }
  let unresolved = 0;
  const succeeded: { intentId: string; data: Record<string, unknown> }[] = [];
  for (const item of storedToRecover(raw, match)) {
    const res = await postJson(item.write.path, item.write.payload, item.key);
    const env = res.status === null ? null : res.envelope;
    const outcome = classifyWriteError(res.status, env?.error?.code ?? null, env?.error?.details);
    if (recoveryKeeps(outcome)) {
      unresolved += 1;
      continue;
    }
    if (outcome === 'success_refetch' && env?.data && typeof env.data === 'object') {
      succeeded.push({ intentId: item.intentId, data: env.data as Record<string, unknown> });
    }
    try {
      const next = withoutIntent(window.sessionStorage.getItem(storageKey), item.intentId);
      if (next === null) window.sessionStorage.removeItem(storageKey);
      else window.sessionStorage.setItem(storageKey, next);
    } catch {
      /* storage unavailable */
    }
  }
  return { unresolved, succeeded };
}
