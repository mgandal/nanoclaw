/**
 * Path → URL slug: strip .md, then encodeURIComponent.
 * Mirrors scripts/cockpit/vault-scan.ts → pathToSlug().
 */
export function pathToSlug(relPath: string): string {
  const noExt = relPath.replace(/\.md$/, '');
  return encodeURIComponent(noExt);
}

/**
 * URL slug → path (without extension). Inverse of pathToSlug, except that
 * a .md extension on the input (before encoding) is lost; callers that need
 * to fetch pages/<slug>.md from R2 should work in slug-space directly.
 */
export function slugToPath(slug: string): string {
  return decodeURIComponent(slug);
}

/**
 * Is a given relative path represented in vault_pages_available?
 * vault_pages_available contains already-encoded slugs (without .md).
 */
export function isAvailable(relPath: string, available: string[]): boolean {
  const slug = pathToSlug(relPath);
  return available.includes(slug);
}
