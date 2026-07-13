import { describe, it, expect } from 'vitest';
import { filterCommands, type CommandItem } from './nav-search';

const ITEMS: CommandItem[] = [
  { label: 'Dashboard', href: '/admin/', group: 'Operations' },
  { label: 'Calendar', href: '/admin/calendar', group: 'Operations' },
  { label: 'Dispatch', href: '/admin/dispatch', group: 'Operations' },
  { label: 'Invoices', href: '/admin/invoices', group: 'Workspace' },
  { label: 'Inventory', href: '/admin/inventory', group: 'Workspace' },
  { label: 'AI Insights', href: '/admin/insights', group: 'Customers' },
  { label: 'Chatbot Settings', href: '/admin/settings', group: 'Workspace' },
  { label: 'Pricebook', href: '/admin/pricebook', group: 'Workspace' },
];

describe('filterCommands', () => {
  it('empty query returns all items in original order', () => {
    const result = filterCommands('', ITEMS);
    expect(result).toHaveLength(ITEMS.length);
    expect(result.map((i) => i.label)).toEqual(ITEMS.map((i) => i.label));
  });

  it('whitespace-only query returns all items', () => {
    const result = filterCommands('   ', ITEMS);
    expect(result).toHaveLength(ITEMS.length);
  });

  it('case-insensitive: "dashboard" matches "Dashboard"', () => {
    const result = filterCommands('dashboard', ITEMS);
    expect(result.map((i) => i.label)).toContain('Dashboard');
  });

  it('case-insensitive: "CALENDAR" matches "Calendar"', () => {
    const result = filterCommands('CALENDAR', ITEMS);
    expect(result.map((i) => i.label)).toContain('Calendar');
  });

  it('no match returns empty array', () => {
    const result = filterCommands('xyzzy', ITEMS);
    expect(result).toHaveLength(0);
  });

  it('prefix match ranks above mid-word substring', () => {
    // "inv" is a prefix of "Invoices" AND "Inventory", but not a prefix of "AI Insights"
    // "ai" is a prefix of "AI Insights" but "inv" is NOT in "AI Insights"
    // Test: "dis" is prefix of "Dispatch"; "Insights" contains "i" but not "dis"
    const result = filterCommands('dis', ITEMS);
    expect(result[0].label).toBe('Dispatch');
  });

  it('subsequence match: "inv" matches both "Invoices" and "Inventory" (as prefix)', () => {
    const result = filterCommands('inv', ITEMS);
    const labels = result.map((i) => i.label);
    expect(labels).toContain('Invoices');
    expect(labels).toContain('Inventory');
    // Both are prefix matches — neither "Dashboard" nor "Calendar" (non-prefix) should appear
    expect(labels).not.toContain('Dashboard');
    expect(labels).not.toContain('Calendar');
  });

  it('subsequence match: "cb" matches "Chatbot Settings" via subsequence', () => {
    const result = filterCommands('cb', ITEMS);
    const labels = result.map((i) => i.label);
    expect(labels).toContain('Chatbot Settings');
  });

  it('word-boundary match: "set" matches "Chatbot Settings" at word boundary', () => {
    const result = filterCommands('set', ITEMS);
    const labels = result.map((i) => i.label);
    expect(labels).toContain('Chatbot Settings');
  });

  it('word-boundary rank is higher (lower index) than pure subsequence', () => {
    // "in" is a word-boundary match for "AI Insights" (word "insights" starts with... no)
    // "ca" prefix match for "Calendar"; subsequence match for "Chatbot Settings"
    // "ca" appears as prefix in "Calendar" → rank 1
    // "ca" as subsequence in "Chatbot Settings" (c...a...) → rank 4
    const result = filterCommands('ca', ITEMS);
    const labels = result.map((i) => i.label);
    const calIdx = labels.indexOf('Calendar');
    const chatIdx = labels.indexOf('Chatbot Settings');
    if (chatIdx !== -1) {
      expect(calIdx).toBeLessThan(chatIdx);
    }
  });

  it('exact match comes first', () => {
    const items: CommandItem[] = [
      { label: 'Map Extended', href: '/admin/map-ext', group: 'X' },
      { label: 'Map', href: '/admin/map', group: 'Operations' },
      { label: 'Remap', href: '/admin/remap', group: 'X' },
    ];
    const result = filterCommands('map', items);
    expect(result[0].label).toBe('Map');
  });

  it('stable within rank tier: preserves original order', () => {
    // Both "Invoices" and "Inventory" are prefix matches for "in"
    const result = filterCommands('in', ITEMS);
    const invIdx = result.findIndex((i) => i.label === 'Invoices');
    const inventoryIdx = result.findIndex((i) => i.label === 'Inventory');
    // In ITEMS, Invoices (index 3) comes before Inventory (index 4)
    expect(invIdx).toBeLessThan(inventoryIdx);
  });

  it('carries group field through', () => {
    const result = filterCommands('cal', ITEMS);
    const cal = result.find((i) => i.label === 'Calendar');
    expect(cal?.group).toBe('Operations');
  });
});
