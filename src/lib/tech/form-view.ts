/**
 * Technician forms read model types and the pure card assembly (M3d spec §6,
 * §7.2). Client-safe: no db, no server-only imports.
 */
import type { FormField } from "@/lib/forms/form-schema";
import type { FormValues } from "@/lib/forms/form-values";
import type { WriteBlockedReason } from "@/lib/forms/form-gates";

export interface CardSubmission {
  readonly id: string;
  readonly status: "draft" | "submitted";
  readonly revision: number;
  readonly hasAnswers: boolean;
  readonly erased: boolean;
  readonly updatedAt: string;
  readonly submittedAt: string | null;
  readonly submittedByName: string | null;
}

export interface SubmittedOn {
  readonly appointmentId: string;
  readonly appointmentNumber: number;
  readonly submittedAt: string;
}

export interface CardForm {
  readonly formId: string;
  readonly name: string;
  readonly description: string | null;
  readonly required: boolean;
  readonly submission: CardSubmission | null;
  readonly submittedOn: SubmittedOn | null;
}

export interface TechFormsView {
  readonly visitId: string;
  readonly visitNumber: number;
  readonly myVisit: boolean;
  readonly canWrite: boolean;
  readonly writeBlockedReason: WriteBlockedReason | null;
  /** Lead ruling 9: the caller's row on this visit is cancelled (adds the "assign you again" line). */
  readonly myRowCancelled: boolean;
  readonly forms: readonly CardForm[];
  readonly otherForms: ReadonlyArray<{ readonly formId: string; readonly name: string }>;
}

export interface TechFormSubmission {
  readonly id: string;
  readonly status: "draft" | "submitted";
  readonly revision: number;
  /** null when erased or unreadable. */
  readonly values: FormValues | null;
  readonly updatedAt: string;
  readonly updatedByName: string | null;
  readonly updatedByMe: boolean;
  readonly submittedAt: string | null;
  readonly submittedByName: string | null;
  readonly erased: boolean;
}

export interface TechFormView {
  readonly form: { readonly name: string; readonly description: string | null; readonly version: number; readonly fields: readonly FormField[] };
  readonly submission: TechFormSubmission | null;
  readonly submittedOn: SubmittedOn | null;
  readonly myVisit: boolean;
  readonly canWrite: boolean;
  readonly writeBlockedReason: WriteBlockedReason | null;
  readonly myRowCancelled: boolean;
}

export interface FormRowIn {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly required: boolean;
  readonly active: boolean;
  readonly applies: boolean;
}

export interface SubmissionRowIn extends CardSubmission {
  readonly formId: string;
  readonly appointmentId: string;
  readonly appointmentNumber: number;
  readonly visitCounts: boolean;
}

/**
 * `forms` = active applicable forms + forms with a row on this visit;
 * `submittedOn` = the newest submitted copy on another visit that counts, when
 * this visit has no submitted row; order: required and not submitted anywhere
 * first, then name. `otherForms` = active forms not already listed.
 */
export function buildFormsCard(visitId: string, forms: readonly FormRowIn[], subs: readonly SubmissionRowIn[]): {
  forms: CardForm[];
  otherForms: { formId: string; name: string }[];
} {
  const here = new Map(subs.filter((s) => s.appointmentId === visitId).map((s) => [s.formId, s]));
  const listed = forms.filter((f) => (f.active && f.applies) || here.has(f.id));
  const card = listed.map((f): CardForm & { submittedAnywhere: boolean } => {
    const mine = here.get(f.id) ?? null;
    const others = subs
      .filter((s) => s.formId === f.id && s.appointmentId !== visitId && s.status === "submitted" && s.visitCounts && s.submittedAt !== null)
      .sort((a, b) => b.submittedAt!.localeCompare(a.submittedAt!));
    const submittedOn = mine?.status === "submitted" || others.length === 0
      ? null
      : { appointmentId: others[0]!.appointmentId, appointmentNumber: others[0]!.appointmentNumber, submittedAt: others[0]!.submittedAt! };
    const submission: CardSubmission | null = mine
      ? {
          id: mine.id, status: mine.status, revision: mine.revision, hasAnswers: mine.hasAnswers, erased: mine.erased,
          updatedAt: mine.updatedAt, submittedAt: mine.submittedAt, submittedByName: mine.submittedByName,
        }
      : null;
    return {
      formId: f.id, name: f.name, description: f.description, required: f.required, submission, submittedOn,
      submittedAnywhere: mine?.status === "submitted" || submittedOn !== null,
    };
  });
  card.sort((a, b) => {
    const ra = a.required && !a.submittedAnywhere ? 0 : 1;
    const rb = b.required && !b.submittedAnywhere ? 0 : 1;
    return ra - rb || a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
  const listedIds = new Set(listed.map((f) => f.id));
  return {
    forms: card.map(({ submittedAnywhere: _s, ...f }) => f),
    otherForms: forms.filter((f) => f.active && !listedIds.has(f.id)).map((f) => ({ formId: f.id, name: f.name })),
  };
}

/** Required forms on the card with no submitted copy on any visit that counts (the close-out reminder). */
export function unsubmittedRequired(view: TechFormsView | null): ReadonlyArray<{ formId: string; name: string }> {
  if (!view) return [];
  return view.forms
    .filter((f) => f.required && f.submission?.status !== "submitted" && f.submittedOn === null)
    .map((f) => ({ formId: f.formId, name: f.name }));
}
