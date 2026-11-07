/**
 * Browser adapter for photo resizing (M3d spec §7.7): decode through an
 * HTMLImageElement (`img.decode()` applies EXIF orientation when drawn), draw
 * straight at each planned size, encode JPEG, stop at the first blob that
 * fits. Re-encoding drops EXIF (GPS and capture time). Client-only.
 */
import { pickPrepared, resizePlan, type PhotoQuality } from "@/lib/tech/photo-resize";

export type Prepared = { readonly ok: true; readonly blob: Blob; readonly name: string } | { readonly ok: false };

function toJpeg(canvas: HTMLCanvasElement, q: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), "image/jpeg", q));
}

export async function preparePhoto(file: File, quality: PhotoQuality): Promise<Prepared> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    try {
      await img.decode();
    } catch {
      const pick = pickPrepared("decode_failed", file.size);
      return pick.kind === "original" ? { ok: true, blob: file, name: file.name } : { ok: false };
    }
    const name = file.name.replace(/\.[^.]+$/, "") + ".jpg";
    for (const step of resizePlan(quality, img.naturalWidth, img.naturalHeight)) {
      const canvas = document.createElement("canvas");
      canvas.width = step.width;
      canvas.height = step.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return { ok: false };
      ctx.drawImage(img, 0, 0, step.width, step.height);
      const blob = await toJpeg(canvas, step.jpegQuality);
      if (blob && pickPrepared([blob.size], file.size).kind === "step") return { ok: true, blob, name };
    }
    return { ok: false };
  } finally {
    URL.revokeObjectURL(url);
  }
}
