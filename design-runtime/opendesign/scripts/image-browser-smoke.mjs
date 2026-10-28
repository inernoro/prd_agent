import { chromium } from 'playwright-core';

const executablePath = process.env.DESIGN_RUNTIME_BROWSER_EXECUTABLE_PATH;
const expectedVersion = process.env.DESIGN_RUNTIME_BROWSER_VERSION;
if (!executablePath || !expectedVersion) {
  throw new Error('browser image smoke requires executable path and expected version');
}

const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ['--disable-dev-shm-usage', '--no-sandbox'],
});

try {
  if (browser.version() !== expectedVersion) {
    throw new Error(`unexpected Chromium version: ${browser.version()}`);
  }

  for (const viewport of [
    { name: 'desktop', width: 1440, height: 900 },
    { name: 'mobile', width: 390, height: 844 },
  ]) {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    await page.setContent('<!doctype html><html><body><main>browser-ready</main></body></html>');
    const measured = await page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
      text: document.querySelector('main')?.textContent,
    }));
    await context.close();
    if (measured.width !== viewport.width
      || measured.height !== viewport.height
      || measured.text !== 'browser-ready') {
      throw new Error(`failed ${viewport.name} viewport smoke`);
    }
    console.log(`[browser-image-smoke] ${viewport.name} ${measured.width}x${measured.height}: PASS`);
  }
} finally {
  await browser.close();
}
