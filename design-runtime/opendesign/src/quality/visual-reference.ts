import type { Page } from 'playwright-core';
import type { BrowserQualityViewportName } from './browser-contract.js';

export interface VisualReferenceMetrics {
  viewport: BrowserQualityViewportName;
  scheme: 'light' | 'dark';
  background: string;
  foreground: string;
  titleFont: string;
  titleSize: number;
  titleTop: number;
  textSize: number;
  textLineHeight: number;
  textWidth: number;
}

export async function measureVisualReference(
  page: Page, viewport: BrowserQualityViewportName, scheme: VisualReferenceMetrics['scheme'],
): Promise<VisualReferenceMetrics | null> {
  const values = await page.evaluate(() => {
    const visible = (element: Element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility === 'visible';
    };
    const main = document.querySelector('main, [role="main"], article') ?? document.body;
    const title = [...main.querySelectorAll('h1, [role="heading"][aria-level="1"]')].find(visible)
      ?? [...document.querySelectorAll('h1')].find(visible);
    if (!title) return null;
    const titleStyle = getComputedStyle(title);
    // A subtitle or a statistic may also be marked up as a paragraph. Sample
    // the article's reading text so one secondary line cannot set the baseline.
    const paragraphs = [...main.querySelectorAll('p')].filter((element) =>
      visible(element) && (element.textContent ?? '').trim().length >= 24
      && !element.closest('nav, aside, footer, figure, [role="doc-subtitle"]')
      && (title.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0).slice(0, 9);
    const readingText = (paragraphs.length ? paragraphs : [main]).map((element) => {
      const style = getComputedStyle(element);
      const size = Number.parseFloat(style.fontSize);
      return {
        size,
        lineHeight: Number.parseFloat(style.lineHeight) || size * 1.2,
        width: element.getBoundingClientRect().width,
      };
    });
    const median = (key: keyof typeof readingText[number]) => {
      const values = readingText.map((item) => item[key]).sort((a, b) => a - b);
      const middle = Math.floor(values.length / 2);
      return Math.round((values[middle] + values[Math.floor((values.length - 1) / 2)]) / 2);
    };
    const backgrounds = [document.body, document.documentElement].map((element) => getComputedStyle(element).backgroundColor);
    const normalizeFont = (font: string) => font.toLowerCase().split(',')
      .map((part) => part.trim().replace(/["']/g, '')).reverse()
      .find((part) => ['serif', 'ui-serif', 'sans-serif', 'ui-sans-serif', 'system-ui', 'monospace', 'ui-monospace'].includes(part)) ?? '';
    return {
      background: backgrounds.find((value) => value.startsWith('rgb(')) ?? 'rgb(255, 255, 255)',
      foreground: titleStyle.color,
      titleFont: normalizeFont(titleStyle.fontFamily),
      titleSize: Math.round(Number.parseFloat(titleStyle.fontSize)),
      titleTop: Math.round(title.getBoundingClientRect().top),
      textSize: median('size'),
      textLineHeight: median('lineHeight'),
      textWidth: median('width'),
    };
  });
  return values ? { viewport, scheme, ...values } : null;
}

export function visualReferenceBrief(reference: readonly VisualReferenceMetrics[]): string {
  if (!reference.length) return '';
  const facts = reference.map((item) => [
    item.viewport, item.scheme, `body background ${item.background}`, `heading color ${item.foreground}`,
    `heading ${item.titleSize}px ${item.titleFont || 'in the reference type family'}`, `heading top ${item.titleTop}px`,
    `body column ${item.textWidth}px`, `paragraph ${item.textSize}px with ${item.textLineHeight}px line height`,
  ].join(', '));
  return [
    'Measured style reference from the actual rendered webpage. These measurements govern typography, spacing, reading width and palette; use the selected design system only for compatible details.',
    ...facts,
    'Match the two viewport scales and the measured light/dark appearance, using prefers-color-scheme where they differ. Prioritize the measured headline scale and document density over generic hero or marketing templates.',
    'Reuse the visual language only. Use this task’s source files for all text, facts, identity and links.',
  ].join('\n');
}

export function compareVisualReference(expected: VisualReferenceMetrics, actual: VisualReferenceMetrics | null): string[] {
  if (!actual) return ['visible main heading was missing'];
  const differences: string[] = [];
  const check = (label: string, target: number, measured: number, tolerance: number) => {
    if (Math.abs(target - measured) > tolerance) differences.push(`${label} ${measured}px; reference ${target}px`);
  };
  check('heading size', expected.titleSize, actual.titleSize, Math.max(6, expected.titleSize * 0.18));
  if (expected.titleTop >= 0 && expected.titleTop < 400)
    check('heading top', expected.titleTop, actual.titleTop, Math.max(48, expected.titleTop * 0.25));
  check('reading column width', expected.textWidth, actual.textWidth, Math.max(40, expected.textWidth * 0.18));
  check('paragraph size', expected.textSize, actual.textSize, Math.max(3, expected.textSize * 0.18));
  check('paragraph line height', expected.textLineHeight, actual.textLineHeight, Math.max(6, expected.textLineHeight * 0.22));
  const family = (font: string) => font === 'system-ui' ? 'sans-serif' : font.replace(/^ui-/, '');
  if (expected.titleFont && family(expected.titleFont) !== family(actual.titleFont))
    differences.push(`heading family ${actual.titleFont || 'unspecified'}; reference ${expected.titleFont}`);
  const channelDistance = (a: string, b: string) => {
    const values = (color: string) => (color.match(/\d+/g) ?? []).slice(0, 3).map(Number);
    const left = values(a), right = values(b);
    return left.length === 3 && right.length === 3
      ? Math.hypot(...left.map((channel, i) => channel - right[i])) : 0;
  };
  if (channelDistance(expected.background, actual.background) > 55)
    differences.push(`background ${actual.background}; reference ${expected.background}`);
  if (channelDistance(expected.foreground, actual.foreground) > 80)
    differences.push(`heading color ${actual.foreground}; reference ${expected.foreground}`);
  return differences;
}
