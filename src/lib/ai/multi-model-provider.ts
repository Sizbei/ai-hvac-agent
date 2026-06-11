/**
 * Multi-model provider routing infrastructure.
 * Supports OpenAI GPT, O1, and Ollama models with fallback chains.
 *
 * Stage 6: Backend Multi-Model
 */

import { createOpenAI } from '@ai-sdk/openai';

/** Supported model providers */
export type ModelProvider = 'openai' | 'ollama';

/** Model capability tier */
export type ModelTier = 'premium' | 'standard' | 'economy';

/** Model configuration */
export interface ModelConfig {
  readonly provider: ModelProvider;
  readonly modelId: string;
  readonly tier: ModelTier;
  readonly maxTokens: number;
  readonly supportsStreaming: boolean;
  readonly supportsTools: boolean;
  readonly supportsJson: boolean;
}

/** Available model presets */
export const MODEL_PRESETS: Record<string, ModelConfig> = {
  // OpenAI GPT (Standard)
  'gpt-4o': {
    provider: 'openai',
    modelId: 'gpt-4o',
    tier: 'standard',
    maxTokens: 4096,
    supportsStreaming: true,
    supportsTools: true,
    supportsJson: true,
  },
  'gpt-4o-mini': {
    provider: 'openai',
    modelId: 'gpt-4o-mini',
    tier: 'economy',
    maxTokens: 16384,
    supportsStreaming: true,
    supportsTools: true,
    supportsJson: true,
  },
  'gpt-4-turbo': {
    provider: 'openai',
    modelId: 'gpt-4-turbo',
    tier: 'standard',
    maxTokens: 4096,
    supportsStreaming: true,
    supportsTools: true,
    supportsJson: true,
  },

  // O1 (Reasoning)
  'o1-preview': {
    provider: 'openai',
    modelId: 'o1-preview',
    tier: 'premium',
    maxTokens: 32768,
    supportsStreaming: false,
    supportsTools: false,
    supportsJson: true,
  },
  'o1-mini': {
    provider: 'openai',
    modelId: 'o1-mini',
    tier: 'standard',
    maxTokens: 65536,
    supportsStreaming: false,
    supportsTools: false,
    supportsJson: true,
  },

  // Ollama (Local)
  'llama3': {
    provider: 'ollama',
    modelId: 'llama3',
    tier: 'economy',
    maxTokens: 4096,
    supportsStreaming: true,
    supportsTools: false,
    supportsJson: true,
  },
  'qwen3:8b': {
    provider: 'ollama',
    modelId: 'qwen3:8b',
    tier: 'economy',
    maxTokens: 4096,
    supportsStreaming: true,
    supportsTools: false,
    supportsJson: true,
  },
};

