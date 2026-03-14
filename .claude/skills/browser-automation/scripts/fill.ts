/**
 * Browser Automation - Fill form fields and optionally submit
 */

import { runScript, getBrowserContext } from '../lib/browser.js';
import { config } from '../lib/config.js';

interface FieldEntry {
  selector: string;
  value: string;
}

interface Input {
  url?: string;
  fields: FieldEntry[];
  submit_selector?: string;
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

    // Fill each field
    for (const field of input.fields) {
      const locator = page.locator(field.selector).first();
      await locator.waitFor({
        state: 'visible',
        timeout: config.timeouts.elementWait,
      });
      await locator.fill(field.value);
      await page.waitForTimeout(config.timeouts.afterFill);
    }

    // Optionally click submit
    if (input.submit_selector) {
      const submit = page.locator(input.submit_selector).first();
      await submit.waitFor({
        state: 'visible',
        timeout: config.timeouts.elementWait,
      });
      await submit.click();
      await page.waitForTimeout(config.timeouts.afterClick);
      await page
        .waitForLoadState('domcontentloaded', { timeout: 10000 })
        .catch(() => {});
    }

    const title = await page.title();
    const url = page.url();

    return {
      success: true,
      message: `Filled ${input.fields.length} field(s)${input.submit_selector ? ' and submitted' : ''}`,
      data: { title, url, fieldsFilled: input.fields.length },
    };
  } finally {
    await context.close();
  }
});
