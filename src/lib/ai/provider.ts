import { createOpenAI } from "@ai-sdk/openai";

const provider = createOpenAI({
  baseURL: process.env.AI_BASE_URL ?? "http://localhost:11434/v1",
  apiKey: process.env.AI_API_KEY ?? "ollama",
});

const MODEL_ID = process.env.AI_MODEL ?? "qwen3:8b";

export function getModel() {
  return provider(MODEL_ID);
}
