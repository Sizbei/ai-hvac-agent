import { generateText } from 'ai';
import { getExtractionModel } from './provider';
import {
  extractionSchema,
  issueTypeValues,
  urgencyValues,
  type ExtractionResult,
} from './extraction-schema';
import { sanitizeInput, validateExtractionOutput, type GuardrailResult } from './guardrails';
import { trackAICall } from './metrics';

export interface Message {
  role: 'user' | 'assistant';
  content: string;
}

export interface ExtractionPipelineResult {
  extraction: ExtractionResult;
  tokensUsed: number;
  guardrailResult: GuardrailResult;
  validOutput: boolean;
}

/**
 * The exact JSON shape we ask the model to return. We instruct + parse rather
 * than use `generateObject`'s strict `json_schema` structured-output mode, which
 * the Qwen/DashScope OpenAI-compatible endpoint does NOT honor (it returns prose
 * or fenced text the SDK can't parse → AI_JSONParseError on every turn).
 */
const JSON_INSTRUCTION = `Respond with ONLY a single JSON object (no prose, no markdown fences) of this exact shape:
{"issueType": string|null, "urgency": string|null, "address": string|null, "customerName": string|null, "customerPhone": string|null, "customerEmail": string|null, "description": string, "isHvacRelated": boolean}
issueType ∈ ${JSON.stringify(issueTypeValues)} or null.
urgency ∈ ${JSON.stringify(urgencyValues)} or null.
Use null for any field not yet mentioned. description is a brief 1-2 sentence summary.`;

/**
 * Extraction-only system prompt. Deliberately does NOT reuse the conversational
 * SYSTEM_PROMPT: that persona ("be warm", "greet with Hi I'm your HVAC
 * assistant", "ask one question at a time") makes the model reply with chat text
 * instead of JSON on many turns, so the parser falls back to an empty result and
 * the intake stepper never updates. This is a silent classifier — no persona.
 */
const EXTRACTION_SYSTEM = `You are a silent data-extraction function for an HVAC service-intake system. You NEVER greet, chat, apologize, or ask questions. Read the conversation and output ONLY a JSON object describing what the customer has told us.

Map the problem to the closest allowed issueType; use "other" if it is clearly an HVAC issue but fits no category, and null only if no issue has been described. Infer urgency from context: emergency = no heat in freezing weather, gas smell, CO alarm, or flooding; high = AC out in extreme heat, heat out in the cold, or an active water leak; medium = reduced efficiency, noises, or thermostat problems; low = maintenance, filters, or general questions.

When the customer gives a full name (first and last), capture both as customerName. When they give a complete address (street, city, state, and ZIP), capture the full address rather than only a fragment.

${JSON_INSTRUCTION}`;

/**
 * The single repair re-prompt. Terse on purpose: the model already saw the full
 * conversation + the shape on the first call; this just insists on raw JSON. Used
 * only after the first reply failed to parse / validate (see extractServiceRequest).
 */
const REPAIR_INSTRUCTION = `Your previous reply was not valid JSON. Return ONLY a single JSON object matching the exact shape above — no prose, no markdown fences, no extra keys. ${JSON_INSTRUCTION}`;

const EMPTY_EXTRACTION: ExtractionResult = {
  issueType: null,
  urgency: null,
  address: null,
  customerName: null,
  customerPhone: null,
  customerEmail: null,
  description: '',
  isHvacRelated: false,
};

const NULLISH = new Set(['', 'null', 'none', 'n/a', 'na', 'unknown', 'not provided']);

function nullify(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return NULLISH.has(trimmed.toLowerCase()) ? null : trimmed;
}

/**
 * Scan `text` for balanced top-level `{...}` objects via brace-depth matching
 * (string- and escape-aware so braces inside JSON string values don't fool the
 * counter). Returns every balanced object substring found, in source order.
 * Pure + exported for unit testing.
 *
 * Why not a single regex / indexOf: a chatty model can emit prose that contains
 * stray braces, OR several objects (a "thinking" object then the answer). A flat
 * `indexOf('{')..lastIndexOf('}')` slice grabs from the FIRST brace to the LAST,
 * which spans across two objects and yields invalid JSON. Depth-matching gives us
 * each real object so the caller can pick the last valid one.
 */
