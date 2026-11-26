import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { chromium } from 'playwright';
import { runDesignHandoff, type DesignHandoffInput } from '../services/design-handoff-browser.js';
import { readPrototypeScreen, type DesignReferenceTarget } from '../services/design-framework-browser.js';
import { decorateDesignPrototype } from '../services/design-prototype.js';

async function snapshot() {
  if (!existsSync('/.dockerenv') || process.getuid?.() !== 1000) throw new Error('Cover worker requires the render container');
  const reader = createInterface({ input: process.stdin });
  const { value: input } = await reader[Symbol.asyncIterator]().next();
  reader.close();
  process.stdin.pause();
  if (typeof input !== 'string' || input.length > 8 * 1024 * 1024) throw new Error('Invalid cover input');
  const request = JSON.parse(input) as { prototype: string; target: DesignReferenceTarget }
    | { prototype: string; references: DesignReferenceTarget[] }
    | (Omit<DesignHandoffInput, 'prototype'> & { prototype: string });
  const prototype = Buffer.from(request.prototype, 'base64');
  // This Chromium process lives in a disposable read-only container with no network, mounts or capabilities.
  const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', timeout: 5000,
    args: ['--disable-background-networking', '--no-proxy-server'] });
  try {
    if ('cases' in request) {
      const result = await runDesignHandoff(browser, { prototype, cases: request.cases, screens: request.screens });
      process.stdout.write(JSON.stringify(result));
      return;
    }
    const html = decorateDesignPrototype(prototype.toString('utf8'));
    const capture = (target: DesignReferenceTarget) =>
      readPrototypeScreen(browser, html, target.screen, target.theme, page =>
        page.screenshot({ animations: 'disabled', caret: 'hide', timeout: 5000 }));
    if ('references' in request) {
      const pngs: Array<string | null> = [];
      for (const target of request.references) {
        const bytes = await capture(target);
        pngs.push(bytes && bytes.length <= 1536 * 1024 ? bytes.toString('base64') : null);
      }
      process.stdout.write(JSON.stringify(pngs));
      return;
    }
    const bytes = await capture(request.target);
    if (!bytes) throw new Error('Cover screen is unavailable');
    process.stdout.write(bytes.toString('base64'));
  } finally {
    await browser.close().catch(() => {});
  }
}

snapshot().catch(() => {
  process.stderr.write('CDS isolated design browser could not complete the request\n');
  process.exitCode = 1;
});
