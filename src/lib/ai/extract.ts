import { generateObject } from 'ai';
import { openai } from '@ai-sdk/openai';
import { extractionSchema, type ExtractionResult } from './extraction-schema';
import { SYSTEM_PROMPT, EXTRACTION_INSTRUCTION } from './system-prompt';
import { sanitizeInput, validateExtractionOutput, type GuardrailResult } from './guardrails';

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

export async function extractServiceRequest(
  conversationHistory: Message[],
  latestUserMessage: string,
): Promise<ExtractionPipelineResult> {
  // Step 1: Sanitize input per SC-06
  const guardrailResult = sanitizeInput(latestUserMessage);

  // Step 2: Build message history for extraction
  const messages = [
    ...conversationHistory.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    })),
    { role: 'user' as const, content: guardrailResult.sanitized },
  ];

  // Step 3: Single-pass structured extraction with Zod per SC-05
  const { object, usage } = await generateObject({
    model: openai('gpt-4o'),
    schema: extractionSchema,
    system: `${SYSTEM_PROMPT}\n\n${EXTRACTION_INSTRUCTION}`,
    messages,
  });

  // Step 4: Validate extraction output per SC-06
  const validOutput = validateExtractionOutput(object);

  return {
    extraction: object,
    tokensUsed: (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0),
    guardrailResult,
    validOutput,
  };
}