export function findBalancedObjects(text: string): string[] {
  const objects: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start !== -1) {
          objects.push(text.slice(start, i + 1));
          start = -1;
        }
      }
    }
  }
  return objects;
}

/**
 * Pull a JSON object out of a model response that may be fenced or chatty.
 * Tolerant by design: strips ```json``` fences, ignores leading/trailing prose,
 * and when multiple balanced objects are present returns the LAST one that
 * actually parses (the answer typically follows any preamble/"thinking" object).
 * Returns the raw object string, or null when nothing balanced/parseable exists.
 * Exported for unit testing.
 */
export function extractJsonBlock(text: string): string | null {
  // Prefer fenced content when present (the model was told NOT to fence, but
  // Qwen often does anyway); fall back to the whole text otherwise.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const source = fenced ? fenced[1] : text;

  const objects = findBalancedObjects(source);
  if (objects.length === 0) {
    // No balanced object in the fenced region — retry against the full text in
    // case the fence was unterminated and swallowed the real object.
    if (fenced) {
      const fallback = findBalancedObjects(text);
      return pickParseableObject(fallback);
    }
    return null;
  }
  return pickParseableObject(objects);
}

/** Return the LAST object string that JSON.parses to an object, else null. */
function pickParseableObject(objects: string[]): string | null {
  for (let i = objects.length - 1; i >= 0; i--) {
    try {
      const parsed: unknown = JSON.parse(objects[i]);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return objects[i];
      }
    } catch {
      // try the next-earlier object
    }
  }
  return null;
}

/** Result of a tolerant parse: the extraction plus whether the model actually
 * produced usable structured output (false when we fell back to EMPTY). The
 * repair pass keys off `ok` to decide whether one re-prompt is worth it. */
export interface ParsedExtraction {
  readonly extraction: ExtractionResult;
  readonly ok: boolean;
}

/**
 * Parse a model response into a validated ExtractionResult. Tolerant by design:
 * coerces nullish strings to null, drops out-of-enum / invalid values rather
 * than throwing, and returns an all-null extraction if nothing usable is found.
 * Exported for unit testing.
 */
export function parseExtractionResponse(text: string): ExtractionResult {
  return parseExtractionResult(text).extraction;
}

/**
 * Same tolerant parse as `parseExtractionResponse` but reports whether the parse
 * yielded structured output (`ok: false` when no balanced/parseable JSON was
 * found OR the coerced shape failed Zod validation). Exported for the repair
 * pass + unit testing.
 */
export function parseExtractionResult(text: string): ParsedExtraction {
  const block = extractJsonBlock(text);
  if (!block) return { extraction: EMPTY_EXTRACTION, ok: false };

  let raw: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(block);
    if (typeof parsed !== 'object' || parsed === null) {
      return { extraction: EMPTY_EXTRACTION, ok: false };
    }
    raw = parsed as Record<string, unknown>;
  } catch {
    return { extraction: EMPTY_EXTRACTION, ok: false };
  }

  const issueType = nullify(raw.issueType);
  const urgency = nullify(raw.urgency);
  const email = nullify(raw.customerEmail);

  const validIssueType =
    issueType && (issueTypeValues as readonly string[]).includes(issueType)
      ? issueType
      : null;

  const isHvacRelated =
    typeof raw.isHvacRelated === 'boolean'
      ? raw.isHvacRelated
      : String(raw.isHvacRelated).toLowerCase() === 'true';

  const coerced = {
    // When the customer has clearly raised an HVAC problem but the model can't
    // map it to a specific category (e.g. "heat pump short cycling"), fall back
    // to the 'other' catch-all instead of null. A null issueType blocks the
    // intake stepper from ever showing "Issue ✓" and prevents the request from
    // ever being completable — even though we plainly understood it's an issue.
    issueType: validIssueType ?? (isHvacRelated ? 'other' : null),
    urgency:
      urgency && (urgencyValues as readonly string[]).includes(urgency)
        ? urgency
        : null,
    address: nullify(raw.address),
    customerName: nullify(raw.customerName),
    customerPhone: nullify(raw.customerPhone),
    customerEmail: email && /.+@.+\..+/.test(email) ? email : null,
    description: typeof raw.description === 'string' ? raw.description : '',
    isHvacRelated,
  };

  const result = extractionSchema.safeParse(coerced);
  return result.success
    ? { extraction: result.data, ok: true }
    : { extraction: EMPTY_EXTRACTION, ok: false };
}

