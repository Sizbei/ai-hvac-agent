import { describe, it, expect } from 'vitest';
import { conversationFromSearch, urlWithConversation } from './inbox-history';

const ID = '7d111fea-1111-4111-8111-111111111111';

describe('urlWithConversation', () => {
  it('keeps the filters and sets c', () => {
    expect(urlWithConversation('/admin/conversations', '?channel=web&action=1', ID)).toBe(
      `/admin/conversations?channel=web&action=1&c=${ID}`,
    );
  });

  it('replaces an existing c', () => {
    expect(urlWithConversation('/admin/conversations', '?c=old', ID)).toBe(`/admin/conversations?c=${ID}`);
  });
});

describe('conversationFromSearch', () => {
  it('reads a uuid and ignores anything else', () => {
    expect(conversationFromSearch(`?status=escalated&c=${ID}`)).toBe(ID);
    expect(conversationFromSearch('?c=not-a-uuid')).toBeNull();
    expect(conversationFromSearch('')).toBeNull();
  });
});
