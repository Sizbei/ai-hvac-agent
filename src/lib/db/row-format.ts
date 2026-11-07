/** Raw-row formatting shared by the M3d readers and writers (neon-http rows hold strings or Dates). */
export const iso = (v: unknown): string => new Date(v as string | Date).toISOString();
export const isoOrNull = (v: unknown): string | null => (v == null ? null : iso(v));
export const strOrNull = (v: unknown): string | null => (v == null ? null : String(v));
