/**
 * Browser Automation - Take screenshot
 * Returns base64-encoded PNG of the page or a specific element.
 */

import { runScript, getBrowserContext } from '../lib/browser.js';
import { config } from '../lib/config.js';

interface Input {
  url?: string;
  selector?: string;
  full_page?: boolean;
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

    let buffer: Buffer;

    if (input.selector) {
      const el = page.locator(input.selector).first();
      await el.waitFor({
        state: 'visible',
        timeout: config.timeouts.elementWait,
      });
      buffer = await el.screenshot({ type: 'png' });
    } else {
      buffer = await page.screenshot({
        type: 'png',
        fullPage: input.full_page ?? false,
      });
    }

    const title = await page.title();
    const url = page.url();

    return {
      success: true,
      message: `Screenshot taken: ${title} (${buffer.length} bytes)`,
      data: {
        title,
        url,
        screenshot_base64: buffer.toString('base64'),
        size_bytes: buffer.length,
      },
    };
  } finally {
    await context.close();
  }
});
