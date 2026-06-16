#!/usr/bin/env node
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const playwrightPath = process.env.PWPATH || '/opt/node22/lib/node_modules/playwright';
const { chromium } = require(playwrightPath);

const baseUrl = (process.argv[2] || process.env.CDS_HOST || 'http://127.0.0.1:9900').replace(/\/+$/, '');
const viewports = [
  { label: '390', width: 390, height: 844 },
  { label: '600', width: 600, height: 844 },
  { label: '760', width: 760, height: 844 },
];

function assertOk(condition, message, details = {}) {
  if (!condition) {
    const suffix = Object.keys(details).length ? ` ${JSON.stringify(details)}` : '';
    throw new Error(`${message}${suffix}`);
  }
}

async function getFirstProject(page) {
  const response = await page.request.get(`${baseUrl}/api/projects`);
  assertOk(response.ok(), 'GET /api/projects failed', { status: response.status() });
  const body = await response.json();
  const project = body?.data?.[0] || body?.data?.items?.[0] || body?.projects?.[0];
  assertOk(project?.id, 'No project available for mobile layout smoke');
  return project;
}

async function checkLayout(page, label) {
  const result = await page.evaluate(() => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const bodyText = document.body.innerText || '';
    const root = document.querySelector('.cds-branch-detail-drawer')
      || Array.from(document.querySelectorAll('[role="dialog"][aria-modal="true"]'))
        .find((el) => {
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        })
      || document.body;
    const overflow = Math.max(
      document.documentElement.scrollWidth,
      document.body.scrollWidth,
    ) - vw;

    const squeezed = [];
    const textNodes = Array.from(root.querySelectorAll('button,a,h1,h2,h3,span,[role="button"],[role="tab"]'));
    for (const el of textNodes) {
      const rect = el.getBoundingClientRect();
      const text = (el.textContent || '').trim().replace(/\s+/g, '');
      if (!text || text.length < 2 || text.length > 12) continue;
      if (rect.width > 0 && rect.width < 24 && rect.height > 36) {
        squeezed.push({
          text,
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          x: Math.round(rect.x),
          y: Math.round(rect.y),
        });
      }
    }

    const covered = [];
    const targets = Array.from(root.querySelectorAll('button:not([disabled]),a[href],[role="button"],[role="tab"]'));
    for (const el of targets) {
      const rect = el.getBoundingClientRect();
      const text = (el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim().slice(0, 30);
      if (rect.width < 28 || rect.height < 28) continue;
      if (rect.right < 0 || rect.bottom < 0 || rect.left > vw || rect.top > vh) continue;
      const x = Math.min(vw - 1, Math.max(1, rect.left + rect.width / 2));
      const y = Math.min(vh - 1, Math.max(1, rect.top + rect.height / 2));
      const top = document.elementFromPoint(x, y);
      if (!top) continue;
      if (el === top || el.contains(top) || top.contains(el)) continue;
      const pointerEvents = getComputedStyle(top).pointerEvents;
      if (pointerEvents === 'none') continue;
      covered.push({
        text,
        by: (top.textContent || top.getAttribute('aria-label') || top.className || top.tagName || '').toString().trim().slice(0, 60),
        x: Math.round(x),
        y: Math.round(y),
      });
    }

    return {
      url: location.href,
      textLength: bodyText.trim().length,
      overflow,
      squeezed: squeezed.slice(0, 10),
      covered: covered.slice(0, 10),
    };
  });

  assertOk(result.textLength > 60, `${label}: page did not render enough text`, result);
  assertOk(result.overflow <= 2, `${label}: horizontal overflow detected`, result);
  assertOk(result.squeezed.length === 0, `${label}: text squeezed into vertical layout`, result);
  assertOk(result.covered.length === 0, `${label}: clickable target is covered`, result);
  console.log(`PASS ${label} ${result.url}`);
}

async function runViewport(browser, project, viewport) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 2,
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();
  page.on('pageerror', (err) => {
    throw err;
  });

  const projectId = project.id;
  const pages = [
    ['project-list', `${baseUrl}/project-list`],
    ['branch-list', `${baseUrl}/branches/${encodeURIComponent(projectId)}`],
    ['project-settings', `${baseUrl}/settings/${encodeURIComponent(projectId)}#env`],
    ['cds-settings', `${baseUrl}/cds-settings#maintenance`],
    ['release-center', `${baseUrl}/release-center?project=${encodeURIComponent(projectId)}`],
  ];

  for (const [label, url] of pages) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(500);
    await checkLayout(page, `${viewport.label}:${label}`);
  }

  await page.goto(`${baseUrl}/branches/${encodeURIComponent(projectId)}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(800);
  const branchCard = page.locator('[aria-label^="打开 "][aria-label$=" 详情"]').first();
  await branchCard.click({ timeout: 10000 });
  await page.waitForTimeout(800);
  await checkLayout(page, `${viewport.label}:branch-detail-drawer`);

  const themeVisibleWhileDrawerOpen = await page.locator('.cds-theme-toggle').evaluate((el) => {
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.display !== 'none' && rect.width > 0 && rect.height > 0;
  }).catch(() => false);
  assertOk(!themeVisibleWhileDrawerOpen, `${viewport.label}:branch-detail-drawer: theme toggle must hide while drawer is open`);

  await context.close();
}

async function main() {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const probe = await browser.newPage();
  const project = await getFirstProject(probe);
  await probe.close();
  for (const viewport of viewports) {
    await runViewport(browser, project, viewport);
  }
  await browser.close();
}

main().catch(async (err) => {
  console.error(`FAIL ${err.message}`);
  process.exit(1);
});
