/**
 * Pure "did my write land?" check for the field invoice page (spec §7.6). After
 * a network error, a 5xx or IN_PROGRESS the client refetches the GET and asks
 * whether the state advanced; if so the intent is dropped and the refetched
 * state shown, else "Try again" re-sends with the SAME key.
 *
 * The GET's lines carry no pricebook/material id, so a pricebook add_line is
 * judged by a NEW line matching the intent's name/unit price/quantity, and a
 * material add by the material leaving `materialsNotOnInvoice`.
 */
import type { TechInvoice, TechInvoiceView } from "./invoice-view";
import type { KeyState, OutcomeEventType, WriteOutcome } from "./invoice-key-state";

export type Intent =
  | { kind: "create" }
  | {
      kind: "add_line";
      pricebookItemId?: string;
      jobMaterialId?: string;
      /** The expected line (pricebook adds): a NEW line must match every field given. */
      name?: string;
      unitPriceCents?: number;
      quantity?: number;
    }
  | { kind: "remove_line"; lineId: string }
  | { kind: "finalize" }
  | { kind: "payment"; amountCents: number; method: string }
  | { kind: "pay_link" }
  | { kind: "signature" };

export type IntentKind = Intent["kind"];

/** The full (lead) invoice, or null for none / the helper's reduced view. */
export function fullInvoice(v: TechInvoiceView): TechInvoice | null {
  return v.invoice && "lines" in v.invoice ? v.invoice : null;
}

const ids = (xs: readonly { id: string }[] | undefined): Set<string> => new Set((xs ?? []).map((x) => x.id));

export function intentLanded(intent: Intent, before: TechInvoiceView, after: TechInvoiceView): boolean {
  // A write is still in flight: its result is not visible yet, so wait instead.
  if (after.pendingWrite) return false;
  const b = fullInvoice(before);
  const a = fullInvoice(after);
  switch (intent.kind) {
    case "create":
      // A NEW draft (before may be null or the paid/refunded invoice shown read-only).
      return after.invoice !== null && after.invoice.id !== before.invoice?.id;
    case "add_line": {
      if (!a) return false;
      const had = ids(b?.lines);
      const newLine = a.lines.some(
        (l) =>
          !had.has(l.id) &&
          (intent.name === undefined || l.name === intent.name) &&
          (intent.unitPriceCents === undefined || l.unitPriceCents === intent.unitPriceCents) &&
          (intent.quantity === undefined || l.quantity === intent.quantity),
      );
      if (intent.jobMaterialId) {
        const id = intent.jobMaterialId;
        return (
          before.materialsNotOnInvoice.some((m) => m.id === id) &&
          !after.materialsNotOnInvoice.some((m) => m.id === id) &&
          newLine
        );
      }
      return newLine;
    }
    case "remove_line":
      return !!b && b.lines.some((l) => l.id === intent.lineId) && !!a && !a.lines.some((l) => l.id === intent.lineId);
    case "finalize":
      return b?.state === "draft" && !!a && a.state !== "draft";
    case "payment": {
      if (!a) return false;
      const had = ids(b?.payments);
      return a.payments.some(
        (p) => !had.has(p.id) && p.amountCents === intent.amountCents && p.method === intent.method,
      );
    }
    case "pay_link":
      // No observable change: only the stored replay decides.
      return false;
    case "signature":
      return !!a && a.signature.signedAt !== null && a.signature.signedAt !== (b?.signature.signedAt ?? null);
  }
}

/**
 * What `write()` does with the state returned by `edit` (spec §7.5):
 * armed → send; unknown with the same body → re-send with the same key;
 * unknown with a CHANGED body → re-send the OLD body first (never a new key
 * while the previous intent is unknown); sent (a double tap) or idle → skip.
 */
export function sendPlan(pre: KeyState, bodyHash: string): "send" | "resend_stored" | "skip" {
  if (pre.phase === "armed") return "send";
  if (pre.phase === "unknown") return pre.bodyHash === bodyHash ? "send" : "resend_stored";
  return "skip";
}

/**
 * The result kind `write()` reports. pending = the server still holds the key
 * (IN_PROGRESS) after the 2 s wait: not an error, just "Still saving".
 * already_saved_refetch = a replay said the write is already stored: done.
 */
export type WriteStatus = "done" | "dropped" | "retry" | "pending" | "error" | "skipped";

export function writeStatus(outcome: WriteOutcome, ev: OutcomeEventType | null): WriteStatus {
  if (outcome === "success_refetch" || outcome === "already_saved_refetch") return "done";
  if (ev === "dropped") return "dropped";
  if (ev === "unknown") return outcome === "wait_then_refetch" ? "pending" : "retry";
  return "error";
}

/** Rebuild the intent of a persisted body (reload recovery / "Try again"). */
export function intentFromBody(kind: IntentKind, body: unknown): Intent {
  const b = (body ?? {}) as Record<string, unknown>;
  const s = (k: string) => (typeof b[k] === "string" ? (b[k] as string) : undefined);
  switch (kind) {
    case "add_line": {
      const base = { kind, pricebookItemId: s("pricebookItemId"), jobMaterialId: s("jobMaterialId") } as const;
      return typeof b.quantity === "number" ? { ...base, quantity: b.quantity } : base;
    }
    case "remove_line":
      return { kind, lineId: s("lineId") ?? "" };
    case "payment":
      return { kind, amountCents: Number(b.amountCents ?? 0), method: s("method") ?? "" };
    case "create":
    case "finalize":
    case "pay_link":
    case "signature":
      return { kind };
  }
}
