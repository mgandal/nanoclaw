/**
 * Browser Automation - Extract content from page
 * Can extract text from specific selectors, all links, or structured data.
 */

import { runScript, getBrowserContext } from '../lib/browser.js';
import { config } from '../lib/config.js';

interface Input {
  url?: string;
  selector?: string;
  extract_type: 'text' | 'links' | 'tables' | 'html';
}

runScript<Input>(async (input) => {
  const context = await getBrowserContext();
  try {
    const page = context.pages()[0] || (await context.newPage());

    if (input.url) {
      await page.goto(input.url, {
        timeout: config.timeouts.navigation,
        waitUntil: 'domcontentloaded',
      });
      await page.waitForTimeout(config.timeouts.pageLoad);
    }

    const title = await page.title();
    const url = page.url();
    let extracted: unknown;

    switch (input.extract_type) {
      case 'text': {
        const sel = input.selector || 'body';
        const text = await page
          .locator(sel)
          .first()
          .innerText({ timeout: config.timeouts.elementWait })
          .catch(() => '');
        const clean = text
          .replace(/\n{3,}/g, '\n\n')
          .replace(/[ \t]+/g, ' ')
          .trim();
        const maxChars = 30000;
        extracted =
          clean.length > maxChars
            ? clean.slice(0, maxChars) +
              `\n\n[Truncated — ${clean.length} chars total]`
            : clean;
        break;
      }

      case 'links': {
        const sel = input.selector || 'a[href]';
        extracted = await page.evaluate((s) => {
          const links: { text: string; href: string }[] = [];
          for (const a of document.querySelectorAll(s)) {
            const href = (a as HTMLAnchorElement).href;
            const text = (a as HTMLElement).innerText.trim();
            if (href && !href.startsWith('javascript:')) {
              links.push({ text: text.slice(0, 200), href });
            }
          }
          return links.slice(0, 200);
        }, sel);
        break;
      }

      case 'tables': {
        const sel = input.selector || 'table';
        extracted = await page.evaluate((s) => {
          const tables: string[][][] = [];
          for (const table of document.querySelectorAll(s)) {
            const rows: string[][] = [];
            for (const row of table.querySelectorAll('tr')) {
              const cells: string[] = [];
              for (const cell of row.querySelectorAll('td, th')) {
                cells.push((cell as HTMLElement).innerText.trim());
              }
              rows.push(cells);
            }
            tables.push(rows);
          }
          return tables.slice(0, 10);
        }, sel);
        break;
      }

      case 'html': {
        const sel = input.selector || 'body';
        const html = await page
          .locator(sel)
          .first()
          .innerHTML({ timeout: config.timeouts.elementWait })
          .catch(() => '');
        const maxChars = 30000;
        extracted =
          html.length > maxChars
            ? html.slice(0, maxChars) +
              `\n\n[Truncated — ${html.length} chars total]`
            : html;
        break;
      }
    }

    return {
      success: true,
      message: `Extracted ${input.extract_type} from ${title}`,
      data: { title, url, content: extracted },
    };
  } finally {
    await context.close();
  }
});
