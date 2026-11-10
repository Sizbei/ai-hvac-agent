import { z } from "zod";

/**
 * Per-user admin guide state (users.admin_guide_state, onboarding spec D1):
 * the welcome row and the quick tour. Imports only zod: safe for client code.
 */
export const LESSON_IDS = ["requests", "schedule", "technicians", "customers", "paid"] as const;
export type LessonId = (typeof LESSON_IDS)[number];

export interface AdminGuideState {
  welcomeDismissedAt?: string;
  tourStartedAt?: string;
  tourCompletedAt?: string;
  lastLesson?: LessonId;
}

/** The `guide` part of GET /api/admin/onboarding. */
export interface AdminGuidePayload {
  welcomeDue: boolean;
  lastLesson: LessonId | null;
  tourStartedAt: string | null;
  tourCompletedAt: string | null;
  readOnly: boolean;
  payLinks: boolean;
  hasFieldPulse: boolean;
  historyHidden: boolean;
  historyContact: string;
}

export const HISTORY_CONTACT_FALLBACK = "your account administrator";

const isoDate = z.string().refine((s) => !Number.isNaN(Date.parse(s))).optional().catch(undefined);
const stateSchema = z.object({
  welcomeDismissedAt: isoDate,
  tourStartedAt: isoDate,
  tourCompletedAt: isoDate,
  lastLesson: z.enum(LESSON_IDS).optional().catch(undefined),
});

/** Tolerant parse of the stored jsonb: unknown keys and bad values are dropped. Never throws. */
export function parseAdminGuideState(raw: unknown): AdminGuideState {
  const parsed = stateSchema.safeParse(raw);
  if (!parsed.success) return {};
  return Object.fromEntries(
    Object.entries(parsed.data).filter(([, v]) => v !== undefined),
  ) as AdminGuideState;
}

/** Admin-tier, and neither "Not now" nor Finish has happened. */
export function welcomeDue(role: string, state: AdminGuideState): boolean {
  const adminTier = role === "admin" || role === "super_admin";
  return adminTier && !state.welcomeDismissedAt && !state.tourCompletedAt;
}

/** PATCH /api/admin/guide body: strict, at least one key. */
export const guidePatchSchema = z
  .strictObject({
    dismissWelcome: z.literal(true).optional(),
    lesson: z.enum(LESSON_IDS).optional(),
    tourCompleted: z.literal(true).optional(),
  })
  .refine((v) => v.dismissWelcome === true || v.lesson !== undefined || v.tourCompleted === true, {
    message: "At least one field is required",
  });
export type GuidePatch = z.infer<typeof guidePatchSchema>;

export type WriteOnceKey = "welcomeDismissedAt" | "tourStartedAt" | "tourCompletedAt";

/**
 * What a PATCH writes: write-once timestamps (a stored value wins in the SQL
 * merge) and `lastLesson` (always overwritten). `lesson` also offers
 * `tourStartedAt`, so the first lesson starts the tour.
 */
export function guidePatchWrites(
  patch: GuidePatch,
  nowIso: string,
): { writeOnce: Partial<Record<WriteOnceKey, string>>; lastLesson?: LessonId } {
  return {
    writeOnce: {
      ...(patch.dismissWelcome ? { welcomeDismissedAt: nowIso } : {}),
      ...(patch.lesson ? { tourStartedAt: nowIso } : {}),
      ...(patch.tourCompleted ? { tourCompletedAt: nowIso } : {}),
    },
    ...(patch.lesson ? { lastLesson: patch.lesson } : {}),
  };
}

/**
 * The payload for one viewer. `state` is null for a stale preview (no subject
 * user): never due, no progress.
 */
export function buildGuidePayload(input: {
  state: AdminGuideState | null;
  role: string;
  readOnly: boolean;
  payLinks: boolean;
  hasFieldPulse: boolean;
  historyHidden: boolean;
  contactName: string | null;
}): AdminGuidePayload {
  const state = input.state ?? {};
  return {
    welcomeDue: input.state !== null && welcomeDue(input.role, state),
    lastLesson: state.lastLesson ?? null,
    tourStartedAt: state.tourStartedAt ?? null,
    tourCompletedAt: state.tourCompletedAt ?? null,
    readOnly: input.readOnly,
    payLinks: input.payLinks,
    hasFieldPulse: input.hasFieldPulse,
    historyHidden: input.historyHidden,
    historyContact: input.contactName?.trim() || HISTORY_CONTACT_FALLBACK,
  };
}
