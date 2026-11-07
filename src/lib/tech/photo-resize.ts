/**
 * Photo quality and resize plan (M3d spec §7.7). Pure: the browser adapter in
 * `photo-prepare.ts` draws each step; this decides the steps.
 */
import { TECH_UPLOAD_LIMIT_BYTES } from "@/lib/tech/upload-limits";

export type PhotoQuality = "standard" | "high";
export const QUALITY_STORAGE_KEY = "tech:photo-quality";

export interface ResizeStep {
  readonly maxEdge: number;
  readonly jpegQuality: number;
}

export const STEPS: Record<PhotoQuality, readonly ResizeStep[]> = {
  standard: [
    { maxEdge: 1600, jpegQuality: 0.8 },
    { maxEdge: 1600, jpegQuality: 0.7 },
    { maxEdge: 1200, jpegQuality: 0.7 },
    { maxEdge: 900, jpegQuality: 0.7 },
  ],
  high: [
    { maxEdge: 3200, jpegQuality: 0.9 },
    { maxEdge: 3200, jpegQuality: 0.8 },
    { maxEdge: 2400, jpegQuality: 0.7 },
    { maxEdge: 1600, jpegQuality: 0.7 },
  ],
};

export interface DrawStep {
  readonly width: number;
  readonly height: number;
  readonly jpegQuality: number;
}

/** The draw sizes for an image, never upscaling. */
export function resizePlan(quality: PhotoQuality, width: number, height: number): DrawStep[] {
  const longest = Math.max(width, height);
  return STEPS[quality].map((s) => {
    const scale = longest > s.maxEdge ? s.maxEdge / longest : 1;
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), jpegQuality: s.jpegQuality };
  });
}

/** localStorage value → quality (default standard). */
export function qualityFromStorage(raw: string | null): PhotoQuality {
  return raw === "high" ? "high" : "standard";
}

export const fitsUpload = (bytes: number): boolean => bytes <= TECH_UPLOAD_LIMIT_BYTES;

export const PHOTO_CANT_PREPARE = "This photo can't be prepared on this phone. Take it again, or use a smaller photo.";

/** After every step: the first blob that fits; none fits → can't prepare. Decode failed → the original if it fits. */
export function pickPrepared(sizes: readonly number[] | "decode_failed", originalBytes: number): { kind: "step"; index: number } | { kind: "original" } | { kind: "too_large" } {
  if (sizes === "decode_failed") return fitsUpload(originalBytes) ? { kind: "original" } : { kind: "too_large" };
  const i = sizes.findIndex(fitsUpload);
  return i >= 0 ? { kind: "step", index: i } : { kind: "too_large" };
}
