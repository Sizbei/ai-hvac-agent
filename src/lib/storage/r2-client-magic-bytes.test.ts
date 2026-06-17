import { describe, it, expect } from 'vitest';
import { verifyMagicBytes } from './r2-client';

/** Builds an ArrayBuffer with `bytes` written starting at `offset`. */
function bufferWith(offset: number, bytes: number[], total = 16): ArrayBuffer {
  const arr = new Uint8Array(total);
  bytes.forEach((b, i) => {
    arr[offset + i] = b;
  });
  return arr.buffer;
}

describe('verifyMagicBytes — existing image types', () => {
  it('accepts a valid JPEG', () => {
    expect(verifyMagicBytes(bufferWith(0, [0xff, 0xd8, 0xff]), 'image/jpeg')).toBe(
      true,
    );
  });

  it('accepts a valid PNG', () => {
    expect(
      verifyMagicBytes(
        bufferWith(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        'image/png',
      ),
    ).toBe(true);
  });

  it('rejects a JPEG-declared file with wrong bytes', () => {
    expect(verifyMagicBytes(bufferWith(0, [0x00, 0x01, 0x02]), 'image/jpeg')).toBe(
      false,
    );
  });
});

describe('verifyMagicBytes — PDF', () => {
  it('accepts a real %PDF header', () => {
    expect(
      verifyMagicBytes(bufferWith(0, [0x25, 0x50, 0x44, 0x46]), 'application/pdf'),
    ).toBe(true);
  });

  it('rejects a PDF-declared file that is not a PDF', () => {
    expect(
      verifyMagicBytes(bufferWith(0, [0xff, 0xd8, 0xff]), 'application/pdf'),
    ).toBe(false);
  });
});

describe('verifyMagicBytes — WebP', () => {
  it('accepts a valid RIFF/WEBP container', () => {
    const buf = bufferWith(0, [0x52, 0x49, 0x46, 0x46]); // 'RIFF' at 0
    const arr = new Uint8Array(buf);
    [0x57, 0x45, 0x42, 0x50].forEach((b, i) => {
      arr[8 + i] = b; // 'WEBP' at 8
    });
    expect(verifyMagicBytes(buf, 'image/webp')).toBe(true);
  });

  it('rejects a RIFF container that is not WebP (e.g. WAV/AVI)', () => {
    // 'RIFF' present but bytes 8-11 are not 'WEBP'.
    expect(
      verifyMagicBytes(bufferWith(0, [0x52, 0x49, 0x46, 0x46]), 'image/webp'),
    ).toBe(false);
  });
});

describe('verifyMagicBytes — HEIC', () => {
  it("accepts an ftyp box with the 'heic' brand", () => {
    const buf = bufferWith(4, [0x66, 0x74, 0x79, 0x70]); // 'ftyp' at 4
    const arr = new Uint8Array(buf);
    [0x68, 0x65, 0x69, 0x63].forEach((b, i) => {
      arr[8 + i] = b; // 'heic' at 8
    });
    expect(verifyMagicBytes(buf, 'image/heic')).toBe(true);
  });

  it("accepts the 'mif1' brand variant", () => {
    const buf = bufferWith(4, [0x66, 0x74, 0x79, 0x70]);
    const arr = new Uint8Array(buf);
    [0x6d, 0x69, 0x66, 0x31].forEach((b, i) => {
      arr[8 + i] = b; // 'mif1' at 8
    });
    expect(verifyMagicBytes(buf, 'image/heic')).toBe(true);
  });

  it("rejects an ftyp box with a non-HEIF brand (e.g. 'mp42')", () => {
    const buf = bufferWith(4, [0x66, 0x74, 0x79, 0x70]);
    const arr = new Uint8Array(buf);
    [0x6d, 0x70, 0x34, 0x32].forEach((b, i) => {
      arr[8 + i] = b; // 'mp42' at 8
    });
    expect(verifyMagicBytes(buf, 'image/heic')).toBe(false);
  });

  it('rejects a file with no ftyp box', () => {
    expect(
      verifyMagicBytes(bufferWith(0, [0x00, 0x00, 0x00, 0x18]), 'image/heic'),
    ).toBe(false);
  });
});

describe('verifyMagicBytes — unknown type', () => {
  it('rejects an unlisted MIME type', () => {
    expect(
      verifyMagicBytes(bufferWith(0, [0x00]), 'application/x-evil'),
    ).toBe(false);
  });
});
