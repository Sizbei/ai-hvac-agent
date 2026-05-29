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

${JSON_INSTRUCTION}`;

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

/** Pull a JSON object out of a model response that may be fenced or chatty. */
function extractJsonBlock(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const source = fenced ? fenced[1] : text;
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  return source.slice(start, end + 1);
}

/**
 * Parse a model response into a validated ExtractionResult. Tolerant by design:
 * coerces nullish strings to null, drops out-of-enum / invalid values rather
 * than throwing, and returns an all-null extraction if nothing usable is found.
 * Exported for unit testing.
 */
export function parseExtractionResponse(text: string): ExtractionResult {
  const block = extractJsonBlock(text);
  if (!block) return EMPTY_EXTRACTION;

  let raw: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(block);
    if (typeof parsed !== 'object' || parsed === null) return EMPTY_EXTRACTION;
    raw = parsed as Record<string, unknown>;
  } catch {
    return EMPTY_EXTRACTION;
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
  return result.success ? result.data : EMPTY_EXTRACTION;
}

export async function extractServiceRequest(
  conversationHistory: Message[],
  latestUserMessage: string,
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
    () =>
      generateText({
        model: getExtractionModel(),
        system: EXTRACTION_SYSTEM,
        messages,
      }),
    (r) => (r.usage?.inputTokens ?? 0) + (r.usage?.outputTokens ?? 0),
  );

  const { text, usage } = aiResult;
  const extraction = parseExtractionResponse(text);

  // Step 4: Validate extraction output per SC-06
  const validOutput = validateExtractionOutput(extraction);

  return {
    extraction,
    tokensUsed: (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0),
    guardrailResult,
    validOutput,
  };
}
