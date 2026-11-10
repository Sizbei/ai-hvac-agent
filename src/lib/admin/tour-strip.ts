import { LESSON_IDS, type LessonId } from "./admin-guide-state";

export interface TourParams {
  readonly lesson: LessonId;
  /** 1-based stop number. */
  readonly n: number;
  readonly href: string;
}

/** `from=tour&lesson=<id>` → the back-to-tour strip's data; null otherwise. */
export function parseTourParams(sp: URLSearchParams): TourParams | null {
  if (sp.get("from") !== "tour") return null;
  const raw = sp.get("lesson");
  const idx = LESSON_IDS.findIndex((id) => id === raw);
  if (idx < 0) return null;
  const lesson = LESSON_IDS[idx];
  const replay = sp.get("replay") === "1" ? "&replay=1" : "";
  return { lesson, n: idx + 1, href: `/admin/setup?lesson=${lesson}${replay}#learn` };
}
