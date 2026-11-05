import { describe, expect, it } from 'vitest';
import { resolveSettingsTab, settingsTabSearch } from './settings-tabs';

describe('resolveSettingsTab', () => {
  it('accepts known tabs and defaults the rest to branding', () => {
    expect(resolveSettingsTab('after-hours')).toBe('after-hours');
    expect(resolveSettingsTab(null)).toBe('branding');
    expect(resolveSettingsTab('nope')).toBe('branding');
  });
});

describe('settingsTabSearch', () => {
  it('sets the tab and keeps other params', () => {
    expect(settingsTabSearch('?tab=business&from=setup', 'embed')).toBe('?tab=embed&from=setup');
    expect(settingsTabSearch('', 'tags')).toBe('?tab=tags');
  });
});
