import { describe, it, expect } from 'vitest';
import { sanitizeScreenshotImage } from './screenshot-image.js';

// 1x1 transparent PNG
const VALID_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

// minimal JPEG (SOI + APP0 + EOI) — valid magic bytes, no SOF (no dimensions)
const VALID_JPEG_B64 = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
  0xff, 0xd9,
]).toString('base64');

// --- Header builders with known dimensions (zero-dep, mirror the parser) ---

function pngOf(width: number, height: number): string {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  // IHDR chunk: length(4) "IHDR"(4) width(4) height(4) + 5 bytes + crc(4)
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0); // chunk length
  ihdr.write('IHDR', 4, 'ascii');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  // bit depth, color type, etc. + crc left as zeros (parser ignores)
  return Buffer.concat([sig, ihdr]).toString('base64');
}

function jpegOf(width: number, height: number): string {
  // SOI, APP0 (correct 16-byte JFIF), SOF0 (with dimensions), EOI
  const app0 = Buffer.from([
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00,
    0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  ]);
  const sof0 = Buffer.alloc(11);
  sof0[0] = 0xff;
  sof0[1] = 0xc0; // SOF0
  sof0.writeUInt16BE(11 - 2, 2); // segment length (excludes marker)
  sof0[4] = 0x08; // precision
  sof0.writeUInt16BE(height, 5); // height first in JPEG SOF
  sof0.writeUInt16BE(width, 7);
  sof0[9] = 0x01; // components
  sof0[10] = 0x01;
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    app0,
    sof0,
    Buffer.from([0xff, 0xd9]),
  ]).toString('base64');
}

function gifOf(width: number, height: number): string {
  const b = Buffer.alloc(13);
  b.write('GIF89a', 0, 'ascii');
  b.writeUInt16LE(width, 6); // little-endian in GIF
  b.writeUInt16LE(height, 8);
  return b.toString('base64');
}

function webpVp8xOf(width: number, height: number): string {
  // RIFF container with a VP8X chunk carrying canvas dimensions (minus one).
  const vp8x = Buffer.alloc(18);
  vp8x.write('VP8X', 0, 'ascii');
  vp8x.writeUInt32LE(10, 4); // chunk size
  // flags(1) + reserved(3) at offset 8..11
  vp8x.writeUIntLE(width - 1, 12, 3); // 24-bit width-1
  vp8x.writeUIntLE(height - 1, 15, 3); // 24-bit height-1
  const riff = Buffer.alloc(12);
  riff.write('RIFF', 0, 'ascii');
  riff.writeUInt32LE(4 + vp8x.length, 4);
  riff.write('WEBP', 8, 'ascii');
  return Buffer.concat([riff, vp8x]).toString('base64');
}

describe('sanitizeScreenshotImage', () => {
  it('accepts a valid PNG and returns a base64 image block', () => {
    const block = sanitizeScreenshotImage(VALID_PNG_B64);
    expect(block).not.toBeNull();
    expect(block!.type).toBe('image');
    expect(block!.mimeType).toBe('image/png');
    expect(block!.data).toBe(VALID_PNG_B64);
  });

  it('accepts a valid JPEG and tags it image/jpeg', () => {
    const block = sanitizeScreenshotImage(VALID_JPEG_B64);
    expect(block).not.toBeNull();
    expect(block!.mimeType).toBe('image/jpeg');
  });

  it('rejects empty string', () => {
    expect(sanitizeScreenshotImage('')).toBeNull();
  });

  it('rejects non-base64 garbage', () => {
    expect(sanitizeScreenshotImage('not%%%base64@@@')).toBeNull();
  });

  it('rejects base64 that decodes to non-image bytes', () => {
    const notImage = Buffer.from('hello world this is plain text').toString(
      'base64',
    );
    expect(sanitizeScreenshotImage(notImage)).toBeNull();
  });

  it('rejects truncated base64 that decodes to fewer than the magic bytes', () => {
    const tiny = Buffer.from([0x89, 0x50]).toString('base64');
    expect(sanitizeScreenshotImage(tiny)).toBeNull();
  });

  it('handles non-string input defensively', () => {
    expect(sanitizeScreenshotImage(undefined)).toBeNull();
    expect(sanitizeScreenshotImage(12345)).toBeNull();
  });
});

describe('sanitizeScreenshotImage — dimension limits', () => {
  it('accepts an in-bounds PNG and reports its dimensions', () => {
    const block = sanitizeScreenshotImage(pngOf(100, 50));
    expect(block).not.toBeNull();
    expect(block!.mimeType).toBe('image/png');
  });

  it('rejects a PNG wider than 8000px (the API dimension limit)', () => {
    expect(sanitizeScreenshotImage(pngOf(9000, 100))).toBeNull();
  });

  it('rejects a PNG taller than 8000px (full-page screenshot case)', () => {
    expect(sanitizeScreenshotImage(pngOf(100, 20000))).toBeNull();
  });

  it('accepts a PNG exactly at the 8000px boundary', () => {
    expect(sanitizeScreenshotImage(pngOf(8000, 8000))).not.toBeNull();
  });

  it('rejects an oversized JPEG by its SOF dimensions', () => {
    expect(sanitizeScreenshotImage(jpegOf(12000, 100))).toBeNull();
  });

  it('accepts an in-bounds JPEG with a parseable SOF', () => {
    expect(sanitizeScreenshotImage(jpegOf(640, 480))).not.toBeNull();
  });

  it('rejects an oversized GIF by its (little-endian) dimensions', () => {
    expect(sanitizeScreenshotImage(gifOf(9000, 100))).toBeNull();
  });

  it('rejects an oversized VP8X WebP by its canvas dimensions', () => {
    expect(sanitizeScreenshotImage(webpVp8xOf(9000, 100))).toBeNull();
  });

  it('accepts an in-bounds VP8X WebP', () => {
    expect(sanitizeScreenshotImage(webpVp8xOf(800, 600))).not.toBeNull();
  });

  it('accepts a valid-magic image whose dimensions cannot be parsed (no over-rejection)', () => {
    // JPEG with no SOF marker — dimensions unknowable; must NOT be dropped,
    // the size cap is the backstop. A real screenshot always has an SOF.
    expect(sanitizeScreenshotImage(VALID_JPEG_B64)).not.toBeNull();
  });
});

describe('sanitizeScreenshotImage — size limit', () => {
  it('rejects a payload over the base64 size limit', () => {
    const pngSig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const huge = Buffer.concat([pngSig, Buffer.alloc(11 * 1024 * 1024, 0)]);
    expect(sanitizeScreenshotImage(huge.toString('base64'))).toBeNull();
  });

  it('accepts a payload comfortably under the size limit', () => {
    // ~1MB valid PNG header + body, small dimensions
    expect(sanitizeScreenshotImage(pngOf(100, 100))).not.toBeNull();
  });
});
