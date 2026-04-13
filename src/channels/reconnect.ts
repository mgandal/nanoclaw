/**
 * Retry a function with exponential backoff.
 * Used by channels for resilient connection handling.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  attempts: number,
  baseDelayMs: number,
  onRetry?: (attempt: number, error: Error) => void,
): Promise<T> {
  let lastError: Error | undefined;

  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (onRetry) onRetry(i + 1, lastError);
      if (i < attempts - 1) {
        const delay = baseDelayMs * Math.pow(2, i);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError;
}
