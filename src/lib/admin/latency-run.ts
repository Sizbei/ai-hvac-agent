import type { LatencyRow } from "./latency-stats";

/**
 * Run guards for scripts/agent/measure-latency.mjs (final wave M3, security
 * M4). Signed-in admin page loads write onboarding stamps, so a non-local base
 * needs `--prod` (the user's say-so) and measures read-only through a "View
 * as" cookie when `--preview-as` is given. A dev cookie can't be minted for a
 * remote base, so there it comes from HVAC_PREVIEW.
 */
export type LatencyRunPlan =
  | { readonly ok: false; readonly error: string }
  | {
      readonly ok: true;
      /** "mint": dev cookie via mint-preview-cookie.mjs; "env": HVAC_PREVIEW. */
      readonly preview: "mint" | "env" | null;
      readonly warning: string | null;
    };

export function latencyRunPlan(p: {
  readonly isLocal: boolean;
  readonly prod: boolean;
  readonly previewAs: string;
  readonly envPreviewCookie: boolean;
}): LatencyRunPlan {
  if (p.isLocal) return { ok: true, preview: p.previewAs ? "mint" : null, warning: null };
  if (!p.prod) {
    return { ok: false, error: "Non-local base: pass --prod to measure it (only with the user's say-so)." };
  }
  if (p.previewAs) {
    return p.envPreviewCookie
      ? { ok: true, preview: "env", warning: null }
      : {
          ok: false,
          error: "--preview-as on a non-local base needs HVAC_PREVIEW set to the hvac_preview cookie value.",
        };
  }
  return {
    ok: true,
    preview: null,
    warning:
      "Measuring as the signed-in admin: these page loads write onboarding stamps on the org. " +
      "Pass --preview-as <userId> with HVAC_PREVIEW to measure read-only.",
  };
}

/** 1 when any page never measured a first row (every run failed), else 0. */
export function latencyExitCode(rows: readonly LatencyRow[]): 0 | 1 {
  return rows.length > 0 && rows.every((r) => r.firstRow.length > 0) ? 0 : 1;
}
