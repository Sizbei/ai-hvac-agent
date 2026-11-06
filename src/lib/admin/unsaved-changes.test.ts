import { describe, it, expect } from 'vitest';
import { hasUnsavedChanges, shouldHoldLinkClick, type LinkClick } from './unsaved-changes';

describe('hasUnsavedChanges', () => {
  it('is false when every field matches', () => {
    expect(hasUnsavedChanges({ name: 'Ridgeline', on: true, n: 3 }, { name: 'Ridgeline', on: true, n: 3 })).toBe(false);
  });

  it('is true when a text, boolean or number field changed', () => {
    expect(hasUnsavedChanges({ name: 'Ridgeline' }, { name: 'Ridgeline DRAFT' })).toBe(true);
    expect(hasUnsavedChanges({ on: true }, { on: false })).toBe(true);
    expect(hasUnsavedChanges({ n: 3 }, { n: 4 })).toBe(true);
  });

  it('compares lists without caring about order (Sets passed as arrays)', () => {
    expect(hasUnsavedChanges({ off: ['a', 'b'] }, { off: ['b', 'a'] })).toBe(false);
    expect(hasUnsavedChanges({ off: ['a', 'b'] }, { off: ['a'] })).toBe(true);
    expect(hasUnsavedChanges({ off: ['a'] }, { off: 'a' })).toBe(true);
  });

  it('notices a key that only one side has', () => {
    expect(hasUnsavedChanges({}, { extra: 'x' })).toBe(true);
  });
});

const base: LinkClick = {
  dirty: true,
  href: 'http://localhost:3000/admin/staff',
  currentUrl: 'http://localhost:3000/admin/settings?tab=branding',
  button: 0,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  target: '',
  download: false,
};

describe('shouldHoldLinkClick', () => {
  it('holds a plain click to another admin page while dirty', () => {
    expect(shouldHoldLinkClick(base)).toBe(true);
  });

  it('lets everything through when nothing is unsaved', () => {
    expect(shouldHoldLinkClick({ ...base, dirty: false })).toBe(false);
  });

  it('lets new-tab, modified and non-left clicks through', () => {
    expect(shouldHoldLinkClick({ ...base, metaKey: true })).toBe(false);
    expect(shouldHoldLinkClick({ ...base, ctrlKey: true })).toBe(false);
    expect(shouldHoldLinkClick({ ...base, shiftKey: true })).toBe(false);
    expect(shouldHoldLinkClick({ ...base, button: 1 })).toBe(false);
    expect(shouldHoldLinkClick({ ...base, target: '_blank' })).toBe(false);
    expect(shouldHoldLinkClick({ ...base, download: true })).toBe(false);
  });

  it('lets external links and same-page links through', () => {
    expect(shouldHoldLinkClick({ ...base, href: 'https://example.com/help' })).toBe(false);
    expect(shouldHoldLinkClick({ ...base, href: 'http://localhost:3000/admin/settings?tab=services' })).toBe(false);
  });

  it('does not throw on an unparseable href', () => {
    expect(shouldHoldLinkClick({ ...base, href: 'not a url' })).toBe(false);
  });
});