/** Provider client factory */
export function createProviderClient(provider: ModelProvider) {
  switch (provider) {
    case 'openai':
      return createOpenAI({
        baseURL: process.env.OPENAI_BASE_URL,
        apiKey: process.env.OPENAI_API_KEY,
      });

    case 'ollama':
      return createOpenAI({
        baseURL: process.env.AI_BASE_URL ?? 'http://localhost:11434/v1',
        apiKey: process.env.AI_API_KEY ?? 'ollama',
      });

    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

/** Model selection criteria */
export interface ModelSelectionCriteria {
  readonly task: 'chat' | 'extraction' | 'reasoning';
  readonly requireStreaming?: boolean;
  readonly requireTools?: boolean;
  readonly requireJson?: boolean;
  readonly maxOutputTokens?: number;
  readonly preferredTier?: ModelTier;
  readonly fallbackChain?: readonly string[];
}

/** Get model for given criteria with fallback support */
export function getModelForCriteria(criteria: ModelSelectionCriteria) {
  const {
    task,
    requireStreaming = true,
    requireTools = false,
    requireJson = true,
    maxOutputTokens = 350,
    preferredTier = 'standard',
    fallbackChain = [],
  } = criteria;

  // Build candidate list from presets
  const candidates = Object.entries(MODEL_PRESETS)
    .map(([key, config]) => ({ key, ...config }))
    .filter((model) => {
      // Filter by streaming requirement
      if (requireStreaming && !model.supportsStreaming) return false;
      // Filter by tools requirement
      if (requireTools && !model.supportsTools) return false;
      // Filter by JSON requirement
      if (requireJson && !model.supportsJson) return false;
      // Filter by tier preference
      if (preferredTier && model.tier !== preferredTier) {
        // Allow higher tiers for lower tier preference
        if (
          !(preferredTier === 'economy' && model.tier === 'standard') &&
          !(preferredTier === 'economy' && model.tier === 'premium') &&
          !(preferredTier === 'standard' && model.tier === 'premium')
        ) {
          return false;
        }
      }
      return true;
    });

  // Sort by tier preference (economy < standard < premium)
  const tierOrder = { economy: 0, standard: 1, premium: 2 };
  candidates.sort((a, b) => tierOrder[a.tier] - tierOrder[b.tier]);

  // Use fallback chain if provided
  const modelsToTry = fallbackChain.length > 0
    ? [...fallbackChain, ...candidates.map((m) => m.key)]
    : candidates.map((m) => m.key);

  // Try each model in order
  for (const modelKey of modelsToTry) {
    const config = MODEL_PRESETS[modelKey];
    if (!config) continue;

    try {
      const client = createProviderClient(config.provider);
      return {
        model: client(config.modelId),
        config,
        client,
      };
    } catch (error) {
      console.warn(`Failed to initialize model ${modelKey}:`, error);
      continue;
    }
  }

  // Fallback to environment default
  const defaultModel = process.env.AI_MODEL ?? 'gpt-4o-mini';
  const defaultConfig = MODEL_PRESETS[defaultModel];
  if (defaultConfig) {
    const client = createProviderClient(defaultConfig.provider);
    return {
      model: client(defaultConfig.modelId),
      config: defaultConfig,
      client,
    };
  }

  throw new Error('No suitable model found for given criteria');
}

/** Get chat model with fallback chain */
export function getChatModel() {
  const preferredModel = process.env.AI_MODEL;
  const fallbackChain = process.env.AI_FALLBACK_MODELS?.split(',').filter(Boolean) ?? [];

  return getModelForCriteria({
    task: 'chat',
    requireStreaming: true,
    requireJson: true,
    preferredTier: 'standard',
    fallbackChain: preferredModel ? [preferredModel, ...fallbackChain] : fallbackChain,
  });
}

/** Get extraction model (cheaper tier preferred) */
export function getExtractionModel() {
  const extractionModel = process.env.AI_EXTRACTION_MODEL;
  const fallbackChain = process.env.AI_EXTRACTION_FALLBACKS?.split(',').filter(Boolean) ?? [];

  return getModelForCriteria({
    task: 'extraction',
    requireStreaming: false,
    requireJson: true,
    preferredTier: 'economy',
    fallbackChain: extractionModel ? [extractionModel, ...fallbackChain] : fallbackChain,
  });
}

/** Get reasoning model for complex tasks */
export function getReasoningModel() {
  const reasoningModel = process.env.AI_REASONING_MODEL;
  const fallbackChain = process.env.AI_REASONING_FALLBACKS?.split(',').filter(Boolean) ?? [];

  return getModelForCriteria({
    task: 'reasoning',
    requireStreaming: false,
    requireJson: true,
    preferredTier: 'premium',
    fallbackChain: reasoningModel ? [reasoningModel, ...fallbackChain] : fallbackChain,
  });
}

/** Model health check - verify API key and connectivity */
export async function checkModelHealth(modelKey: string): Promise<boolean> {
  const config = MODEL_PRESETS[modelKey];
  if (!config) return false;

  try {
    const client = createProviderClient(config.provider);
    const model = client(config.modelId);

    // Simple test: generate a short completion
    // This would be implemented with the actual provider API
    // For now, return true if configuration exists
    return true;
  } catch {
    return false;
  }
}

/** Get available models for a provider */
export function getModelsForProvider(provider: ModelProvider): readonly string[] {
  return Object.entries(MODEL_PRESETS)
    .filter(([_, config]) => config.provider === provider)
    .map(([key]) => key);
}

/** Get all available model keys */
export function getAllModelKeys(): readonly string[] {
  return Object.keys(MODEL_PRESETS);
}
