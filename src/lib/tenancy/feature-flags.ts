import { z } from "zod";

export type FeatureKey = "map" | "reviewRequests" | "payLinks" | "showHistory";
export type Features = Readonly<Record<FeatureKey, boolean>>;

export const DEFAULT_FEATURES: Features = {
  map: false,
  reviewRequests: true,
  payLinks: true,
  showHistory: false,
};

const KEYS = Object.keys(DEFAULT_FEATURES) as FeatureKey[];

/** Reads `organizations.feature_flags`; unknown keys and non-booleans are ignored. */
export function parseFeatures(raw: unknown): Features {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return DEFAULT_FEATURES;
  }
  const record = raw as Record<string, unknown>;
  const out: Record<FeatureKey, boolean> = { ...DEFAULT_FEATURES };
  for (const key of KEYS) {
    const value = record[key];
    if (typeof value === "boolean") out[key] = value;
  }
  return out;
}

export const featurePatchSchema = z
  .strictObject({
    map: z.boolean().optional(),
    reviewRequests: z.boolean().optional(),
    payLinks: z.boolean().optional(),
    showHistory: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "At least one key" });

/**
 * The go-live moment, `feature_flags.historyCutoff` (an ISO timestamp the
 * marking run stores). Org viewers who don't see hidden history see audit
 * entries only from here on. Null when unset or unparseable. Kept apart from
 * `parseFeatures`, whose switches are booleans only.
 */
export function historyCutoff(raw: unknown): Date | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const value = (raw as Record<string, unknown>).historyCutoff;
  if (typeof value !== "string" || value === "") return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at;
}
