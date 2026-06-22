/**
 * promptfoo custom provider that exercises the REAL chat output path:
 *   buildSystemPrompt()  →  DashScope (generateReply)  →  screenAssistantReply()
 *
 * The output guardrail (screenAssistantReply) is the SHIPPED deterministic
 * backstop that substitutes a safe reply when the model leaks pricing / claims a
 * false booking / gives dangerous-DIY / leaks credentials. Testing the screened
 * output — not the raw model text — is what makes these asserts reflect what a
 * customer would actually receive. The model + base URL + key come from the same
 * env the app uses (AI_API_KEY / AI_BASE_URL / AI_MODEL via the model registry).
 */
import { buildSystemPrompt } from "../src/lib/ai/system-prompt";
import { screenAssistantReply } from "../src/lib/ai/output-guardrail";
import { generateReply } from "../src/lib/ai/eval/eval-llm";
import { getRegistryEntry, DEFAULT_MODEL_ID } from "../src/lib/ai/model-registry";

const SYSTEM = buildSystemPrompt();

interface ProviderResponse {
  output?: string;
  error?: string;
  tokenUsage?: { total: number };
  metadata?: Record<string, unknown>;
}

export default class HvacChatProvider {
  private readonly providerId: string;

  constructor(options?: { id?: string }) {
    this.providerId = options?.id ?? "hvac-chat-dashscope";
  }

  id(): string {
    return this.providerId;
  }

  async callApi(prompt: string): Promise<ProviderResponse> {
    const entry = getRegistryEntry(DEFAULT_MODEL_ID);
    if (!entry) {
      return { error: `model registry entry '${DEFAULT_MODEL_ID}' not found` };
    }
    const res = await generateReply(entry, SYSTEM, prompt);
    if (res.text == null) {
      return { error: `generation failed: ${res.note}` };
    }
    // Apply the shipped output-guardrail backstop — the customer-visible reply.
    const screened = screenAssistantReply(res.text);
    return {
      output: screened.reply,
      tokenUsage: { total: res.tokens },
      metadata: { screened: !screened.safe, violations: screened.violations },
    };
  }
}
