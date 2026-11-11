import { describe, it, expect } from 'vitest';
import { signatureBlock, type DocumentSignature } from './invoice-signature-model';

const AT = new Date('2026-11-01T15:00:00Z');
const present: DocumentSignature = { state: 'present', url: 'https://r2/sig.png?sig=1', name: 'Pat Doe', signedAt: AT };
const erased: DocumentSignature = { state: 'erased', url: null, name: null, signedAt: AT };
const none: DocumentSignature = { state: 'none', url: null, name: null, signedAt: null };
const unavailable: DocumentSignature = { state: 'unavailable', url: null, name: 'Pat Doe', signedAt: AT };

describe('signatureBlock', () => {
  it.each(['open', 'paid', 'refunded', 'void'])('renders the invoice signature on a %s invoice', (state) => {
    expect(signatureBlock({ state, signature: present, requestSignature: null })).toEqual({
      kind: 'image',
      label: 'Customer signature',
      url: present.url,
      name: 'Pat Doe',
      signedAt: AT,
    });
  });

  it('ignores the request signature on a finalized invoice', () => {
    expect(signatureBlock({ state: 'open', signature: none, requestSignature: present })).toBeNull();
  });

  it('shows "Signature removed" when erased', () => {
    expect(signatureBlock({ state: 'paid', signature: erased, requestSignature: null })).toEqual({
      kind: 'note',
      label: 'Customer signature',
      note: 'Signature removed',
    });
  });

  it('shows a load note when the signed URL is unavailable', () => {
    expect(signatureBlock({ state: 'paid', signature: unavailable, requestSignature: null })).toEqual({
      kind: 'note',
      label: 'Customer signature',
      note: "Signature couldn't be loaded.",
    });
  });

  it('renders nothing when there is no signature', () => {
    expect(signatureBlock({ state: 'open', signature: none, requestSignature: null })).toBeNull();
  });

  it("uses the request's signature on a draft, labelled as not yet on the invoice", () => {
    expect(signatureBlock({ state: 'draft', signature: none, requestSignature: present })).toEqual({
      kind: 'image',
      label: 'Request signature (not yet on the invoice)',
      url: present.url,
      name: 'Pat Doe',
      signedAt: AT,
    });
    expect(signatureBlock({ state: 'draft', signature: present, requestSignature: null })).toBeNull();
    expect(signatureBlock({ state: 'draft', signature: none, requestSignature: erased })).toEqual({
      kind: 'note',
      label: 'Request signature (not yet on the invoice)',
      note: 'Signature removed',
    });
  });

  it('shows the "couldn\'t be loaded" note instead of the image once the retry cap is hit', () => {
    expect(signatureBlock({ state: 'open', signature: present, requestSignature: null }, true)).toEqual({
      kind: 'note',
      label: 'Customer signature',
      note: "Signature couldn't be loaded.",
    });
    expect(signatureBlock({ state: 'draft', signature: none, requestSignature: present }, true)).toEqual({
      kind: 'note',
      label: 'Request signature (not yet on the invoice)',
      note: "Signature couldn't be loaded.",
    });
  });

  it('leaves erased and missing signatures alone when the image flag is set', () => {
    expect(signatureBlock({ state: 'paid', signature: erased, requestSignature: null }, true)).toEqual({
      kind: 'note',
      label: 'Customer signature',
      note: 'Signature removed',
    });
    expect(signatureBlock({ state: 'open', signature: none, requestSignature: null }, true)).toBeNull();
  });
});
