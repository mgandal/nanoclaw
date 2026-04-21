import { describe, it, expect } from 'vitest';
import { pathToSlug, slugToPath, isAvailable } from './slug.js';

describe('pathToSlug', () => {
  it('URL-encodes the path and strips .md extension', () => {
    expect(pathToSlug('99-wiki/tools/polars-bio.md')).toBe('99-wiki%2Ftools%2Fpolars-bio');
  });

  it('keeps no-extension path as-is (URL-encoded)', () => {
    expect(pathToSlug('99-wiki/tools/polars-bio')).toBe('99-wiki%2Ftools%2Fpolars-bio');
  });

  it('handles paths with special chars', () => {
    expect(pathToSlug('70-areas/Mike & Morgan.md')).toBe('70-areas%2FMike%20%26%20Morgan');
  });
});

describe('slugToPath', () => {
  it('is the inverse of pathToSlug without extension', () => {
    const slug = pathToSlug('99-wiki/tools/polars-bio.md');
    expect(slugToPath(slug)).toBe('99-wiki/tools/polars-bio');
  });

  it('decodes percent-escaped separators', () => {
    expect(slugToPath('70-areas%2FMike%20%26%20Morgan')).toBe('70-areas/Mike & Morgan');
  });
});

describe('isAvailable', () => {
  const available = [
    '99-wiki%2Ftools%2Fpolars-bio',
    '10-daily%2F2026-04-20',
  ];

  it('returns true when slug is in the array', () => {
    expect(isAvailable('99-wiki/tools/polars-bio.md', available)).toBe(true);
  });

  it('returns false when slug is not in the array', () => {
    expect(isAvailable('30-lab/secrets.md', available)).toBe(false);
  });

  it('handles the no-extension form', () => {
    expect(isAvailable('10-daily/2026-04-20', available)).toBe(true);
  });
});
