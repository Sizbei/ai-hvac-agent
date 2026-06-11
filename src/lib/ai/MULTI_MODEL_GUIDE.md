# Multi-Model Provider - Stage 6 Documentation

## Overview

The multi-model provider infrastructure supports routing requests across multiple LLM providers (OpenAI, Ollama) with automatic fallback chains. This provides:

1. **Provider Redundancy**: Failover if primary model is unavailable
2. **Cost Optimization**: Route different tasks to appropriate model tiers
3. **Flexibility**: Easy addition of new providers/models

## Supported Providers

### OpenAI
- `gpt-4o` (Standard tier, 4096 max tokens)
- `gpt-4o-mini` (Economy tier, 16384 max tokens)
- `gpt-4-turbo` (Standard tier, 4096 max tokens)
- `o1-preview` (Premium tier, reasoning, 32768 max tokens)
- `o1-mini` (Standard tier, reasoning, 65536 max tokens)

### Ollama (Local)
- `llama3` (Economy tier, local hosting)
- `qwen3:8b` (Economy tier, local hosting)

## Model Tiers

- **Premium**: Best quality, highest cost (o1-preview, GPT-4 class)
- **Standard**: Balanced quality/cost (GPT-4o, GPT-4 Turbo)
- **Economy**: Cost-effective for simple tasks (GPT-4o-mini, local models)

## Usage

### Get Chat Model with Fallbacks

```typescript
import { getChatModel } from '@/lib/ai/multi-model-provider';

const { model, config, client } = getChatModel();
// Uses AI_MODEL env var, then AI_FALLBACK_MODELS
```

### Get Extraction Model (Cheaper)

```typescript
import { getExtractionModel } from '@/lib/ai/multi-model-provider';

const { model } = getExtractionModel();
// Prefers economy tier for JSON classification tasks
```

### Get Reasoning Model

```typescript
import { getReasoningModel } from '@/lib/ai/multi-model-provider';

const { model } = getReasoningModel();
// Uses premium tier for complex reasoning
```

## Environment Configuration

```bash
# Primary model for chat
AI_MODEL=gpt-4o-mini

# Fallback chain (comma-separated)
AI_FALLBACK_MODELS=gpt-4o-mini,gpt-4-turbo,llama3

# Extraction model (cheaper preferred)
AI_EXTRACTION_MODEL=gpt-4o-mini
AI_EXTRACTION_FALLBACKS=gpt-4o-mini,llama3

# Reasoning model for complex tasks
AI_REASONING_MODEL=o1-preview
AI_REASONING_FALLBACKS=o1-preview,gpt-4o

# Provider-specific config
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_API_KEY=sk-...

AI_BASE_URL=http://localhost:11434/v1  # Ollama
AI_API_KEY=ollama
```

## Adding a New Model

1. Add to `MODEL_PRESETS` in `multi-model-provider.ts`:

```typescript
'your-model': {
  provider: 'openai',
  modelId: 'your-model-id',
  tier: 'standard',
  maxTokens: 4096,
  supportsStreaming: true,
  supportsTools: true,
  supportsJson: true,
},
```

2. Set environment variable:

```bash
AI_MODEL=your-model
AI_FALLBACK_MODELS=your-model,gpt-4o-mini
```

## Model Selection Criteria

The `getModelForCriteria` function accepts:

- `task`: 'chat' | 'extraction' | 'reasoning'
- `requireStreaming`: Require streaming support
- `requireTools`: Require function calling support
- `requireJson`: Require JSON mode support
- `maxOutputTokens`: Maximum output tokens
- `preferredTier`: Economy/Standard/Premium preference
- `fallbackChain`: Ordered list of model IDs to try

## Integration with Existing Code

The existing `src/lib/ai/provider.ts` can be updated to use the multi-model infrastructure:

```typescript
// Before (current):
export function getModel() {
  return provider(MODEL_ID);
}

// After (with multi-model):
import { getChatModel } from './multi-model-provider';

export function getModel() {
  const { model } = getChatModel();
  return model;
}

export function getExtractionModel() {
  const { model } = getExtractionModel();
  return model;
}
```

## Benefits

1. **Resilience**: Automatic fallback on provider outages
2. **Cost Control**: Route extraction to cheaper models
3. **Flexibility**: Easy model swapping via environment variables
4. **Observability**: Clear model selection criteria and fallback paths
