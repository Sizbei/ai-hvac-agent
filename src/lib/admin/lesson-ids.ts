/**
 * Quick tour stop ids in tour order (onboarding spec D3). No imports, so client
 * code can use the list without pulling zod in through admin-guide-state.
 */
export const LESSON_IDS = ["requests", "schedule", "technicians", "customers", "paid"] as const;
export type LessonId = (typeof LESSON_IDS)[number];
