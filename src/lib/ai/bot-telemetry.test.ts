import { describe, it, expect, vi, beforeEach } from 'vitest';

const { insertMock } = vi.hoisted(() => ({ insertMock: vi.fn() }));

vi.mock('@/lib/db', () => ({
  db: {
    insert: () => ({
      values: (row: unknown) => insertMock(row),
    }),
  },
}));

vi.mock('@/lib/db/schema', () => ({ botEvents: {} }));

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), info: vi.fn() },
}));

// A tiny knowledge base so categoryForIntent has something to resolve against.
vi.mock('./knowledge-base', () => ({
  KNOWLEDGE_BASE: [
    { id: 'faq-hours', category: 'faq' },
    { id: 'cooling-no-cool', category: 'cooling' },
  ],
}));

import { recordBotEvent } from './bot-telemetry';
import { logger } from '@/lib/logger';

const ORG = '00000000-0000-0000-0000-000000000001';
const SESSION = '00000000-0000-0000-0000-0000000000aa';

beforeEach(() => {
  insertMock.mockReset();
  vi.mocked(logger.error).mockReset();
});

describe('recordBotEvent', () => {
  it('inserts a row with the resolved category for a known intent', async () => {
    insertMock.mockResolvedValueOnce(undefined);
    await recordBotEvent({
      organizationId: ORG,
      sessionId: SESSION,
      turn: 3,
      channel: 'web',
      routed: true,
      intentId: 'faq-hours',
      action: 'ANSWER',
      latencyMs: 42,
    });
    expect(insertMock).toHaveBeenCalledTimes(1);
    const row = insertMock.mock.calls[0][0] as Record<string, unknown>;
    expect(row.category).toBe('faq');
    expect(row.intentId).toBe('faq-hours');
    expect(row.routed).toBe(true);
    // Defaults applied for omitted flags.
    expect(row.extractionComplete).toBe(false);
    expect(row.escalated).toBe(false);
    expect(row.model).toBeNull();
  });

  it('nulls category and intent for an LLM-fallback turn', async () => {
    insertMock.mockResolvedValueOnce(undefined);
    await recordBotEvent({
      organizationId: ORG,
      sessionId: SESSION,
      turn: 1,
      channel: 'web',
      routed: false,
      model: 'qwen-2.5',
    });
    const row = insertMock.mock.calls[0][0] as Record<string, unknown>;
    expect(row.intentId).toBeNull();
    expect(row.category).toBeNull();
    expect(row.model).toBe('qwen-2.5');
    expect(row.routed).toBe(false);
  });

  it('NEVER throws when the db insert rejects (best-effort)', async () => {
    insertMock.mockRejectedValueOnce(new Error('db down'));
    await expect(
      recordBotEvent({
        organizationId: ORG,
        sessionId: SESSION,
        turn: 1,
        channel: 'web',
        routed: true,
        intentId: 'faq-hours',
      }),
    ).resolves.toBeUndefined();
    // The failure is logged, not propagated.
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('resolves an unknown intent id to a null category without throwing', async () => {
    insertMock.mockResolvedValueOnce(undefined);
    await recordBotEvent({
      organizationId: ORG,
      sessionId: SESSION,
      turn: 2,
      channel: 'phone',
      routed: true,
      intentId: 'no-such-intent',
    });
    const row = insertMock.mock.calls[0][0] as Record<string, unknown>;
    expect(row.category).toBeNull();
  });

  it('persists kind:"knowledge" in the action column for an LLM-fallback turn', async () => {
    insertMock.mockResolvedValueOnce(undefined);
    await recordBotEvent({
      organizationId: ORG,
      sessionId: SESSION,
      turn: 4,
      channel: 'web',
      routed: false,
      model: 'gpt-4o',
      kind: 'knowledge',
    });
    const row = insertMock.mock.calls[0][0] as Record<string, unknown>;
    expect(row.action).toBe('knowledge');
    expect(row.routed).toBe(false);
  });

  it('persists kind:"intake" in the action column for an LLM-fallback turn', async () => {
    insertMock.mockResolvedValueOnce(undefined);
    await recordBotEvent({
      organizationId: ORG,
      sessionId: SESSION,
      turn: 5,
      channel: 'phone',
      routed: false,
      model: 'gpt-4o',
      kind: 'intake',
    });
    const row = insertMock.mock.calls[0][0] as Record<string, unknown>;
    expect(row.action).toBe('intake');
  });

  it('does not overwrite a real action value when kind is set', async () => {
    insertMock.mockResolvedValueOnce(undefined);
    await recordBotEvent({
      organizationId: ORG,
      sessionId: SESSION,
      turn: 6,
      channel: 'web',
      routed: true,
      intentId: 'faq-hours',
      action: 'ANSWER',
      kind: 'knowledge',
    });
    const row = insertMock.mock.calls[0][0] as Record<string, unknown>;
    // action from input wins; kind is ignored when a real action is supplied
    expect(row.action).toBe('ANSWER');
  });

  it('leaves action null when kind is omitted on an LLM-fallback turn', async () => {
    insertMock.mockResolvedValueOnce(undefined);
    await recordBotEvent({
      organizationId: ORG,
      sessionId: SESSION,
      turn: 7,
      channel: 'web',
      routed: false,
    });
    const row = insertMock.mock.calls[0][0] as Record<string, unknown>;
    expect(row.action).toBeNull();
  });

  it('never throws when kind is provided and db fails (best-effort)', async () => {
    insertMock.mockRejectedValueOnce(new Error('db down'));
    await expect(
      recordBotEvent({
        organizationId: ORG,
        sessionId: SESSION,
        turn: 8,
        channel: 'web',
        routed: false,
        kind: 'knowledge',
      }),
    ).resolves.toBeUndefined();
  });
});
