import type { Signals, StepId } from "./onboarding-state";

/**
 * Setup-guide step table + pure derivation (spec §3/§4). Imports only types:
 * safe for client code (never import @/lib/db or server-only here).
 */

export interface StepDef {
  id: StepId;
  phase: 1 | 2 | 3;
  title: string;
  why: string;
  estimateMinutes: number | null;
  estimateLabel: string;
  required: boolean;
  live: boolean;
  href: string | null;
  hrefLabel: string;
  secondaryHref?: string;
  secondaryLabel?: string;
}

export interface DerivedStep extends Omit<StepDef, "live"> {
  done: boolean;
  needsAttention: boolean;
  note?: string;
  action?: "copy_sign_in_link";
  copyValue?: string;
  /** One string; the Google clause is appended as a second sentence. */
  instruction?: string;
}

export interface Derived {
  steps: DerivedStep[];
  stamped: Partial<Record<StepId, true>>;
  progress: {
    requiredDone: number;
    requiredTotal: 4;
    optionalDone: number;
    optionalTotal: 4;
  };
  upNext: StepId | null;
  newStamps: Partial<Record<StepId, string>>;
}

export interface OnboardingPayload {
  steps: DerivedStep[];
  progress: Derived["progress"];
  upNext: StepId | null;
  dismissedAt: string | null;
  completedSeenAt: string | null;
  demo: boolean;
}

export interface DeriveOptions {
  now: Date;
  demo: boolean;
  googleEnabled: boolean;
  appUrl: string;
}

const min = (n: number) => ({ estimateMinutes: n, estimateLabel: `~${n} min` });

export const STEP_DEFS: readonly StepDef[] = [
  { id: "phone_hours", phase: 1, title: "Add your business phone and hours", why: "The assistant tells callers when you're open and how to reach you.", ...min(3), required: true, live: false, href: "/admin/settings?tab=business&from=setup", hrefLabel: "Open business info" },
  { id: "brand", phase: 1, title: "Add your logo", why: "Your portal, chat widget and emails carry your brand.", ...min(2), required: false, live: false, href: "/admin/settings?tab=branding&from=setup", hrefLabel: "Open branding" },
  { id: "add_technician", phase: 2, title: "Add a technician", why: "Requests need someone who can sign in on a phone and run them. Running them yourself? Add yourself with a second email.", ...min(3), required: true, live: true, href: "/admin/staff?new=technician&from=setup", hrefLabel: "Add technician", secondaryHref: "/admin/staff?new=invite&from=setup", secondaryLabel: "Invite by link" },
  { id: "pricebook", phase: 2, title: "Add your first price", why: "Estimates and invoices pull from the pricebook.", ...min(5), required: false, live: false, href: "/admin/pricebook?new=1&from=setup", hrefLabel: "Add price", secondaryHref: "/admin/fieldpulse-import", secondaryLabel: "Import from FieldPulse" },
  { id: "book_first_request", phase: 3, title: "Book your first request", why: "Add the customer, the problem, a time and a technician in one dialog.", ...min(4), required: true, live: true, href: "/admin/requests?new=1&from=setup", hrefLabel: "New request" },
  { id: "tech_sign_in", phase: 3, title: "Have a technician sign in on their phone", why: "They see the requests assigned to them and run them from there.", estimateMinutes: null, estimateLabel: "When they're ready", required: true, live: false, href: null, hrefLabel: "Copy sign-in link" },
  { id: "chat_widget", phase: 3, title: "Add the chat widget to your website", why: "Customers book while you sleep.", ...min(5), required: false, live: false, href: "/admin/settings?tab=embed&from=setup", hrefLabel: "Open embed settings" },
  { id: "integrations", phase: 3, title: "Bring in data from your other tools", why: "FieldPulse, Housecall Pro or Google Calendar, so nothing is typed twice.", estimateMinutes: null, estimateLabel: "Depends on the tool", required: false, live: false, href: "/admin/integrations", hrefLabel: "Open integrations" },
];

const SIGN_IN_INSTRUCTION =
  "Open it on the technician's phone and sign in with their email and password.";
const SIGN_IN_GOOGLE_CLAUSE =
  " Use the password, not Google, if this email also signs in to the office.";
const FP_PRIMARY = { href: "/admin/staff?from=setup", hrefLabel: "Set a password in Staff" };
/**
 * add_technician while technicians exist but none can sign in: the generic
 * "Add a technician" made owners add duplicates instead of setting a password.
 */
const PASSWORDLESS_TITLE = "Give a technician a way to sign in";
const PASSWORDLESS_WHY = "Requests need a technician who can sign in on a phone and run them.";
const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

function rule(id: StepId, s: Signals, demo: boolean): boolean {
  switch (id) {
    case "phone_hours":
      return s.phone && s.businessHours;
    case "brand":
      return s.logoUrl;
    case "add_technician":
      return s.technicianReady;
    case "pricebook":
      return s.pricebook;
    case "book_first_request":
      return s.bookedAssigned;
    case "tech_sign_in":
      return Boolean(s.state.flags.techSignedInAt) || s.techSignedIn || demo;
    case "chat_widget":
      return s.widgetKey && (s.state.flags.embedCopied === true || s.allowedOrigins);
    case "integrations":
      return s.integrationConnected;
  }
}

