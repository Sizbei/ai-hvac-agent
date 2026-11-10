import type { PreviewState } from "@/lib/auth/viewer";

/** The "View as" banner line (spec P7); the Exit control follows it. */
export function previewBannerLine(p: PreviewState): string {
  const name = p.status === "active" ? p.targetName.trim() : "";
  // Plan ruling 9: a target that is no longer an active user of the org.
  if (name === "") return "Viewing as a user who is no longer available · read-only";
  return `Viewing as ${name} · read-only`;
}
