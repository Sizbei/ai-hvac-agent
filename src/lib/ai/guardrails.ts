// Common prompt injection patterns
const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /ignore\s+(all\s+)?above\s+instructions/i,
  /disregard\s+(all\s+)?previous/i,
  /forget\s+(all\s+)?previous/i,
  /you\s+are\s+now\s+a/i,
  /new\s+instructions?:/i,
  /system\s*:\s*/i,
  /\[INST\]/i,
  /\[\/INST\]/i,
  /<\|im_start\|>/i,
  /<\|im_end\|>/i,
  /```\s*system/i,
  /act\s+as\s+(if\s+you\s+are\s+)?a\s+different/i,
  /pretend\s+(you\s+are|to\s+be)/i,
  /override\s+(your\s+)?instructions/i,
  /reveal\s+(your\s+)?system\s+prompt/i,
  /what\s+(are|is)\s+your\s+(system\s+)?prompt/i,
  /repeat\s+(your\s+)?instructions/i,
];

export interface GuardrailResult {
  safe: boolean;
  sanitized: string;
  flagged: string[];
  /** True when the message exceeded the length cap and was silently truncated. */
  truncated: boolean;
}

export function sanitizeInput(input: string): GuardrailResult {
  const flagged: string[] = [];
  let sanitized = input.trim();

  // Check for injection patterns
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(sanitized)) {
      flagged.push(pattern.source);
    }
  }

  // Strip control characters (keep newlines and tabs for formatting)
  sanitized = sanitized.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  // Limit length to prevent context stuffing (max 2000 chars per message).
  // This is NOT a safety flag — a long message is truncated and still processed,
  // so it must not land in `flagged` (which blocks the request as injection).
  let truncated = false;
  if (sanitized.length > 2000) {
    sanitized = sanitized.slice(0, 2000);
    truncated = true;
  }

  return {
    safe: flagged.length === 0,
    sanitized,
    flagged,
    truncated,
  };
}

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
