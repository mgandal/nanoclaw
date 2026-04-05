import { describe, it, expect } from 'bun:test';
import sharp from 'sharp';
import { processImage } from './image.js';

describe('processImage', () => {
  it('resizes a large image to fit within 1024px', async () => {
    // Create a 2048x1536 test image
    const input = await sharp({
      create: { width: 2048, height: 1536, channels: 3, background: { r: 255, g: 0, b: 0 } },
    })
      .png()
      .toBuffer();

    const result = await processImage(input);

    expect(result.mediaType).toBe('image/jpeg');
    expect(result.base64).toBeTruthy();

    // Decode and check dimensions
    const decoded = Buffer.from(result.base64, 'base64');
    const meta = await sharp(decoded).metadata();
    expect(meta.width).toBeLessThanOrEqual(1024);
    expect(meta.height).toBeLessThanOrEqual(1024);
    // Should preserve aspect ratio (2048:1536 = 4:3)
    expect(meta.width).toBe(1024);
    expect(meta.height).toBe(768);
  });

  it('does not enlarge small images', async () => {
    const input = await sharp({
      create: { width: 200, height: 150, channels: 3, background: { r: 0, g: 255, b: 0 } },
    })
      .png()
      .toBuffer();

    const result = await processImage(input);
    const decoded = Buffer.from(result.base64, 'base64');
    const meta = await sharp(decoded).metadata();
    expect(meta.width).toBe(200);
    expect(meta.height).toBe(150);
  });

  it('converts PNG to JPEG', async () => {
    const input = await sharp({
      create: { width: 100, height: 100, channels: 3, background: { r: 0, g: 0, b: 255 } },
    })
      .png()
      .toBuffer();

    const result = await processImage(input);
    expect(result.mediaType).toBe('image/jpeg');

    const decoded = Buffer.from(result.base64, 'base64');
    const meta = await sharp(decoded).metadata();
    expect(meta.format).toBe('jpeg');
  });

  it('returns valid base64 string', async () => {
    const input = await sharp({
      create: { width: 50, height: 50, channels: 3, background: { r: 128, g: 128, b: 128 } },
    })
      .jpeg()
      .toBuffer();

    const result = await processImage(input);
    // Should be valid base64 (no padding issues)
    expect(() => Buffer.from(result.base64, 'base64')).not.toThrow();
    expect(Buffer.from(result.base64, 'base64').length).toBeGreaterThan(0);
  });

  it('handles square images correctly', async () => {
    const input = await sharp({
      create: { width: 2000, height: 2000, channels: 3, background: { r: 255, g: 255, b: 0 } },
    })
      .png()
      .toBuffer();

    const result = await processImage(input);
    const decoded = Buffer.from(result.base64, 'base64');
    const meta = await sharp(decoded).metadata();
    expect(meta.width).toBe(1024);
    expect(meta.height).toBe(1024);
  });

  it('handles portrait orientation', async () => {
    const input = await sharp({
      create: { width: 1536, height: 2048, channels: 3, background: { r: 0, g: 128, b: 255 } },
    })
      .png()
      .toBuffer();

    const result = await processImage(input);
    const decoded = Buffer.from(result.base64, 'base64');
    const meta = await sharp(decoded).metadata();
    expect(meta.width).toBe(768);
    expect(meta.height).toBe(1024);
  });

  it('rejects invalid input', async () => {
    const garbage = Buffer.from('not an image at all');
    await expect(processImage(garbage)).rejects.toThrow();
  });
});
