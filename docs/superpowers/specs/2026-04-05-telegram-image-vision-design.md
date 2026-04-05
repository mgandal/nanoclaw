# Telegram Image Vision

**Date**: 2026-04-05
**Status**: Design

## Problem

Photos sent via Telegram arrive as `[Photo]` placeholder text. The agent never sees the actual image content. This blocks the wiki's ability to ingest image sources and limits CLAIRE's usefulness for visual content.

## Solution

Download, resize, and pass Telegram photos as base64-encoded multimodal content blocks to the Claude Agent SDK. The agent sees the actual image and can describe, analyze, or ingest it.

## Architecture

Three-layer change matching NanoClaw's existing message pipeline:

### Layer 1 — Image Processing (`src/image.ts`, new file)

```typescript
export interface ImageAttachment {
  base64: string;
  mediaType: string; // 'image/jpeg'
}

export async function processImage(buffer: Buffer): Promise<ImageAttachment>
```

- Accepts a raw image buffer (any format sharp supports: JPEG, PNG, WebP, HEIC, etc.)
- Resizes to max 1024px on longest side (preserves aspect ratio)
- Converts to JPEG quality 85
- Returns base64-encoded string + media type
- Throws on failure (caller handles graceful degradation)

### Layer 2 — Telegram Channel (`src/channels/telegram.ts`)

Replace the `message:photo` handler:

```typescript
this.bot.on('message:photo', async (ctx) => {
  // Telegram provides multiple sizes; pick the largest
  const photos = ctx.message.photo;
  const largest = photos[photos.length - 1];
  
  try {
    const file = await ctx.api.getFile(largest.file_id);
    const url = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
    const resp = await fetch(url);
    const buffer = Buffer.from(await resp.arrayBuffer());
    const image = await processImage(buffer);
    
    // Store message with image attachment
    storeWithImage(ctx, '[Photo]', [image]);
  } catch (err) {
    logger.warn({ err }, 'Failed to process photo');
    storeNonText(ctx, '[Photo]'); // graceful fallback
  }
});
```

New `storeWithImage` function: same as `storeNonText` but attaches `images` array to the `NewMessage`.

### Layer 3 — Types (`src/types.ts`)

Add to `NewMessage`:

```typescript
export interface NewMessage {
  // ... existing fields
  images?: ImageAttachment[];
}
```

Re-export `ImageAttachment` from `src/image.ts`.

### Layer 4 — Container Runner (`src/container-runner.ts`)

Add to `ContainerInput`:

```typescript
export interface ContainerInput {
  // ... existing fields
  images?: ImageAttachment[];
}
```

Thread `images` from the triggering message into the container input. The container input is serialized as JSON to stdin.

### Layer 5 — Agent Runner (`container/agent-runner/src/index.ts`)

Modify `MessageStream.push` to support multimodal content:

```typescript
push(text: string, images?: ImageAttachment[]): void {
  const content = images?.length
    ? [
        ...images.map(img => ({
          type: 'image' as const,
          source: { type: 'base64' as const, media_type: img.mediaType, data: img.base64 },
        })),
        { type: 'text' as const, text },
      ]
    : text;
    
  this.queue.push({
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: null,
    session_id: '',
  });
}
```

The SDK's `query` function accepts content blocks in the Anthropic API format. When `content` is an array of blocks (image + text), Claude sees the image as multimodal input.

### Layer 6 — Main Orchestrator (`src/index.ts`)

Thread images from the accumulated messages through to `runContainerAgent`. The trigger message's images are passed in `ContainerInput.images`.

## Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Max image size | 1024px longest side | Balances quality with token cost (Claude charges by pixel) |
| Output format | JPEG quality 85 | Consistent format, good compression |
| Resize library | sharp | Fast native library, well-maintained, handles all input formats |
| Multiple photos | Supported | Telegram photo albums send multiple photos in one message |
| Failure mode | Graceful fallback to `[Photo]` | Never crash on image processing failure |

## Testing

- `src/image.test.ts`: Unit tests for `processImage` — resize logic, format conversion, error handling
- Integration: send a photo in Telegram, verify agent describes image content in response

## Out of Scope

- Video frame extraction
- Voice transcription (separate task)
- Sticker/GIF/animation handling
- Image OCR (Claude handles this natively via vision)
