/**
 * Browser Automation - Configuration
 */

import path from 'path';

const PROJECT_ROOT = process.env.NANOCLAW_ROOT || process.cwd();

export const config = {
  chromePath:
    process.env.CHROME_PATH ||
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',

  // Separate profile from X integration to avoid conflicts
  browserDataDir: path.join(PROJECT_ROOT, 'data', 'browser-profile'),

  viewport: {
    width: 1280,
    height: 900,
  },

  timeouts: {
    navigation: 30000,
    elementWait: 10000,
    afterClick: 1500,
    afterFill: 500,
    pageLoad: 3000,
  },

  chromeArgs: [
    '--disable-blink-features=AutomationControlled',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
  ],

  chromeIgnoreDefaultArgs: ['--enable-automation'],
};