export async function extractServiceRequest(
  conversationHistory: Message[],
  latestUserMessage: string,
  organizationId?: string,
): Promise<ExtractionPipelineResult> {
  // Step 1: Sanitize input per SC-06
  const guardrailResult = sanitizeInput(latestUserMessage);

  // Step 2: Build message history for extraction (sliding window to bound tokens)
  const MAX_HISTORY = 10;
  const messages = [
    ...conversationHistory.slice(-MAX_HISTORY).map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    })),
    { role: 'user' as const, content: guardrailResult.sanitized },
  ];

  // Step 3: Generate + tolerant-parse JSON, wrapped with metrics per SC-05.
  const { result: aiResult } = await trackAICall(
    'extraction',
    async () =>
      generateText({
        model: await getExtractionModel(organizationId),
        system: EXTRACTION_SYSTEM,
        messages,
        // Generous timeout so a hung upstream can't stall the lambda until the
        // platform kill (extraction is a short single-shot call).
        abortSignal: AbortSignal.timeout(30_000),
      }),
    (r) => (r.usage?.inputTokens ?? 0) + (r.usage?.outputTokens ?? 0),
  );

  const { text, usage } = aiResult;
  let { extraction, ok } = parseExtractionResult(text);
  let tokensUsed = (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);

  // Step 3b: ONE bounded repair pass. The Qwen/DashScope endpoint occasionally
  // returns prose with no parseable JSON, or a shape that fails Zod (e.g. an
  // array, or a stray field that breaks the object). Re-prompt ONCE with a terse
  // "return ONLY valid JSON" instruction, feeding back the model's own first
  // reply so it has the content to re-format. Best-effort: if the second attempt
  // also fails to parse, keep the empty/partial fallback we already have — never
  // throw. maxOutputTokens is capped tight (the object is small) so the repair
  // can't blow latency, and it reuses the same bounded timeout.
  if (!ok) {
    try {
      const { result: repairResult } = await trackAICall(
        'extraction',
        async () =>
          generateText({
            model: await getExtractionModel(organizationId),
            system: EXTRACTION_SYSTEM,
            messages: [
              ...messages,
              { role: 'assistant' as const, content: text },
              { role: 'user' as const, content: REPAIR_INSTRUCTION },
            ],
            maxOutputTokens: 300,
            abortSignal: AbortSignal.timeout(30_000),
          }),
        (r) => (r.usage?.inputTokens ?? 0) + (r.usage?.outputTokens ?? 0),
      );
      const repaired = parseExtractionResult(repairResult.text);
      tokensUsed +=
        (repairResult.usage?.inputTokens ?? 0) +
        (repairResult.usage?.outputTokens ?? 0);
      // Only adopt the repair when it actually parsed; a second failure leaves
      // the original empty/partial fallback in place.
      if (repaired.ok) {
        extraction = repaired.extraction;
        ok = true;
      }
    } catch {
      // Repair is best-effort: a timeout / network error must never break the
      // turn. Fall through with the original fallback extraction.
    }
  }

  // Step 4: Validate extraction output per SC-06
  const validOutput = validateExtractionOutput(extraction);

  return {
    extraction,
    tokensUsed,
    guardrailResult,
    validOutput,
  };
}
