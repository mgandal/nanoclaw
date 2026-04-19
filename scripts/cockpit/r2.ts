import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

export function makeR2Client(endpoint: string, accessKeyId: string, secretAccessKey: string): S3Client {
  return new S3Client({
    endpoint,
    region: 'auto',
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: false,
  });
}

/**
 * Upload one object. Retries once on 5xx (or no status); fails fast on 4xx.
 * Body may be a string or Uint8Array.
 */
export async function uploadObject(
  client: { send: (cmd: PutObjectCommand) => Promise<unknown> },
  bucket: string,
  key: string,
  body: string | Uint8Array,
  contentType: string,
  retryDelayMs = 30_000,
): Promise<void> {
  const cmd = new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType });
  try {
    await client.send(cmd);
  } catch (err) {
    const code = extractStatus(err);
    if (code !== null && code >= 400 && code < 500) throw err;
    await sleep(retryDelayMs);
    await client.send(cmd);
  }
}

function extractStatus(err: unknown): number | null {
  if (typeof err === 'object' && err !== null && '$metadata' in err) {
    const m = (err as { $metadata?: { httpStatusCode?: number } }).$metadata;
    return typeof m?.httpStatusCode === 'number' ? m.httpStatusCode : null;
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
