import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import { chromium } from 'playwright-core';

import {
  BROWSER_QUALITY_RULE_VERSION,
  BROWSER_QUALITY_VIEWPORTS,
  type BrowserQualityIssue,
  type BrowserQualityViewportName,
  type BrowserQualityWorkerJob,
  type BrowserQualityWorkerResult,
  type BrowserViewportMeasurement,
} from './browser-contract.js';
import { resolveBrowserExecutablePath, summarizeBrowserWorkerFailure } from './browser-runner.js';

const MIME: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function safePublicFile(workspaceDir: string, pathname: string): string | null {
  let decoded = '';
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  if (relative !== 'index.html' && !relative.startsWith('assets/')) return null;
  const absolute = path.resolve(workspaceDir, relative);
  const root = fs.realpathSync(workspaceDir);
  if (!absolute.startsWith(`${path.resolve(workspaceDir)}${path.sep}`)) return null;
  try {
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    const real = fs.realpathSync(absolute);
    if (!real.startsWith(`${root}${path.sep}`)) return null;
    return real;
  } catch {
    return null;
  }
}

async function startServer(workspaceDir: string): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const file = safePublicFile(workspaceDir, new URL(req.url || '/', 'http://localhost').pathname);
    if (!file) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server;
}

async function measurePage(
  page: import('playwright-core').Page,
  viewport: BrowserQualityViewportName,
  width: number,
  height: number,
  screenshotPath: string,
  slideIndex?: number,
): Promise<BrowserViewportMeasurement> {
  const raw = await page.evaluate(({ viewport, width, height, ruleVersion, slideIndex }) => {
    const visible = (element: Element): boolean => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0
        && rect.width > 1 && rect.height > 1;
    };
    const summary = (element: Element) => {
      const rawLabel = element.getAttribute('aria-label') || element.getAttribute('title') || '';
      return {
        tag: element.tagName.toLowerCase(),
        ...(element.id ? { id: element.id.slice(0, 80) } : {}),
        ...(element.getAttribute('role') ? { role: element.getAttribute('role')!.slice(0, 40) } : {}),
        ...(rawLabel ? { label: rawLabel.replace(/\s+/g, ' ').trim().slice(0, 120) } : {}),
      };
    };
    const issue = (
      issueCode: BrowserQualityIssue['issueCode'],
      actual: BrowserQualityIssue['actual'],
      target: string,
      element?: Element,
    ): BrowserQualityIssue => ({
      issueCode,
      severity: 'hard',
      ruleVersion: ruleVersion as 'browser-hard-gate-v1',
      viewport,
      actual,
      target,
      ...(element ? { element: summary(element) } : {}),
    });
    const issues: BrowserQualityIssue[] = [];
    const root = document.documentElement;
    const documentWidth = Math.max(root.scrollWidth, document.body?.scrollWidth || 0);
    if (documentWidth > width + 1) {
      const offender = [...document.querySelectorAll('body *')].find((element) => {
        if (!visible(element)) return false;
        const rect = element.getBoundingClientRect();
        return rect.left < -1 || rect.right > width + 1;
      });
      issues.push(issue('horizontal_overflow', { documentWidth, viewportWidth: width, ...(slideIndex ? { slideIndex } : {}) }, 'documentWidth <= viewportWidth + 1', offender));
    }
    const clipped = (element: Element): boolean => {
      const rect = element.getBoundingClientRect();
      if (rect.left < -1 || rect.right > width + 1 || rect.width <= 1 || rect.height <= 1) return true;
      let ancestor = element.parentElement;
      while (ancestor && ancestor !== document.body) {
        const style = getComputedStyle(ancestor);
        if (['hidden', 'clip'].includes(style.overflowX) || ['hidden', 'clip'].includes(style.overflowY)) {
          const boundary = ancestor.getBoundingClientRect();
          if (rect.left < boundary.left - 1 || rect.right > boundary.right + 1
              || rect.top < boundary.top - 1 || rect.bottom > boundary.bottom + 1) return true;
        }
        ancestor = ancestor.parentElement;
      }
      return false;
    };
    const main = document.querySelector('main, [role="main"]');
    if (!main || !visible(main) || clipped(main)) {
      issues.push(issue('main_content_clipped', {
        present: Boolean(main),
        visible: Boolean(main && visible(main)),
        viewportWidth: width,
      }, 'main content is visible and horizontally inside the viewport', main || undefined));
    }
    const ctaCandidates = [...document.querySelectorAll('a, button, [role="button"]')]
      .filter(visible)
      .filter((element) => {
        const style = getComputedStyle(element);
        const text = (element.textContent || '').trim();
        return text.length > 0 && (style.backgroundColor !== 'rgba(0, 0, 0, 0)' || /primary|cta|action/i.test(element.className));
      });
    const primaryCta = ctaCandidates[0];
    if (primaryCta && clipped(primaryCta)) {
      const rect = primaryCta.getBoundingClientRect();
      issues.push(issue('primary_cta_clipped', {
        left: Math.round(rect.left), right: Math.round(rect.right), viewportWidth: width,
      }, 'primary CTA is horizontally inside the viewport', primaryCta));
    }
    for (const anchor of document.querySelectorAll<HTMLAnchorElement>('a')) {
      const href = (anchor.getAttribute('href') || '').trim();
      if (!href || href === '#') {
        issues.push(issue('empty_link', { href: '' }, 'links have a non-empty href', anchor));
      } else if (href.startsWith('#') && href.length > 1) {
        const targetId = decodeURIComponent(href.slice(1));
        if (!document.getElementById(targetId)) {
          issues.push(issue('broken_fragment_target', { href }, 'fragment target exists', anchor));
        }
      }
    }
    if (viewport === 'mobile') {
      const navs = [...document.querySelectorAll('nav, [role="navigation"]')];
      for (const nav of navs) {
        const links = [...nav.querySelectorAll('a')];
        const visibleLinks = links.filter(visible);
        const toggle = [...document.querySelectorAll('button, [role="button"]')].find((candidate) => {
          if (!visible(candidate)) return false;
          const controls = candidate.getAttribute('aria-controls');
          return Boolean(controls && (nav.id === controls || nav.querySelector(`#${CSS.escape(controls)}`)));
        });
        if (links.length > 0 && visibleLinks.length === 0 && !toggle) {
          issues.push(issue('mobile_navigation_unusable', {
            linkCount: links.length, visibleLinkCount: 0, hasVisibleToggle: false,
          }, 'mobile navigation exposes visible links or a visible accessible toggle', nav));
        }
      }
    }
    for (const table of document.querySelectorAll('table')) {
      if (!visible(table)) continue;
      const rect = table.getBoundingClientRect();
      let ancestor: Element | null = table.parentElement;
      let scrollable = false;
      while (ancestor && ancestor !== document.body) {
        const overflow = getComputedStyle(ancestor).overflowX;
        if ((overflow === 'auto' || overflow === 'scroll') && ancestor.scrollWidth > ancestor.clientWidth) {
          scrollable = true;
          break;
        }
        ancestor = ancestor.parentElement;
      }
      const cellWidths = [...table.querySelectorAll('th, td')].filter(visible).map((cell) => cell.getBoundingClientRect().width);
      const minCellWidth = cellWidths.length ? Math.min(...cellWidths) : 0;
      if ((rect.width > width + 1 && !scrollable) || minCellWidth < 36) {
        issues.push(issue('table_unreadable', {
          tableWidth: Math.round(rect.width), viewportWidth: width, scrollable, minCellWidth: Math.round(minCellWidth),
        }, 'wide tables have a horizontal scroll container and visible cells are at least 36px wide', table));
      }
    }
    const parseColor = (value: string): [number, number, number, number] | null => {
      const match = /^rgba?\(\s*([\d.]+)[, ]+\s*([\d.]+)[, ]+\s*([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/i.exec(value);
      if (!match) return null;
      return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] === undefined ? 1 : Number(match[4])];
    };
    const background = (element: Element): [number, number, number] | null => {
      let node: Element | null = element;
      while (node) {
        const color = parseColor(getComputedStyle(node).backgroundColor);
        if (color && color[3] >= 0.98) return [color[0], color[1], color[2]];
        node = node.parentElement;
      }
      return [255, 255, 255];
    };
    const luminance = ([red, green, blue]: [number, number, number]) => {
      const channels = [red, green, blue].map((value) => {
        const normalized = value / 255;
        return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
    };
    const keyText = [...document.querySelectorAll('h1, h2, main p, a, button')].filter(visible).slice(0, 40);
    for (const element of keyText) {
      const foreground = parseColor(getComputedStyle(element).color);
      const bg = background(element);
      if (!foreground || foreground[3] < 0.98 || !bg) continue;
      const first = luminance([foreground[0], foreground[1], foreground[2]]);
      const second = luminance(bg);
      const ratio = (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
      const style = getComputedStyle(element);
      const fontSize = Number.parseFloat(style.fontSize);
      const fontWeight = Number.parseInt(style.fontWeight, 10) || 400;
      const large = fontSize >= 24 || (fontSize >= 18.66 && fontWeight >= 700);
      const minimum = large ? 3 : 4.5;
      if (ratio + 0.01 < minimum) {
        issues.push(issue('key_text_contrast_low', {
          ratio: Math.round(ratio * 100) / 100, minimum, fontSize: Math.round(fontSize * 10) / 10, fontWeight,
        }, `contrast ratio >= ${minimum}`, element));
      }
    }
    if (viewport === 'mobile' && slideIndex) {
      const presentationText = [...document.querySelectorAll('h1, h2, h3, p, li, a, button, th, td')]
        .filter(visible)
        .filter((element) => (element.textContent || '').trim().length > 0)
        .slice(0, 120);
      for (const element of presentationText) {
        const style = getComputedStyle(element);
        const fontSize = Number.parseFloat(style.fontSize);
        const htmlElement = element as HTMLElement;
        const scale = htmlElement.offsetHeight > 0
          ? Math.min(1, element.getBoundingClientRect().height / htmlElement.offsetHeight)
          : 1;
        const effectiveFontSize = Math.round(fontSize * scale * 10) / 10;
        if (effectiveFontSize < 12) {
          issues.push(issue('presentation_text_too_small', {
            slideIndex,
            effectiveFontSize,
            minimumFontSize: 12,
          }, 'computed mobile text size after transforms is at least 12px', element));
          break;
        }
      }
      const fixedOverlays = [...document.querySelectorAll('body *')].filter((element) => {
        if (!visible(element)) return false;
        const position = getComputedStyle(element).position;
        return position === 'fixed' || position === 'sticky';
      });
      outer: for (const overlay of fixedOverlays) {
        const overlayRect = overlay.getBoundingClientRect();
        for (const element of presentationText) {
          if (overlay.contains(element) || element.contains(overlay)) continue;
          const rect = element.getBoundingClientRect();
          const overlapWidth = Math.max(0, Math.min(rect.right, overlayRect.right) - Math.max(rect.left, overlayRect.left));
          const overlapHeight = Math.max(0, Math.min(rect.bottom, overlayRect.bottom) - Math.max(rect.top, overlayRect.top));
          const overlapRatio = rect.width * rect.height > 0
            ? (overlapWidth * overlapHeight) / (rect.width * rect.height)
            : 0;
          if (overlapRatio > 0.2) {
            issues.push(issue('presentation_fixed_overlay_obscures_content', {
              slideIndex,
              overlapRatio: Math.round(overlapRatio * 100) / 100,
            }, 'fixed presentation controls do not obscure readable slide content', overlay));
            break outer;
          }
        }
      }
    }
    return {
      viewport,
      width,
      height,
      ...(slideIndex ? { slideIndex } : {}),
      documentWidth,
      h1Count: [...document.querySelectorAll('h1')].filter(visible).length,
      visibleHeadingCount: [...document.querySelectorAll('h1, h2, h3')].filter(visible).length,
      visibleCtaCount: ctaCandidates.length,
      visibleLandmarkCount: [...document.querySelectorAll('header, nav, main, footer, [role="banner"], [role="navigation"], [role="main"], [role="contentinfo"]')].filter(visible).length,
      issues,
      screenshotPath: '',
    };
  }, { viewport, width, height, ruleVersion: BROWSER_QUALITY_RULE_VERSION, slideIndex });
  await page.screenshot({ path: screenshotPath, fullPage: false, type: 'png' });
  return { ...raw, screenshotPath } as BrowserViewportMeasurement;
}

export async function runBrowserWorker(job: BrowserQualityWorkerJob): Promise<BrowserQualityWorkerResult> {
  fs.mkdirSync(job.evidenceDir, { recursive: true, mode: 0o700 });
  const server = await startServer(job.workspaceDir);
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const browser = await chromium.launch({
    headless: true,
    executablePath: resolveBrowserExecutablePath(),
    args: ['--disable-dev-shm-usage', '--no-sandbox'],
  });
  try {
    const measurements: BrowserViewportMeasurement[] = [];
    const taskPath = path.join(job.workspaceDir, 'brief', 'task.json');
    const task = fs.existsSync(taskPath)
      ? JSON.parse(fs.readFileSync(taskPath, 'utf8')) as { presentationContract?: { targetPages?: number } }
      : {};
    const targetPages = Number.isSafeInteger(task.presentationContract?.targetPages)
      ? Number(task.presentationContract?.targetPages)
      : 0;
    for (const viewport of BROWSER_QUALITY_VIEWPORTS) {
      const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: 1 });
      await context.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        if (url.origin === origin) await route.continue();
        else await route.abort('blockedbyclient');
      });
      const page = await context.newPage();
      await page.goto(origin, { waitUntil: 'networkidle', timeout: 15_000 });
      const revealSlides = targetPages > 0 ? await page.locator('.reveal .slides > section').count() : 0;
      const pageCount = targetPages > 0
        ? (revealSlides > 0 ? revealSlides : await page.locator('[data-slide-index]').count())
        : 0;
      if (targetPages > 0 && pageCount !== targetPages) {
        const relativeScreenshot = `assets/quality/attempt-${job.repairAttempt}-${viewport.name}-page-count.png`;
        await page.screenshot({
          path: path.join(job.evidenceDir, path.basename(relativeScreenshot)),
          fullPage: false,
          type: 'png',
        });
        measurements.push({
          viewport: viewport.name,
          width: viewport.width,
          height: viewport.height,
          documentWidth: viewport.width,
          h1Count: 0,
          visibleHeadingCount: 0,
          visibleCtaCount: 0,
          visibleLandmarkCount: 0,
          issues: [{
            issueCode: 'presentation_page_count_mismatch',
            severity: 'hard',
            ruleVersion: BROWSER_QUALITY_RULE_VERSION,
            viewport: viewport.name,
            actual: { actualPages: pageCount, targetPages },
            target: 'actual slide count equals frozen targetPages',
          }],
          screenshotPath: relativeScreenshot,
        });
      }
      const iterations = targetPages > 0 ? Math.min(targetPages, pageCount) : 1;
      for (let index = 0; index < iterations; index += 1) {
        let canNavigate = true;
        if (targetPages > 0) {
          canNavigate = await page.evaluate((slide) => {
            const reveal = (globalThis as unknown as { Reveal?: { slide?: (index: number) => void; getIndices?: () => { h?: number } } }).Reveal;
            if (!reveal?.slide || !reveal.getIndices) return false;
            reveal.slide(slide);
            return reveal.getIndices().h === slide;
          }, index);
          await page.waitForTimeout(40);
        }
        const suffix = targetPages > 0 ? `-slide-${index + 1}` : '';
        const relativeScreenshot = `assets/quality/attempt-${job.repairAttempt}-${viewport.name}${suffix}.png`;
        const screenshotPath = path.join(job.evidenceDir, path.basename(relativeScreenshot));
        const measurement = await measurePage(
          page,
          viewport.name,
          viewport.width,
          viewport.height,
          screenshotPath,
          targetPages > 0 ? index + 1 : undefined,
        );
        if (targetPages > 0 && !canNavigate) {
          measurement.issues.push({
            issueCode: 'presentation_navigation_unusable',
            severity: 'hard',
            ruleVersion: BROWSER_QUALITY_RULE_VERSION,
            viewport: viewport.name,
            actual: { slideIndex: index + 1, canNavigate: false },
            target: 'every frozen slide is reachable through the presentation controller',
          });
        }
        measurements.push({ ...measurement, screenshotPath: relativeScreenshot });
      }
      await context.close();
    }
    return { browserVersion: browser.version(), measurements };
  } finally {
    await browser.close().catch(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

if (process.send && process.env.MAP_BROWSER_QUALITY_WORKER === '1') {
  process.once('message', (job: BrowserQualityWorkerJob) => {
    runBrowserWorker(job)
      .then((result) => process.send?.({ ok: true, result }))
      .catch((error) => process.send?.({ ok: false, error: summarizeBrowserWorkerFailure(error) }))
      .finally(() => setImmediate(() => process.exit(0)));
  });
}
