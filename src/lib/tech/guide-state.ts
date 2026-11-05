import { z } from "zod";

/** Getting-started guide state (users.field_guide_state). Imports only zod: safe for client code. */
export const STEP_IDS = [
  "start_job", "finish_job", "clock_in", "share_location", "add_material",
  "note_or_photo", "capture_signature", "build_invoice", "collect_payment",
] as const;
export type StepId = (typeof STEP_IDS)[number];

export interface GuideState {
  hiddenAt?: string;
  firstCompleted: Partial<Record<StepId, string>>;
}

/** The finished card leaves on its own this long after the finish_job stamp. */
export const FINISHED_CARD_MS = 24 * 60 * 60 * 1000;

const isoDate = z.string().refine((s) => !Number.isNaN(Date.parse(s))).optional().catch(undefined);
const stateSchema = z.object({
  hiddenAt: isoDate,
  firstCompleted: z.record(z.string(), z.unknown()).optional().catch(undefined),
});

/** Tolerant parse of the stored jsonb. Never throws. */
export function parseGuideState(raw: unknown): GuideState {
  const parsed = stateSchema.safeParse(raw);
  const s = parsed.success ? parsed.data : {};
  const firstCompleted: GuideState["firstCompleted"] = {};
  for (const id of STEP_IDS) {
    const v = s.firstCompleted?.[id];
    if (typeof v === "string" && !Number.isNaN(Date.parse(v))) firstCompleted[id] = v;
  }
  return s.hiddenAt ? { hiddenAt: s.hiddenAt, firstCompleted } : { firstCompleted };
}

/** Spec §2: hidden by × or 24 h after the stored finish stamp (server clock). */
export function cardHiddenFor(state: GuideState, now: Date): boolean {
  if (state.hiddenAt) return true;
  const finished = state.firstCompleted.finish_job;
  return finished !== undefined && now.getTime() - Date.parse(finished) > FINISHED_CARD_MS;
}