function fieldPulseNote(count: number, googleEnabled: boolean): string {
  const who = count === 1 ? "1 technician" : `${count} technicians`;
  const fix = googleEnabled
    ? "Have them sign in with Google, or use Reset password in Staff."
    : "Use Reset password in Staff.";
  return `${who} from FieldPulse can't sign in yet. ${fix}`;
}

function passwordlessNote(count: number, googleEnabled: boolean): string {
  const who = count === 1 ? "1 technician is" : `${count} technicians are`;
  const fix = googleEnabled
    ? "Use Reset password in Staff to set one, or have them sign in with Google."
    : "Use Reset password in Staff to set one.";
  return `${who} in Staff but can't sign in yet: no password. ${fix}`;
}

function noteFor(id: StepId, s: Signals, googleEnabled: boolean): string | undefined {
  if (id === "phone_hours" && s.phone !== s.businessHours) {
    return "Add both a phone number and hours.";
  }
  if (id === "add_technician") {
    if (s.fpPasswordless > 0) return fieldPulseNote(s.fpPasswordless, googleEnabled);
    if (s.passwordless > 0) return passwordlessNote(s.passwordless, googleEnabled);
    if (s.pendingInvite) return "Waiting for an invite to be accepted.";
  }
  if (id === "book_first_request" && s.anyRequest && !s.bookedAssigned) {
    return "Pick a time and a technician in the request.";
  }
  return undefined;
}

function toDerivedStep(
  def: StepDef,
  s: Signals,
  opts: DeriveOptions,
  flags: { done: boolean; needsAttention: boolean },
): DerivedStep {
  const { live: _live, secondaryHref, secondaryLabel, ...base } = def;
  const fpSwitch =
    def.id === "add_technician" && (s.fpPasswordless > 0 || s.passwordless > 0) && !flags.done;
  const note = noteFor(def.id, s, opts.googleEnabled);
  return {
    ...base,
    ...(fpSwitch ? { ...FP_PRIMARY, title: PASSWORDLESS_TITLE, why: PASSWORDLESS_WHY } : {}),
    ...(secondaryHref && !fpSwitch ? { secondaryHref, secondaryLabel } : {}),
    ...flags,
    ...(note ? { note } : {}),
    ...(def.id === "tech_sign_in" ? signInAction(opts) : {}),
  };
}

/** Without an app URL there is nothing to copy: the instruction only. */
function signInAction(opts: DeriveOptions): Pick<DerivedStep, "action" | "copyValue" | "instruction"> {
  const instruction = SIGN_IN_INSTRUCTION + (opts.googleEnabled ? SIGN_IN_GOOGLE_CLAUSE : "");
  const base = opts.appUrl.replace(/\/+$/, "");
  if (!base) return { instruction };
  return { action: "copy_sign_in_link", copyValue: `${base}/tech-login`, instruction };
}

/** First not-done required step in order, else first not-done optional. */
export function upNext(steps: readonly DerivedStep[]): StepId | null {
  const next =
    steps.find((s) => s.required && !s.done) ?? steps.find((s) => !s.required && !s.done);
  return next?.id ?? null;
}

export function deriveSteps(s: Signals, opts: DeriveOptions): Derived {
  const nowIso = opts.now.toISOString();
  const stamped: Partial<Record<StepId, true>> = {};
  const newStamps: Partial<Record<StepId, string>> = {};
  const steps = STEP_DEFS.map((def) => {
    const isStamped = Boolean(s.state.firstCompleted[def.id]);
    const ok = rule(def.id, s, opts.demo);
    const done = def.live ? ok : ok || isStamped;
    if (isStamped) stamped[def.id] = true;
    else if (done) newStamps[def.id] = nowIso;
    return toDerivedStep(def, s, opts, { done, needsAttention: def.live && isStamped && !ok });
  });
  const count = (required: boolean) =>
    steps.filter((x) => x.required === required && x.done).length;
  return {
    steps,
    stamped,
    progress: { requiredDone: count(true), requiredTotal: 4, optionalDone: count(false), optionalTotal: 4 },
    upNext: upNext(steps),
    newStamps,
  };
}

/**
 * Grandfathering for orgs that predate the guide (spec §4): only on the first
 * GET (no `firstSeenAt` stored yet), while the state has no stamps, and never
 * for the demo org. Keys already present in the state are omitted.
 */
export function grandfatherDecision(
  s: Signals,
  d: Derived,
  now: Date,
  opts: { demo?: boolean } = {},
): { dismissedAt?: string; completedSeenAt?: string } {
  if (opts.demo || s.state.firstSeenAt || Object.keys(s.state.firstCompleted).length > 0) {
    return {};
  }
  const nowIso = now.toISOString();
  if (d.progress.requiredDone === d.progress.requiredTotal) {
    return s.state.completedSeenAt ? {} : { completedSeenAt: nowIso };
  }
  const created = s.orgCreatedAt ? Date.parse(s.orgCreatedAt) : Number.NaN;
  const old = !Number.isNaN(created) && now.getTime() - created > FOURTEEN_DAYS_MS;
  if (old && s.completedRequest) {
    return s.state.dismissedAt ? {} : { dismissedAt: nowIso };
  }
  return {};
}
