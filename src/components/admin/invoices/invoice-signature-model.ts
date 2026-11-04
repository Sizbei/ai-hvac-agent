/**
 * Pure: which signature the invoice document shows. A finalized invoice
 * (open/paid/refunded/void) shows its OWN snapshot taken at finalize; a draft
 * shows the request's current signature, labelled as not yet on the invoice.
 */
export type SignatureState = 'none' | 'present' | 'erased' | 'unavailable';

export interface DocumentSignature {
  readonly state: SignatureState;
  readonly url: string | null;
  readonly name: string | null;
  readonly signedAt: Date | null;
}

export type SignatureBlock =
  | {
      readonly kind: 'image';
      readonly label: string;
      readonly url: string;
      readonly name: string | null;
      readonly signedAt: Date | null;
    }
  | { readonly kind: 'note'; readonly label: string; readonly note: string };

const FINALIZED = new Set(['open', 'paid', 'refunded', 'void']);

export function signatureBlock(input: {
  state: string;
  signature: DocumentSignature;
  requestSignature: DocumentSignature | null;
}): SignatureBlock | null {
  let sig: DocumentSignature | null = null;
  let label = 'Customer signature';
  if (input.state === 'draft') {
    sig = input.requestSignature;
    label = 'Job signature (not yet on the invoice)';
  } else if (FINALIZED.has(input.state)) {
    sig = input.signature;
  }
  if (!sig) return null;
  switch (sig.state) {
    case 'present':
      return sig.url
        ? { kind: 'image', label, url: sig.url, name: sig.name, signedAt: sig.signedAt }
        : null;
    case 'erased':
      return { kind: 'note', label, note: 'Signature removed' };
    case 'unavailable':
      return { kind: 'note', label, note: "Signature couldn't be loaded." };
    default:
      return null;
  }
}
