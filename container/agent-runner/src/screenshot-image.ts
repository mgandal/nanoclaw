/**
 * Zero-dependency validation for agent-supplied screenshot images before they
 * become Anthropic image content blocks.
 *
 * Unlike Telegram photos (re-encoded host-side via sharp in src/image.ts),
 * browser screenshots reach the API without any sanitization. A malformed,
 * empty, or oversized base64 payload causes a 400 "Could not process image"
 * that — because the block is saved into the session — replays on every
 * subsequent turn and wedges the session permanently.
 *
 * This validator keeps the container free of native image deps: it inspects
 * magic bytes, base64 size, and header-parsed pixel dimensions, returning null
 * (drop the block, send text only) whenever the payload would be rejected by
 * the API. It cannot catch every rejection (e.g. a structurally corrupt body
 * with a valid header) — Part B (host session-reset on the resulting 400) is
 * the backstop for anything that slips through.
 */

/** The image media types the Anthropic API accepts. */
export type ImageMediaType =
  | 'image/png'
  | 'image/jpeg'
  | 'image/gif'
  | 'image/webp';

export interface ScreenshotImageBlock {
  type: 'image';
  data: string;
  mimeType: ImageMediaType;
}

// The Anthropic first-party API rejects an image whose base64 string exceeds
// ~10MB (the limit is measured on the encoded string, not the decoded bytes).
const MAX_BASE64_BYTES = 10 * 1024 * 1024;

// The API also rejects images larger than 8000px on any side (and resizes
// large ones). A full-page browser screenshot can be tens of thousands of px
// tall while staying small in bytes, so a size check alone is insufficient —
// the same "Could not process image" 400 fires on the dimension limit.
const MAX_DIMENSION = 8000;

/**
 * Extract pixel dimensions from the decoded image header, without an image
 * library. Returns null when the format's dimensions can't be located (e.g. a
 * JPEG with no SOF marker); callers must treat null as "unknown", not "huge",
 * to avoid dropping otherwise-valid images.
 */
function imageDimensions(
  bytes: Buffer,
  mimeType: ImageMediaType,
): { width: number; height: number } | null {
  try {
    if (mimeType === 'image/png') {
      // IHDR is the first chunk: 8-byte sig, 4-byte len, "IHDR", w(4), h(4).
      if (bytes.length < 24) return null;
      return {
        width: bytes.readUInt32BE(16),
        height: bytes.readUInt32BE(20),
      };
    }
    if (mimeType === 'image/gif') {
      // Logical screen descriptor: width/height are little-endian at byte 6.
      if (bytes.length < 10) return null;
      return {
        width: bytes.readUInt16LE(6),
        height: bytes.readUInt16LE(8),
      };
    }
    if (mimeType === 'image/jpeg') {
      // Scan marker segments for a Start-Of-Frame (SOF0..SOF15, excluding
      // DHT/DAC/RST). Dimensions live at offset +5 (height) / +7 (width).
      let off = 2; // skip SOI
      while (off + 9 < bytes.length) {
        if (bytes[off] !== 0xff) {
          off++;
          continue;
        }
        const marker = bytes[off + 1];
        // Standalone markers without a length payload.
        if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
          off += 2;
          continue;
        }
        const segLen = bytes.readUInt16BE(off + 2);
        const isSof =
          marker >= 0xc0 &&
          marker <= 0xcf &&
          marker !== 0xc4 && // DHT
          marker !== 0xc8 && // JPG
          marker !== 0xcc; // DAC
        if (isSof) {
          return {
            height: bytes.readUInt16BE(off + 5),
            width: bytes.readUInt16BE(off + 7),
          };
        }
        off += 2 + segLen;
      }
      return null;
    }
    if (mimeType === 'image/webp') {
      // VP8X (extended): canvas size is 24-bit little-endian minus one.
      const fourCC = bytes.toString('ascii', 12, 16);
      if (fourCC === 'VP8X' && bytes.length >= 30) {
        return {
          width: bytes.readUIntLE(24, 3) + 1,
          height: bytes.readUIntLE(27, 3) + 1,
        };
      }
      if (fourCC === 'VP8 ' && bytes.length >= 30) {
        // Lossy: 14-bit dimensions after the 3-byte start code at offset 23.
        return {
          width: bytes.readUInt16LE(26) & 0x3fff,
          height: bytes.readUInt16LE(28) & 0x3fff,
        };
      }
      if (fourCC === 'VP8L' && bytes.length >= 25) {
        // Lossless: 14-bit dims packed after the 0x2f signature byte.
        const b = bytes.readUInt32LE(21);
        return {
          width: (b & 0x3fff) + 1,
          height: ((b >> 14) & 0x3fff) + 1,
        };
      }
      return null;
    }
  } catch {
    return null;
  }
  return null;
}

function detectMimeType(
  bytes: Buffer,
): ImageMediaType | null {
  if (bytes.length < 12) return null;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  // GIF: "GIF87a" / "GIF89a"
  if (
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return 'image/gif';
  }
  // WebP: "RIFF" .... "WEBP"
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

/**
 * Validate a base64 screenshot payload. Returns a well-formed image content
 * block, or null if the payload is empty, not valid base64, too large, or not
 * a recognized image format. Never throws.
 */
export function sanitizeScreenshotImage(
  base64: unknown,
): ScreenshotImageBlock | null {
  if (typeof base64 !== 'string' || base64.length === 0) return null;

  // Strip a data-URL prefix if present (data:image/png;base64,....).
  const comma = base64.indexOf(',');
  const payload =
    base64.startsWith('data:') && comma !== -1
      ? base64.slice(comma + 1)
      : base64;

  // Reject anything that isn't well-formed base64 (whitespace tolerated).
  const cleaned = payload.replace(/\s/g, '');
  if (cleaned.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned)) {
    return null;
  }
  // The API measures the encoded string against its size limit.
  if (cleaned.length > MAX_BASE64_BYTES) return null;

  let bytes: Buffer;
  try {
    bytes = Buffer.from(cleaned, 'base64');
  } catch {
    return null;
  }
  if (bytes.length === 0) return null;

  const mimeType = detectMimeType(bytes);
  if (!mimeType) return null;

  // Reject over-large dimensions (a small-byte but huge-pixel screenshot still
  // 400s). Unknown dimensions are allowed through — the size cap is the
  // backstop and a real screenshot always carries a parseable header.
  const dims = imageDimensions(bytes, mimeType);
  if (dims && (dims.width > MAX_DIMENSION || dims.height > MAX_DIMENSION)) {
    return null;
  }

  // Re-encode from the validated bytes so the emitted base64 is canonical.
  return { type: 'image', data: bytes.toString('base64'), mimeType };
}
