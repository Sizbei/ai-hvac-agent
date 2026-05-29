import { createOpenAI } from "@ai-sdk/openai";

const provider = createOpenAI({
  baseURL: process.env.AI_BASE_URL ?? "http://localhost:11434/v1",
  apiKey: process.env.AI_API_KEY ?? "ollama",
});

const MODEL_ID = process.env.AI_MODEL ?? "qwen3:8b";

// Extraction is a mechanical JSON classification task — it can run on a cheaper/
// faster model than the conversational chat. Defaults to the chat model so there
// is no behavior change unless AI_EXTRACTION_MODEL is set (Token-Savings #5).
const EXTRACTION_MODEL_ID = process.env.AI_EXTRACTION_MODEL ?? MODEL_ID;

/** Model for the conversational chat reply. */
export function getModel() {
  return provider(MODEL_ID);
}

/** Model for structured extraction — set AI_EXTRACTION_MODEL to a cheaper tier. */
export function getExtractionModel() {
  return provider(EXTRACTION_MODEL_ID);
}
