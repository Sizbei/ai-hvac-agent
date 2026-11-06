/**
 * Pure state rules for the field estimate builder (M3c spec §7.1): option
 * naming, lines, totals, the inline save reason and the sessionStorage draft.
 */
import { computeOptionTotals } from "@/lib/admin/money";
import {
  hasDuplicateNames, MAX_LINES_PER_OPTION, MAX_OPTION_NAME, MAX_OPTIONS, MAX_QUANTITY, type CreateEstimateInput,
} from "./estimate-input";
import { totalsLine } from "./estimate-display";
import type { WriteOutcome } from "./invoice-key-state";

export interface DraftLine {
  readonly key: string;
  readonly pricebookItemId: string;
  readonly name: string;
  /** Display only: the server re-snapshots the price on save. */
  readonly unitPriceCents: number;
  readonly quantity: number;
}

export interface DraftOption {
  readonly key: string;
  readonly name: string;
  /** The technician typed this name: automatic renaming stops. */
  readonly edited: boolean;
  readonly lines: readonly DraftLine[];
}

export type OptionChange =
  | { readonly type: "add"; readonly key: string }
  | { readonly type: "remove"; readonly key: string }
  | { readonly type: "rename"; readonly key: string; readonly name: string };

const TIERS = ["Good", "Better", "Best"] as const;

export function positionalName(index: number, count: number): string {
  if (count === 1) return "Option 1";
  return TIERS[index] ?? `Option ${index + 1}`;
}

const byPosition = (options: readonly DraftOption[]): DraftOption[] =>
  options.map((o, i) => ({ ...o, name: positionalName(i, options.length) }));

export function startOptions(key: string): DraftOption[] {
  return [{ key, name: "Option 1", edited: false, lines: [] }];
}

export function nextOptionNames(options: readonly DraftOption[], change: OptionChange): DraftOption[] {
  switch (change.type) {
    case "add": {
      if (options.length >= MAX_OPTIONS) return [...options];
      const next: DraftOption[] = [...options, { key: change.key, name: "", edited: false, lines: [] }];
      if (!options.some((o) => o.edited)) return byPosition(next);
      return next.map((o, i) => (i === next.length - 1 ? { ...o, name: `Option ${i + 1}` } : o));
    }
    case "remove": {
      if (options.length <= 1) return [...options];
      const rest = options.filter((o) => o.key !== change.key);
      return rest.some((o) => o.edited) ? rest : byPosition(rest);
    }
    case "rename":
      return options.map((o) => (o.key === change.key ? { ...o, name: change.name, edited: true } : o));
  }
}

const withOption = (options: readonly DraftOption[], key: string, fn: (o: DraftOption) => DraftOption): DraftOption[] =>
  options.map((o) => (o.key === key ? fn(o) : o));

/** A pricebook item already on the option raises that line's quantity (capped) instead of a second line. */
export function addLine(options: readonly DraftOption[], optionKey: string, line: DraftLine): DraftOption[] {
  return withOption(options, optionKey, (o) => {
    const same = o.lines.find((l) => l.pricebookItemId === line.pricebookItemId);
    if (!same) return { ...o, lines: [...o.lines, line] };
    const quantity = Math.min(MAX_QUANTITY, same.quantity + line.quantity);
    return { ...o, lines: o.lines.map((l) => (l.key === same.key ? { ...l, quantity } : l)) };
  });
}

export function removeLine(options: readonly DraftOption[], optionKey: string, lineKey: string): DraftOption[] {
  return withOption(options, optionKey, (o) => ({ ...o, lines: o.lines.filter((l) => l.key !== lineKey) }));
}

export function setQuantity(options: readonly DraftOption[], optionKey: string, lineKey: string, quantity: number): DraftOption[] {
  const q = Math.min(MAX_QUANTITY, Math.max(1, Math.trunc(quantity) || 1));
  return withOption(options, optionKey, (o) => ({ ...o, lines: o.lines.map((l) => (l.key === lineKey ? { ...l, quantity: q } : l)) }));
}

export function optionFooter(lines: readonly DraftLine[], taxBps: number): string {
  return totalsLine(computeOptionTotals(lines, taxBps));
}

export const EARLIER_SAVE_WON = "Your earlier save went through. Your newer edits weren't saved.";

/**
 * What the builder does with a save's answer (Task 8 parked): a landed re-send
 * of the earlier, unanswered body is that earlier estimate, so the newer edits
 * were not saved and the technician is told before the estimate opens.
 */
export function afterSave(outcome: WriteOutcome, resentOld: boolean): "open" | "earlier_won" | "message" {
  if (outcome !== "success_refetch" && outcome !== "already_saved_refetch") return "message";
  return resentOld ? "earlier_won" : "open";
}

export type DraftCheck = { readonly ok: true; readonly body: CreateEstimateInput } | { readonly ok: false; readonly reason: string };

export function checkDraft(options: readonly DraftOption[]): DraftCheck {
  if (options.some((o) => o.name.trim() === "")) return { ok: false, reason: "Name every option." };
  if (options.some((o) => o.name.trim().length > MAX_OPTION_NAME)) return { ok: false, reason: "Keep option names to 40 characters." };
  if (hasDuplicateNames(options.map((o) => o.name))) return { ok: false, reason: "Two options have the same name." };
  const empty = options.find((o) => o.lines.length === 0);
  if (empty) return { ok: false, reason: `${empty.name.trim()} needs an item.` };
  const full = options.find((o) => o.lines.length > MAX_LINES_PER_OPTION);
  if (full) return { ok: false, reason: `${full.name.trim()} has more than 40 items.` };
  return {
    ok: true,
    body: { options: options.map((o) => ({ name: o.name.trim(), lines: o.lines.map((l) => ({ pricebookItemId: l.pricebookItemId, quantity: l.quantity })) })) },
  };
}

export const DRAFT_KEY = (requestId: string) => `tech:estimate:${requestId}:draft`;

export function serializeDraft(options: readonly DraftOption[]): string {
  return JSON.stringify({ v: 1, options });
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isLine = (l: unknown): l is DraftLine =>
  isObj(l) && typeof l.key === "string" && typeof l.pricebookItemId === "string" && typeof l.name === "string"
  && Number.isInteger(l.unitPriceCents) && (l.unitPriceCents as number) >= 0
  && Number.isInteger(l.quantity) && (l.quantity as number) >= 1 && (l.quantity as number) <= MAX_QUANTITY;
const isOption = (o: unknown): o is DraftOption =>
  isObj(o) && typeof o.key === "string" && typeof o.name === "string" && typeof o.edited === "boolean"
  && Array.isArray(o.lines) && o.lines.length <= MAX_LINES_PER_OPTION && o.lines.every(isLine);

/** A stored draft, or null when absent, corrupted, from another version or out of bounds. */
export function parseDraft(raw: string | null): DraftOption[] | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(parsed) || parsed.v !== 1 || !Array.isArray(parsed.options)) return null;
  const options = parsed.options;
  if (options.length < 1 || options.length > MAX_OPTIONS || !options.every(isOption)) return null;
  return options as DraftOption[];
}
