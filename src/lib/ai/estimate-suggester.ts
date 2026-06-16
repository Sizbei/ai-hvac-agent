/**
 * AI-assisted estimate drafting (ADMIN-SIDE, review-first).
 *
 * Given a service request + its conversation transcript, an economy-tier LLM
 * SUGGESTS pricebook line items (by catalog id) that fit the described job. An
 * admin reviews/edits the suggestions before any estimate is created — nothing
 * here writes to the DB and nothing here is ever shown to a customer.
 *
 * GUARDRAIL: this does NOT touch the customer-facing chat flow. The live bot has
 * an explicit never-promise-pricing rule (src/lib/ai/system-prompt.ts);
 * suggestions are admin-only.
 *
 * DETERMINISTIC VALIDATION OVER LLM TRUST: the model may hallucinate item ids.
 * Every suggested pricebookItemId is validated against the org's actual catalog
 * (listPricebookItems) and DROPPED if not found. Names and prices in the output
 * come from the CATALOG (server), never from the LLM payload.
 *
 * FAIL SOFT: on any LLM/parse error the function returns an empty suggestions
 * array with a note — it never throws into the route.
 */
import { generateText } from "ai";
import { listPricebookItems } from "@/lib/admin/pricebook-queries";
import { getRequestById } from "@/lib/admin/queries";
import { getExtractionModel } from "./provider";
import { logger } from "@/lib/logger";

/** Max number of suggested lines kept (defensive cap against a runaway model). */
const MAX_SUGGESTIONS = 12;
/** Quantity is clamped into [1, MAX_QUANTITY]. */
const MAX_QUANTITY = 99;
/** Cap transcript length so a long session can't blow the model context window. */
const MAX_TRANSCRIPT_CHARS = 8000;
/** Bound the catalog sent to the model (it picks by id from this list). */
const MAX_CATALOG_ITEMS = 200;

export interface EstimateSuggestion {
  readonly pricebookItemId: string;
  readonly name: string;
  readonly priceCents: number;
  readonly quantity: number;
}

export interface EstimateSuggestionResult {
  readonly suggestions: readonly EstimateSuggestion[];
  readonly note: string;
}

const SYSTEM = `You are a silent estimating assistant for an HVAC company. You help an admin draft an internal estimate; you NEVER talk to the customer and your output is NEVER shown to a customer.

You are given a CATALOG of pricebook items (each with an id, name, type, and price in US cents) and a description of a customer's HVAC problem (plus a conversation transcript). Choose the catalog line items that best fit the job and a quantity for each.

Rules:
- ONLY pick items by their exact catalog id. Never invent an id.
- Pick a small, realistic set of lines (usually 1-6). Quantity is a positive integer.
- Output ONLY a JSON array, no prose, no markdown fences:
[{"pricebookItemId": "<catalog id>", "quantity": <int>, "reason": "<short why>"}]
If nothing in the catalog fits, output [].`;

/** Tolerant JSON-array extraction from a model response (handles fences/prose). */
function parseJsonArray(text: string): unknown[] | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const source = fenced ? fenced[1]! : text;
  const start = source.indexOf("[");
  const end = source.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(source.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Build the catalog block the model picks from (id + name + type + price). */
function catalogPrompt(
  items: readonly { id: string; name: string; type: string; priceCents: number }[],
): string {
  return items
    .map(
      (it) =>
        `${it.id} | ${it.type} | ${it.name} | ${it.priceCents} cents`,
    )
    .join("\n");
}

/** Render the request + transcript as the job context for the model. */
function jobPrompt(req: {
  readonly issueType: string;
  readonly urgency: string;
  readonly description: string;
  readonly transcript: readonly { role: string; content: string }[];
}): string {
  const convo = req.transcript
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => `${m.role === "user" ? "Customer" : "Assistant"}: ${m.content}`)
    .join("\n")
    .slice(-MAX_TRANSCRIPT_CHARS);
  return [
    `Issue type: ${req.issueType}`,
    `Urgency: ${req.urgency}`,
    `Description: ${req.description}`,
    convo ? `\nTranscript:\n${convo}` : "",
  ].join("\n");
}

/**
 * Suggest pricebook line items for a service request. Tenant-scoped, read-only.
 * Returns catalog-sourced name/price for every kept suggestion; fails soft.
 */
export async function suggestEstimateLineItems(
  organizationId: string,
  context: { readonly serviceRequestId?: string },
): Promise<EstimateSuggestionResult> {
  try {
    const { serviceRequestId } = context;
    if (!serviceRequestId) {
      return { suggestions: [], note: "No service request to draft from." };
    }

    const [catalog, request] = await Promise.all([
      listPricebookItems(organizationId),
      getRequestById(organizationId, serviceRequestId),
    ]);

    if (!request) {
      return { suggestions: [], note: "Service request not found." };
    }
    if (catalog.length === 0) {
      return {
        suggestions: [],
        note: "Your pricebook is empty — add items before drafting with AI.",
      };
    }

    // Index the catalog by id for O(1) validation + authoritative name/price.
    const byId = new Map(catalog.map((it) => [it.id, it]));
    const offered = catalog.slice(0, MAX_CATALOG_ITEMS);

    const { text } = await generateText({
      model: getExtractionModel(),
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: `CATALOG (id | type | name | price):\n${catalogPrompt(offered)}\n\nJOB:\n${jobPrompt(request)}`,
        },
      ],
    });

    const rawArray = parseJsonArray(text);
    if (!rawArray) {
      return {
        suggestions: [],
        note: "AI could not produce usable suggestions. Add line items manually.",
      };
    }

    // VALIDATE every entry against the real catalog. Names/prices are taken from
    // the catalog row (server-authoritative), NOT from the LLM payload. Unknown
    // ids are dropped; duplicate ids are kept once; quantity is clamped.
    const seen = new Set<string>();
    const suggestions: EstimateSuggestion[] = [];
    for (const entry of rawArray) {
      if (suggestions.length >= MAX_SUGGESTIONS) break;
      if (typeof entry !== "object" || entry === null) continue;
      const id = (entry as Record<string, unknown>).pricebookItemId;
      if (typeof id !== "string") continue;
      const item = byId.get(id);
      if (!item) continue; // hallucinated / inactive id — drop it
      if (seen.has(item.id)) continue;
      seen.add(item.id);

      const rawQty = (entry as Record<string, unknown>).quantity;
      const qty =
        typeof rawQty === "number" && Number.isFinite(rawQty)
          ? Math.min(MAX_QUANTITY, Math.max(1, Math.floor(rawQty)))
          : 1;

      suggestions.push({
        pricebookItemId: item.id,
        name: item.name, // from catalog, never the LLM
        priceCents: item.priceCents, // from catalog, never the LLM
        quantity: qty,
      });
    }

    const note =
      suggestions.length === 0
        ? "AI found no catalog items that fit. Add line items manually."
        : "AI-suggested lines from your pricebook. Review, edit, or remove before creating the estimate.";

    return { suggestions, note };
  } catch (error) {
    logger.error(
      { error, serviceRequestId: context.serviceRequestId },
      "Estimate suggestion failed (non-fatal)",
    );
    return {
      suggestions: [],
      note: "AI suggestions are unavailable right now. Add line items manually.",
    };
  }
}
