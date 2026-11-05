/**
 * Template variable hints for the communication template editor: which
 * {{ variables }} a trigger provides, and which names in a draft body the
 * trigger won't fill (they would render as blank text in the message).
 */
import {
  templateVariableSchemas,
  type CommunicationTriggerType,
} from "@/lib/communication/sms-templates";

/** Handlebars built-ins and the helpers registered in sms-templates.ts. */
const NON_VARIABLE_TOKENS = new Set([
  "if", "else", "unless", "each", "with", "this",
  "eq", "ne", "gt", "lt", "gte", "lte", "and", "or", "not", "date",
]);

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*$/;

export function variablesForTrigger(triggerType: string): readonly string[] {
  const schema = templateVariableSchemas[triggerType as CommunicationTriggerType];
  return schema ? Object.keys(schema) : [];
}

/** Variable names referenced in a template body, in first-seen order. */
export function referencedVariables(body: string): string[] {
  const seen = new Set<string>();
  for (const match of body.matchAll(/\{\{\{?([^}]*)\}?\}\}/g)) {
    const inner = match[1].trim().replace(/^[#/^~]+|~$/g, "").trim();
    if (inner.startsWith("!")) continue; // comment
    for (const token of inner.split(/\s+/)) {
      if (!IDENTIFIER.test(token)) continue; // string literal, number, etc.
      const root = token.split(".")[0];
      if (!NON_VARIABLE_TOKENS.has(root)) seen.add(root);
    }
  }
  return [...seen];
}

/** Names used in `body` that `triggerType` doesn't provide. */
export function unknownVariables(body: string, triggerType: string): string[] {
  const known = new Set(variablesForTrigger(triggerType));
  return referencedVariables(body).filter((name) => !known.has(name));
}
