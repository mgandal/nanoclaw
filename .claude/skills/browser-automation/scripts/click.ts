/**
 * Browser Automation - Click an element
 * Navigates to URL (if provided), clicks a selector, returns updated page text.
 */

import { runScript, getBrowserContext } from '../lib/browser.js';
import { config } from '../lib/config.js';

interface Input {
  url?: string;
  selector: string;
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

    // Wait for element and click
    const locator = page.locator(input.selector).first();
    await locator.waitFor({
      state: 'visible',
      timeout: config.timeouts.elementWait,
    });
    await locator.click();
    await page.waitForTimeout(config.timeouts.afterClick);

    // Wait for any navigation to settle
    await page
      .waitForLoadState('domcontentloaded', { timeout: 5000 })
      .catch(() => {});

    const title = await page.title();
    const url = page.url();

    return {
      success: true,
      message: `Clicked "${input.selector}" — now on: ${title}`,
      data: { title, url },
    };
  } finally {
    await context.close();
  }
});
