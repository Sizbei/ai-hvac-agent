// Prompt-injection / jailbreak signatures, split by SEVERITY (CHATBOT-PLAN Step 4):
//
//  - HARD-BLOCK patterns are unambiguous attempts to override the system prompt,
//    impersonate a system/assistant turn, or extract the prompt. A match must
//    NEVER be softened into a served LLM turn — the route returns the hard block.
//
//  - SOFT patterns are scope false-positives: tokens that frequently appear in
//    legitimate HVAC messages ("my system: won't turn on", "the AC acts as a
//    backup") but also resemble injection. Rather than dead-end the chat with a
//    400, the route answers conversationally and keeps going (still NOT feeding
//    the flagged text to the model as an instruction — it re-prompts in-scope).
const HARD_INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /ignore\s+(all\s+)?above\s+instructions/i,
  /disregard\s+(all\s+)?previous/i,
  /forget\s+(all\s+)?previous/i,
  /you\s+are\s+now\s+a/i,
  /new\s+instructions?:/i,
  /\[INST\]/i,
  /\[\/INST\]/i,
  /<\|im_start\|>/i,
  /<\|im_end\|>/i,
  /```\s*system/i,
  /pretend\s+(you\s+are|to\s+be)/i,
  /override\s+(your\s+)?instructions/i,
  /reveal\s+(your\s+)?system\s+prompt/i,
  /repeat\s+(your\s+)?instructions/i,
];

const SOFT_INJECTION_PATTERNS = [
  // "system:" appears in normal HVAC speech ("my system: not cooling"); a probe
  // for the prompt ("what is your system prompt") is caught by a HARD pattern.
  /system\s*:\s*/i,
  // "act as a different ..." can be a benign comparison ("can a heat pump act as
  // a different stage?") — the clear jailbreak "pretend you are" stays hard.
  /act\s+as\s+(if\s+you\s+are\s+)?a\s+different/i,
  // "what is your prompt" without "system" is often an innocent question.
  /what\s+(are|is)\s+your\s+(system\s+)?prompt/i,
];

// Combined list — used by validateExtractionOutput, which rejects ANY injection
// signature smuggled into an extracted field regardless of severity.
const INJECTION_PATTERNS = [
  ...HARD_INJECTION_PATTERNS,
  ...SOFT_INJECTION_PATTERNS,
];

/** Severity of a guardrail flag. `hard` = true injection/jailbreak → hard block.
 * `soft` = scope false-positive → answer conversationally and continue. */
export type GuardrailSeverity = "hard" | "soft";

export interface GuardrailResult {
  safe: boolean;
  sanitized: string;
  flagged: string[];
  /** Worst severity among the flags, or null when nothing flagged. Drives the
   * route's hard-block-vs-graceful-continue decision (Step 4). */
  severity: GuardrailSeverity | null;
  /** True when the message exceeded the length cap and was silently truncated. */
  truncated: boolean;
}

export function sanitizeInput(input: string): GuardrailResult {
  const flagged: string[] = [];
  let sanitized = input.trim();
  let hardFlagged = false;

  // Strip control characters (keep newlines and tabs for formatting) BEFORE the
  // injection scan. Otherwise a control char embedded mid-keyword ("ig\x00nore
  // previous instructions") slips past every regex, then gets cleaned into a
  // valid injection that reaches the LLM unflagged — the scan must see exactly
  // the text the model will.
  sanitized = sanitized.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  // Check for injection patterns, tracking whether any HARD pattern matched.
  for (const pattern of HARD_INJECTION_PATTERNS) {
    if (pattern.test(sanitized)) {
      flagged.push(pattern.source);
      hardFlagged = true;
    }
  }
  for (const pattern of SOFT_INJECTION_PATTERNS) {
    if (pattern.test(sanitized)) {
      flagged.push(pattern.source);
    }
  }

  // Limit length to prevent context stuffing (max 2000 chars per message).
  // This is NOT a safety flag — a long message is truncated and still processed,
  // so it must not land in `flagged` (which blocks the request as injection).
  let truncated = false;
  if (sanitized.length > 2000) {
    sanitized = sanitized.slice(0, 2000);
    truncated = true;
  }

  const severity: GuardrailSeverity | null =
    flagged.length === 0 ? null : hardFlagged ? "hard" : "soft";

  return {
    safe: flagged.length === 0,
    sanitized,
    flagged,
    severity,
    truncated,
  };
}

// Conversational reply for the SOFT (scope false-positive) class — keeps the
// chat alive and steers back to HVAC instead of the dead-end 400 error box.
export const GUARDRAIL_SOFT_REPLY =
  "I can only help with HVAC service requests — what's going on with your system?";

export function validateExtractionOutput(output: unknown): boolean {
  // Zod validation handles structure; this checks for injection in extracted values
  if (typeof output !== 'object' || output === null) return false;

  const record = output as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === 'string') {
      // Check if AI was tricked into embedding instructions in extracted fields
      if (value.length > 500 && key !== 'description') return false;
      // Check for suspiciously long description
      if (key === 'description' && value.length > 1000) return false;
      // Reject extracted values that smuggle injection content (e.g. an
      // attacker steering the model to embed "ignore previous instructions" in a
      // within-limit description that later flows back into a prompt).
      for (const pattern of INJECTION_PATTERNS) {
        if (pattern.test(value)) return false;
      }
    }
  }
  return true;
}
