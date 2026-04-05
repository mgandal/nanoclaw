import sharp from 'sharp';
import { logger } from './logger.js';

export interface ImageAttachment {
  base64: string;
  mediaType: string;
}

const MAX_DIMENSION = 1024;
const JPEG_QUALITY = 85;

/**
 * Resize an image buffer to fit within MAX_DIMENSION and encode as JPEG base64.
 * Accepts any format sharp supports (JPEG, PNG, WebP, HEIC, TIFF, etc.).
 */
export async function processImage(buffer: Buffer): Promise<ImageAttachment> {
  const resized = await sharp(buffer)
    .resize(MAX_DIMENSION, MAX_DIMENSION, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: JPEG_QUALITY })
    .toBuffer();

  logger.info(
    { originalSize: buffer.length, resizedSize: resized.length },
    'Processed image for vision',
  );

  return {
    base64: resized.toString('base64'),
    mediaType: 'image/jpeg',
  };
}

/**
 * Download a file from a URL and return as Buffer.
 */
export async function downloadFile(url: string): Promise<Buffer> {
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Download failed: ${resp.status} ${resp.statusText}`);
  }
  return Buffer.from(await resp.arrayBuffer());
}
