/**
 * Shared model-call helper for the OPTIONAL, key-gated eval tools (compare-prompts,
 * behavior-probe). Mirrors judge.ts's provider construction. Degrade-safe: never
 * throws — returns `{ text: null }` with a note on error/empty output. Nothing
 * here runs in the offline CI gate (the gate imports only pure modules).
 */
import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import type { ModelRegistryEntry } from "../model-registry";

export interface GenerateResult {
  readonly text: string | null;
  readonly tokens: number;
  readonly note: string;
}

/**
 * Generate one single-turn reply for a system prompt. Used to produce the bot's
 * answer that the judge then scores. Degrade-safe (see module note).
 */
export async function generateReply(
  entry: ModelRegistryEntry,
  systemPrompt: string,
  userPrompt: string,
): Promise<GenerateResult> {
  try {
    const provider = createOpenAI({
      baseURL: entry.baseUrl,
      apiKey: process.env[entry.apiKeyEnv] ?? "",
    });
    const { text, usage } = await generateText({
      model: provider.chat(entry.modelId),
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
      abortSignal: AbortSignal.timeout(30_000),
    });
    const out = typeof text === "string" ? text.trim() : "";
    const tokens = (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
    return out.length
      ? { text: out, tokens, note: "ok" }
      : { text: null, tokens, note: "failed: empty generation" };
  } catch (err) {
    return {
      text: null,
      tokens: 0,
      note: `error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
