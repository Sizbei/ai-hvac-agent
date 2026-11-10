/**
 * Quick tour lessons (onboarding spec D3). Pure: copy and links only, so the
 * variants are pinned in node tests. Imports types and a constant from the
 * client-safe guide module.
 */
import {
  HISTORY_CONTACT_FALLBACK,
  type AdminGuidePayload,
  type LessonId,
} from "./admin-guide-state";

export interface LessonContext {
  readonly payLinks: boolean;
  readonly hasFieldPulse: boolean;
  readonly historyHidden: boolean;
  /** Display name to ask for hidden history (never an email). */
  readonly historyContact: string;
}

export interface Lesson {
  readonly id: LessonId;
  readonly title: string;
  readonly copy: string;
  /** "Show me": the real page, tagged so it can lead back to this stop. */
  readonly href: string;
}

/**
 * When `guide` is null or the onboarding GET failed: no FieldPulse or pay-link
 * claims, history note on, generic contact.
 */
export const CONSERVATIVE_LESSON_CONTEXT: LessonContext = Object.freeze({
  payLinks: false,
  hasFieldPulse: false,
  historyHidden: true,
  historyContact: HISTORY_CONTACT_FALLBACK,
});

export function lessonContext(guide: AdminGuidePayload | null): LessonContext {
  if (!guide) return CONSERVATIVE_LESSON_CONTEXT;
  return {
    payLinks: guide.payLinks,
    hasFieldPulse: guide.hasFieldPulse,
    historyHidden: guide.historyHidden,
    historyContact: guide.historyContact,
  };
}

const showMe = (page: string, id: LessonId) => `${page}?from=tour&lesson=${id}`;
const join = (...parts: (string | false)[]) => parts.filter(Boolean).join(" ");

function requestsLead(ctx: LessonContext): string | false {
  if (!ctx.hasFieldPulse) return false;
  return ctx.historyHidden
    ? "Your upcoming FieldPulse work carried over as requests."
    : "Your FieldPulse jobs are requests here.";
}

function historyNote(ctx: LessonContext): string | false {
  if (!ctx.historyHidden) return false;
  const records = ctx.hasFieldPulse ? "Older FieldPulse records" : "Older records";
  return `${records} are hidden for a clean start. Ask ${ctx.historyContact} if you need them back.`;
}

/** The five stops, in order, with the D3 variants applied. */
export function buildLessons(ctx: LessonContext): readonly Lesson[] {
  return [
    {
      id: "requests",
      title: "Requests come to you",
      copy: join(
        requestsLead(ctx),
        "Calls, texts and website chat arrive as requests with the problem and contact already filled in.",
      ),
      href: showMe("/admin/requests", "requests"),
    },
    {
      id: "schedule",
      title: "Book and assign",
      copy: "Give a request a time and a technician in one dialog. The calendar shows everyone’s day.",
      href: showMe("/admin/calendar", "schedule"),
    },
    {
      id: "technicians",
      title: "Your team works from their phones",
      copy: "Technicians see their requests, notes and photos on their phone, and their own guide walks them through it.",
      href: showMe("/admin/staff", "technicians"),
    },
    {
      id: "customers",
      title: "Every customer in one place",
      copy: join(
        "Each customer’s requests, equipment, estimates and invoices live on their page.",
        historyNote(ctx),
      ),
      href: showMe("/admin/customers", "customers"),
    },
    {
      id: "paid",
      title: "Getting paid",
      copy: join(
        "See what’s owed at a glance, and turn an accepted estimate into an invoice.",
        ctx.payLinks && "Text a pay link so customers can pay by phone.",
      ),
      href: showMe("/admin/invoices", "paid"),
    },
  ];
}
