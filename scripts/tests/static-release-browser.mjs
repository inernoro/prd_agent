// Browser regression against real nginx and the production release functions.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const [repo, root, base] = process.argv.slice(2);
const require = createRequire(join(repo, 'cds/package.json'));
const { chromium } = process.env.PLAYWRIGHT_MODULE
  ? await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href)
  : require('playwright');
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const failures = [];
context.on('page', page => {
  page.on('pageerror', error => failures.push(error.message));
  page.on('requestfailed', request => failures.push(request.url()));
  page.on('response', response => {
    if (response.status() >= 400) failures.push(`${response.status()} ${response.url()}`);
  });
});
function activate(version) {
  // Existing releases are retained by the fixture: switching back exercises
  // rollback's cache refresh and asset preservation using the actual library.
  execFileSync('sh', ['-c', '. "$1/scripts/lib/static-release.sh"; static_release_rollback "$2" ".releases/cache-$3"', 'test', repo, root, version]);
}
async function visible(page, expected) {
  await page.waitForFunction(value => document.querySelector('#root')?.textContent === value, expected);
  assert.equal(await page.locator('#root').textContent(), expected);
}
try {
  const oldTab = await context.newPage();
  await oldTab.goto(`${base}/visual-agent`);
  await visible(oldTab, 'A');
  const cachedHtml = await oldTab.content();
  activate('B');
  // A page already running A can still import its lazy chunk after B goes live.
  await oldTab.evaluate(() => window.loadChunk());
  await visible(oldTab, 'A chunk');
  // Simulate a client still holding old HTML, with a fresh asset cache.
  const staleContext = await browser.newContext();
  try {
    const staleTab = await staleContext.newPage();
    await staleTab.route(`${base}/visual-agent`, route => route.fulfill({ body: cachedHtml, contentType: 'text/html' }));
    await staleTab.goto(`${base}/visual-agent`);
    await visible(staleTab, 'A');
    await staleTab.evaluate(() => window.loadChunk());
    await visible(staleTab, 'A chunk');
  } finally {
    await staleContext.close();
  }
  const newTab = await context.newPage();
  await newTab.goto(`${base}/visual-agent`);
  await visible(newTab, 'B');
  // Ordinary reload (cache enabled) must get B rather than stale cached A HTML.
  await oldTab.reload();
  await visible(oldTab, 'B');
  activate('A');
  await newTab.evaluate(() => window.loadChunk());
  await visible(newTab, 'B chunk');
  await oldTab.reload();
  await visible(oldTab, 'A');
  assert.deepEqual(failures, []);
  console.log('Static release browser test: PASS (cached reload, old tab lazy import, rollback, visible content, no resource errors)');
} finally {
  await context.close();
  await browser.close();
}
