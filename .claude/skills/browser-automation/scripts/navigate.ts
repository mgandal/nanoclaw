/**
 * Browser Automation - Navigate to URL
 * Returns page title and a text snapshot of visible content.
 */

import { runScript, getBrowserContext } from '../lib/browser.js';
import { config } from '../lib/config.js';

interface Input {
  url: string;
}

runScript<Input>(async (input) => {
  const context = await getBrowserContext();
  try {
    const page = context.pages()[0] || (await context.newPage());
    await page.goto(input.url, {
      timeout: config.timeouts.navigation,
      waitUntil: 'domcontentloaded',
    });
    await page.waitForTimeout(config.timeouts.pageLoad);

    const title = await page.title();
    const url = page.url();

    // Get readable text content (trimmed, deduplicated whitespace)
    const text = await page.evaluate(() => {
      // Remove script/style/nav/footer elements for cleaner extraction
      const clone = document.body.cloneNode(true) as HTMLElement;
      for (const el of clone.querySelectorAll(
        'script, style, noscript, svg, nav, footer, header',
      )) {
        el.remove();
      }
      return clone.innerText
        .replace(/\n{3,}/g, '\n\n')
        .replace(/[ \t]+/g, ' ')
        .trim();
    });

    // Truncate to avoid massive responses
    const maxChars = 30000;
    const truncated =
      text.length > maxChars
        ? text.slice(0, maxChars) + `\n\n[Truncated — ${text.length} chars total]`
        : text;

    return {
      success: true,
      message: `Navigated to: ${title}`,
      data: { title, url, text: truncated },
    };
  } finally {
    await context.close();
  }
});
