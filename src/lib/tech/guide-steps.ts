import type { Features } from "@/lib/tenancy/feature-flags";
import type { GuideState, StepId } from "./guide-state";

/** Step table + pure derivation (spec §3/§4). Imports only types: safe for client code. */

export interface StepDef {
  id: StepId;
  group: "run" | "further";
  title: string;
  why: string;
  how: string;
  required: boolean;
  leadOnly: boolean;
}

export interface DerivedStep extends StepDef {
  done: boolean;
  note?: string;
}

export interface GuideProgress {
  requiredDone: number;
  requiredTotal: 2;
  optionalDone: number;
  optionalTotal: 7;
}

export interface Signals {
  startJob: boolean;
  finishJob: boolean;
  clockIn: boolean;
  shareLocation: boolean;
  addMaterial: boolean;
  noteOrPhoto: boolean;
  captureSignature: boolean;
  buildInvoice: boolean;
  collectPayment: boolean;
  hasOpenJob: boolean;
  state: GuideState;
}

export interface GuidePayload {
  steps: DerivedStep[];
  progress: GuideProgress;
  upNext: StepId | null;
  finished: boolean;
  hasOpenJob: boolean;
  hiddenAt: string | null;
  cardHidden: boolean;
}

export const NO_JOB_NOTE = "The office hasn't assigned you a job yet. It shows in your jobs when they do.";

const run = (id: StepId, title: string, why: string, how: string): StepDef =>
  ({ id, group: "run", title, why, how, required: true, leadOnly: false });
const further = (id: StepId, title: string, why: string, how: string, leadOnly = false): StepDef =>
  ({ id, group: "further", title, why, how, required: false, leadOnly });

export const STEP_DEFS: readonly StepDef[] = [
  run("start_job", "Start your first job", "Each tap tells the office you're on the way, on site and working, so nobody has to call you.", "Open your job in the list. Tap On my way when you leave. Tap I've arrived at the door, then Working."),
  run("finish_job", "Finish a job", "Done tells the office your part is finished. Close out finishes the whole request.", "Tap Done when your part is finished. If Close out shows instead, tap that."),
  further("clock_in", "Clock in for the day", "Your hours land on the office timesheet without a paper form.", "Tap Clock in for the day at the top of your jobs. Tap Clock out when you're done."),
  further("share_location", "Share your location while working", "Dispatch sends the nearest technician to the next job.", "Turn on Share my location at the top of the screen."),
  further("add_material", "Add a part you used", "Parts you add here land on the invoice, so nothing is billed from memory.", "On the job, under Materials used, pick an item from the pricebook or type one in, then tap Add."),
  further("note_or_photo", "Add a note or a photo", "The office and the next technician see what you saw.", "On the job, write an on-site note and tap Save note, or add a photo under Photos."),
  further("capture_signature", "Get the customer's signature", "Proof the work was approved, kept on the job.", "On the job, under Customer signature, hand the phone to the customer, then tap Save signature. Only the lead technician can do this.", true),
  further("build_invoice", "Build the invoice and get it approved", "The invoice goes out while you're still on site.", "On the job, tap Open invoice, then Create invoice if there isn't one. Check the lines, tap Customer approval, and have the customer sign and tap Approve and finalize. Only the lead technician builds the invoice.", true),
  further("collect_payment", "Collect payment on site", "Cash and checks are recorded on the spot. A pay link lets the customer pay by phone.", "After the customer approves, record cash or a check in the sheet that opens, or tap Send pay link.", true),
];

const SIGNAL_KEY: Record<StepId, keyof Omit<Signals, "hasOpenJob" | "state">> = {
  start_job: "startJob", finish_job: "finishJob", clock_in: "clockIn", share_location: "shareLocation",
  add_material: "addMaterial", note_or_photo: "noteOrPhoto", capture_signature: "captureSignature",
  build_invoice: "buildInvoice", collect_payment: "collectPayment",
};

const PAY_LINK_WHY = " A pay link lets the customer pay by phone.";
const PAY_LINK_HOW = ", or tap Send pay link.";

/** Drops the pay-link clauses from collect_payment when the org has pay links off. */
function withFeatures(def: StepDef, features: Pick<Features, "payLinks">): StepDef {
  if (def.id !== "collect_payment" || features.payLinks) return def;
  return { ...def, why: def.why.replace(PAY_LINK_WHY, ""), how: def.how.replace(PAY_LINK_HOW, ".") };
}

/** First not-done required step, else first not-done optional step. */
export function upNext(steps: readonly DerivedStep[]): StepId | null {
  return (steps.find((s) => s.required && !s.done) ?? steps.find((s) => !s.required && !s.done))?.id ?? null;
}

export function deriveGuide(s: Signals, now: Date, features: Pick<Features, "payLinks">): {
  steps: DerivedStep[]; progress: GuideProgress; upNext: StepId | null; finished: boolean;
  newStamps: Partial<Record<StepId, string>>;
} {
  const nowIso = now.toISOString();
  const newStamps: Partial<Record<StepId, string>> = {};
  const steps = STEP_DEFS.map((rawDef) => {
    const def = withFeatures(rawDef, features);
    const stamped = Boolean(s.state.firstCompleted[def.id]);
    const live = s[SIGNAL_KEY[def.id]];
    const done = stamped || live;
    if (!stamped && live) newStamps[def.id] = nowIso;
    const note = def.id === "start_job" && !done && !s.hasOpenJob ? NO_JOB_NOTE : undefined;
    return { ...def, done, ...(note ? { note } : {}) };
  });
  const count = (required: boolean) => steps.filter((x) => x.required === required && x.done).length;
  const requiredDone = count(true);
  return {
    steps,
    progress: { requiredDone, requiredTotal: 2, optionalDone: count(false), optionalTotal: 7 },
    upNext: upNext(steps),
    finished: requiredDone === 2,
    newStamps,
  };
}
