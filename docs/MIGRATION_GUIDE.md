# Migration Guide - Vercel Chatbot Features

This guide documents the features integrated from Vercel's chatbot and how they were adapted for the AI HVAC Agent.

## Overview

The AI HVAC Agent has incorporated several features inspired by [Vercel's chatbot](https://github.com/vercel/chatbot):

| Feature | Vercel Chatbot | AI HVAC Agent | Status |
|---------|---------------|---------------|--------|
| Streaming Responses | ✅ Yes | ✅ Yes | ✅ Implemented |
| History Sidebar | ✅ Yes | ✅ Yes | ✅ Implemented |
| Multi-Model Provider | ✅ Yes | ✅ Yes | ✅ Implemented |
| File Upload | ✅ Yes | ✅ Yes | ✅ Implemented |
| Rate Limiting | ✅ Yes | ✅ Yes | ✅ Implemented |
| Session Persistence | ✅ Yes | ✅ Yes | ✅ Implemented |

## Feature Details

### 1. Streaming Responses

**Vercel Implementation:**
- Uses `@ai-sdk/react` with `useChat` hook
- Streams via `streamText()` from AI SDK
- Text-based streaming transport

**AI HVAC Agent Implementation:**
- Custom `TextStreamChatTransport` for session handling
- Streaming via `streamText()` with max token budget
- Serverless-safe background work using `after()`

**Key Differences:**
- HVAC Agent includes deterministic router (0-token path for common intents)
- HVAC Agent has token budget management per organization
- HVAC Agent includes compaction for long conversations

**Migration Notes:**
```typescript
// Vercel pattern:
const result = streamText({ model, messages });
return result.toTextStreamResponse();

// HVAC Agent pattern (same base, with extras):
const result = streamText({
  model: getModel(),
  system: brandPrompt + systemPrompt,
  maxOutputTokens: 350,
  messages: buildModelMessages(history),
  onFinish: async ({ text, usage }) => {
    // Persist message and update token budget
    await persistMessage(session.id, text, role);
    await updateTokenBudget(organizationId, usage.totalTokens);
  },
});

// Background extraction runs after response sent
after(async () => {
  const extraction = await extractServiceRequest(history, sanitized);
  await mergeAndPersist(session.id, extraction);
});

return result.toTextStreamResponse();
```

### 2. History Sidebar

**Vercel Implementation:**
- Collapsible sidebar with Sheet component
- Shows past conversations with relative timestamps
- Persists to localStorage

**AI HVAC Agent Implementation:**
- Server-side session history via `/api/chat/history`
- Customer-specific session list
- Message count and preview
- Mobile-responsive with safe-area iOS support

**Migration Notes:**
```typescript
// Vercel: Client-side history
const { history } = useChat();
localStorage.setItem('history', JSON.stringify(history));

// HVAC Agent: Server-side history
const res = await fetch('/api/chat/history');
const sessions = await res.json();

// Benefits:
// - History survives across devices
// - No localStorage limits
// - Better security (server-controlled)
```

### 3. Multi-Model Provider

**Vercel Implementation:**
- OpenAI and Anthropic models
- Fallback chains via environment variables
- Model-specific configuration

**AI HVAC Agent Implementation:**
- OpenAI GPT and O1 models
- Ollama (local) support
- Tiers: economy/standard/premium
- Fallback chains with health checks

**Migration Notes:**
```bash
# Vercel env vars:
MODEL=anthropic/claude-3-5-sonnet
FALLBACK_MODELS=openai/gpt-4o

# HVAC Agent env vars:
AI_MODEL=gpt-4o-mini
AI_FALLBACK_MODELS=gpt-4o-mini,gpt-4-turbo,llama3
AI_EXTRACTION_MODEL=gpt-4o-mini
AI_REASONING_MODEL=o1-preview
```

### 4. File Upload

**Vercel Implementation:**
- Vercel Blob storage
- Basic file type validation
- Client-side upload preview

**AI HVAC Agent Implementation:**
- Cloudflare R2/S3 storage
- Magic byte validation
- Multi-tenant scoped storage keys
- 5MB limit with proper error handling

**Migration Notes:**
```typescript
// Vercel Blob:
const blob = await put(filename, file, { access: 'public' });

// HVAC Agent R2/S3:
const storageKey = generateStorageKey(orgId, sessionId, file.name);
const result = await storageClient.uploadFile(file, storageKey, mimeType);
```

### 5. Rate Limiting

**Vercel Implementation:**
- Upstash Redis-backed rate limiting
- Token bucket algorithm
- Per-IP and per-user limits

**AI HVAC Agent Implementation:**
- In-memory sliding window (serverless-safe)
- Memory ceiling protection
- Per-endpoint configurations
- Graceful degradation

**Migration Notes:**
```typescript
// Vercel (Redis):
const ratelimit = new Ratelimit({
  redis: Redis.fromEnv(),
  limiter: Ratelimit.slidingWindow(10, '10s'),
});

// HVAC Agent (in-memory):
const result = slidingWindow(key, maxRequests, windowMs);
```

### 6. Session Persistence

**Vercel Implementation:**
- Cookie-based session storage
- Client-side transcript management
- Server-side save on message send

**AI HVAC Agent Implementation:**
- httpOnly cookie for session ID
- Server-side transcript persistence
- Session resumption after page reload
- Compaction for long conversations

**Migration Notes:**
```typescript
// Vercel: Transcript in URL params
const { transcript, setTranscript } = useChat();

// HVAC Agent: Transcript from session
const res = await fetch('/api/session');
const { messages } = await res.json();
setMessages(messages.map(fromDbMessage));
```

## Architecture Differences

### Vercel Chatbot
```
Client (React) → API Routes → OpenAI/Anthropic → Redis/Postgres
                                      ↓
                                Vercel Blob
```

### AI HVAC Agent
```
Client (React) → API Routes → Deterministic Router → OpenAI/Ollama
                      ↓              ↓
                Neon Serverless   Token Budget
                      ↓              ↓
                Cloudflare R2   Compaction
```

## Key HVAC-Specific Additions

Not in Vercel chatbot, specific to HVAC use case:

1. **Deterministic Router**: 0-token responses for common intents
2. **Service Request Extraction**: Structured HVAC data extraction
3. **Multi-Tenant**: Organization-based isolation
4. **Token Budget Management**: Per-org spending limits
5. **HVAC Triage Flow**: Name, phone, address capture
6. **Emergency Escalation**: Gas leak, CO detection

## Migration Checklist

If migrating from Vercel chatbot to AI HVAC Agent:

- [ ] Update environment variables for multi-model provider
- [ ] Configure R2/S3 storage (or use Vercel Blob)
- [ ] Set up Neon Serverless Postgres
- [ ] Configure rate limiting (in-memory or Redis)
- [ ] Add deterministic router configuration
- [ ] Implement service request extraction
- [ ] Add HVAC-specific prompts and escalation rules
- [ ] Configure token budget per organization
- [ ] Set up multi-tenant organization structure

## Testing

```bash
# Run E2E tests
npm run test:e2e

# Run with UI
npm run test:e2e:ui

# Debug mode
npm run test:e2e:debug
```

## References

- Vercel Chatbot: https://github.com/vercel/chatbot
- AI SDK: https://sdk.vercel.ai/
- Drizzle ORM: https://orm.drizzle.team/
- Neon Serverless: https://neon.tech/
- Cloudflare R2: https://developers.cloudflare.com/r2/
