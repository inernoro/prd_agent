import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { chromium } from 'playwright';
import { readPrototypeScreen, type DesignReferenceTarget } from '../services/design-framework-browser.js';
import { decorateDesignPrototype } from '../services/design-prototype.js';

async function snapshot() {
  if (!existsSync('/.dockerenv') || process.getuid?.() !== 1000) throw new Error('Cover worker requires the render container');
  const reader = createInterface({ input: process.stdin });
  const { value: input } = await reader[Symbol.asyncIterator]().next();
  reader.close();
  process.stdin.pause();
  if (typeof input !== 'string' || input.length > 6 * 1024 * 1024) throw new Error('Invalid cover input');
  const { prototype, target } = JSON.parse(input) as { prototype: string; target: DesignReferenceTarget };
  const html = decorateDesignPrototype(Buffer.from(prototype, 'base64').toString('utf8'));
  // This Chromium process lives in a disposable read-only container with no network, mounts or capabilities.
  const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', timeout: 5000,
    args: ['--disable-background-networking', '--no-proxy-server'] });
  try {
    const bytes = await readPrototypeScreen(browser, html, target.screen, target.theme, page =>
      page.screenshot({ animations: 'disabled', caret: 'hide', timeout: 5000 }));
    if (!bytes) throw new Error('Cover screen is unavailable');
    process.stdout.write(bytes.toString('base64'));
  } finally {
    await browser.close().catch(() => {});
  }
}

snapshot().catch(() => {
  process.stderr.write('CDS could not capture the design cover\n');
  process.exitCode = 1;
});
