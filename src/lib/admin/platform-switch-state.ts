import type { FeatureKey, Features } from "@/lib/tenancy/feature-flags";

/** One org's switch row in the platform console. `pending` locks every switch in the row. */
export interface SwitchRowState {
  readonly features: Features;
  readonly pending: boolean;
}

export const initialSwitchRow = (features: Features): SwitchRowState => ({
  features,
  pending: false,
});

/** Optimistically flips `key` and locks the row. A row already saving is returned unchanged. */
export function startSave(state: SwitchRowState, key: FeatureKey, next: boolean): SwitchRowState {
  if (state.pending) return state;
  return { features: { ...state.features, [key]: next }, pending: true };
}

/** Applies the server's merged features and unlocks the row. */
export function saveSucceeded(features: Features): SwitchRowState {
  return { features, pending: false };
}

/** Reverts ONLY `key` to `previous` and unlocks the row. */
export function saveFailed(state: SwitchRowState, key: FeatureKey, previous: boolean): SwitchRowState {
  return { features: { ...state.features, [key]: previous }, pending: false };
}
