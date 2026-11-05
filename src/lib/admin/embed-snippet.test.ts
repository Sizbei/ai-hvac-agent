import { describe, expect, it } from 'vitest';
import { buildEmbedSnippet, KEY_PLACEHOLDER } from './embed-snippet';

describe('buildEmbedSnippet', () => {
  it('uses the full key and is copyable', () => {
    const s = buildEmbedSnippet('pk_live_85416299abcdef0123456789');
    expect(s.copyable).toBe(true);
    expect(s.text).toContain('data-hvac-key="pk_live_85416299abcdef0123456789"');
    expect(s.text).not.toContain('…');
  });

  it('never embeds a truncated display key', () => {
    const s = buildEmbedSnippet('pk_live_85416299…');
    expect(s.copyable).toBe(false);
    expect(s.text).toContain(KEY_PLACEHOLDER);
    expect(s.text).not.toContain('…');
  });

  it('shows the placeholder without a key', () => {
    expect(buildEmbedSnippet(null)).toEqual({
      text: expect.stringContaining(KEY_PLACEHOLDER),
      copyable: false,
    });
  });
});
