import { describe, it, expect } from 'vitest';

import { normalizeOllamaHost } from './index-helpers.js';

// `OLLAMA_HOST` is deliberately set to the Ollama SERVER bind address (0.0.0.0)
// by com.nanoclaw.ollama-host-env.plist so Apple Container VMs can reach Ollama
// on all interfaces. But the same env var is reused as a CLIENT base URL for
// `fetch(...)` in event-router.ts; a bind-all address with no scheme breaks
// `new URL()` and floods the log with ERR_INVALID_URL on every vault change.
// normalizeOllamaHost() turns whatever the env supplies into a connectable URL.
describe('normalizeOllamaHost', () => {
  it('rewrites a bare bind address 0.0.0.0 to a connectable localhost URL', () => {
    expect(normalizeOllamaHost('0.0.0.0')).toBe('http://127.0.0.1:11434');
  });

  it('leaves a fully-formed http URL unchanged', () => {
    expect(normalizeOllamaHost('http://localhost:11434')).toBe(
      'http://localhost:11434',
    );
  });

  it('prepends http:// to a scheme-less host:port', () => {
    expect(normalizeOllamaHost('192.168.64.1:11434')).toBe(
      'http://192.168.64.1:11434',
    );
  });

  it('leaves an https URL unchanged', () => {
    expect(normalizeOllamaHost('https://example.com')).toBe(
      'https://example.com',
    );
  });

  it('rewrites 0.0.0.0 even when a scheme is already present', () => {
    expect(normalizeOllamaHost('http://0.0.0.0:11434')).toBe(
      'http://127.0.0.1:11434',
    );
  });

  it('appends the default Ollama port to a bare (scheme-less) host', () => {
    expect(normalizeOllamaHost('0.0.0.0')).toBe('http://127.0.0.1:11434');
    expect(normalizeOllamaHost('localhost')).toBe('http://localhost:11434');
  });

  it('does NOT force the default port onto an operator-written URL', () => {
    // An explicit scheme means the operator chose the target; trust its port
    // (or scheme default) rather than rewriting it to 11434.
    expect(normalizeOllamaHost('http://localhost')).toBe('http://localhost');
  });

  it('falls back to the default URL for an empty / whitespace value', () => {
    expect(normalizeOllamaHost('')).toBe('http://127.0.0.1:11434');
    expect(normalizeOllamaHost('   ')).toBe('http://127.0.0.1:11434');
  });

  it('always returns a value that parses with new URL() without throwing', () => {
    for (const raw of [
      '0.0.0.0',
      'http://localhost:11434',
      '192.168.64.1:11434',
      'https://example.com',
      'http://0.0.0.0:11434',
      'http://localhost',
      '',
      '   ',
    ]) {
      expect(() => new URL(normalizeOllamaHost(raw))).not.toThrow();
    }
  });
});
