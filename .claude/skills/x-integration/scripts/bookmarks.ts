#!/usr/bin/env npx tsx
/**
 * X Integration - Fetch Bookmarks
 * Usage: echo '{"limit":50}' | npx tsx bookmarks.ts
 */

import { getBrowserContext, runScript, config, ScriptResult } from '../lib/browser.js';

interface BookmarksInput {
  limit?: number;
  sinceId?: string;
}

interface Bookmark {
  id: string;
  url: string;
  author: string;
  handle: string;
  text: string;
}

const DEFAULT_LIMIT = 50;
const MAX_SCROLL_ATTEMPTS = 20;
const MAX_STALE_SCROLLS = 3;

async function fetchBookmarks(input: BookmarksInput): Promise<ScriptResult> {
  const limit = input.limit ?? DEFAULT_LIMIT;
  const sinceId = input.sinceId;

  let context = null;
  try {
    context = await getBrowserContext();
    const page = context.pages()[0] || await context.newPage();

    await page.goto('https://x.com/i/bookmarks', {
      timeout: config.timeouts.navigation,
      waitUntil: 'domcontentloaded',
    });
    await page.waitForTimeout(config.timeouts.pageLoad);

    // Check if bookmarks page loaded with tweets
    const hasArticles = await page
      .locator('article[data-testid="tweet"]')
      .first()
      .isVisible()
      .catch(() => false);

    if (!hasArticles) {
      // Could be empty bookmarks or a load failure
      const emptyIndicator = await page
        .locator('text=/Save posts for later|You haven/')
        .isVisible()
        .catch(() => false);

      if (emptyIndicator) {
        return {
          success: true,
          message: 'No bookmarks found',
          data: { bookmarks: [] },
        };
      }

      // Wait a bit longer and retry
      await page.waitForTimeout(config.timeouts.elementWait);
      const retryArticles = await page
        .locator('article[data-testid="tweet"]')
        .first()
        .isVisible()
        .catch(() => false);

      if (!retryArticles) {
        return {
          success: false,
          message: 'Failed to load bookmarks page. You may not be logged in.',
        };
      }
    }

    const bookmarks: Bookmark[] = [];
    const seenIds = new Set<string>();
    let staleScrolls = 0;
    let scrollAttempts = 0;

    while (scrollAttempts < MAX_SCROLL_ATTEMPTS) {
      const articles = page.locator('article[data-testid="tweet"]');
      const count = await articles.count();
      let newFound = 0;

      for (let i = 0; i < count; i++) {
        if (bookmarks.length >= limit) break;

        const article = articles.nth(i);

        // Extract tweet URL and ID
        const statusLink = article.locator('a[href*="/status/"]').first();
        const href = await statusLink.getAttribute('href').catch(() => null);
        if (!href) continue;

        const idMatch = href.match(/\/status\/(\d+)/);
        if (!idMatch) continue;

        const id = idMatch[1];

        if (seenIds.has(id)) continue;

        // Stop if we've reached the sinceId marker
        if (sinceId && id === sinceId) {
          staleScrolls = MAX_STALE_SCROLLS; // force exit
          break;
        }

        // Extract author and handle from User-Name element
        const userNameEl = article.locator('[data-testid="User-Name"]').first();
        const userText = await userNameEl.textContent().catch(() => '');
        // Format is typically "Display Name@handle·time"
        const handleMatch = userText.match(/@([\w]+)/);
        const handle = handleMatch ? `@${handleMatch[1]}` : '';
        // Author is everything before the @handle
        const author = handleMatch
          ? userText.slice(0, userText.indexOf(handleMatch[0])).trim()
          : userText.trim();

        // Extract tweet text
        const tweetTextEl = article.locator('[data-testid="tweetText"]').first();
        const text = await tweetTextEl.textContent().catch(() => '');

        seenIds.add(id);
        newFound++;
        bookmarks.push({
          id,
          url: `https://x.com${href}`,
          author,
          handle,
          text: text || '',
        });
      }

      if (bookmarks.length >= limit) break;

      if (newFound === 0) {
        staleScrolls++;
        if (staleScrolls >= MAX_STALE_SCROLLS) break;
      } else {
        staleScrolls = 0;
      }

      // Scroll down and wait for new content
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
      await page.waitForTimeout(2000);
      scrollAttempts++;
    }

    return {
      success: true,
      message: `Fetched ${bookmarks.length} bookmark${bookmarks.length === 1 ? '' : 's'}`,
      data: { bookmarks },
    };
  } finally {
    if (context) await context.close();
  }
}

runScript<BookmarksInput>(fetchBookmarks);
