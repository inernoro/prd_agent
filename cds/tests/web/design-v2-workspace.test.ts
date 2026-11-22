import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { chromium, type BrowserContextOptions, type Locator, type Page } from 'playwright';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DesignComment, DesignEntry, DesignFeedback, DesignScreen, DesignVersion, DesignWorkspace } from '../../src/shared/design-workspace';
import type { PlanningBoard } from '../../src/shared/engineering-planning';
import { DesignWorkspacePage } from '../../web/src/pages/DesignWorkspacePage';
import { EngineeringPlanningPage } from '../../web/src/pages/EngineeringPlanningPage';
import { usePlanningRead } from '../../web/src/pages/engineering-planning/planning-ui';

const fromWeb = createRequire(path.resolve('web/package.json'));
const { MemoryRouter } = fromWeb('react-router-dom');

vi.mock('../../web/src/pages/engineering-planning/planning-ui', async importOriginal => ({
  ...await importOriginal<typeof import('../../web/src/pages/engineering-planning/planning-ui')>(),
  usePlanningRead: vi.fn(),
}));

afterEach(() => vi.unstubAllGlobals());

const projectId = 'fixture-design-v2';
const frameworkId = 'FW-fixture';
const at = '2026-11-20T00:00:00.000Z';
const author = { id: 'fixture-member', label: '示例评审人' };
const frameworkTitle = '示例共享框架';
const boundTitle = '评审工作台改进';
const latestBoundTitle = '分支列表改进';
const unboundTitle = '尚未绑定示例稿';
const deliveryPath = 'docs/review-workspace.md';
const tag = '评审示例标签';
const first: DesignVersion = {
  version: 1, title: boundTitle, sourceCommit: 'a'.repeat(40), sha256: '1'.repeat(64),
  prototypeId: 'artifact-prototype', createdAt: at, publisher: author, rationale: '',
  screens: [], acceptance: [], spec: {}, tags: [tag], decisionIds: [], resolves: {},
  framework: frameworkId, frameworkVersion: 1,
};
const second: DesignVersion = {
  ...first, version: 2, sourceCommit: 'b'.repeat(40), sha256: '2'.repeat(64),
  delivery: {
    archiveId: 'artifact-archive', archiveRoot: '', warnings: [],
    files: [{ id: 'artifact-doc', path: deliveryPath, kind: 'guide', size: 2048, sha256: '3'.repeat(64), text: true }],
  },
};
const bound: DesignEntry = { id: 'DSN-fixture-bound', projectId, versions: [first, second], frozen: 1, comments: [], runs: [] };
const latestBound: DesignEntry = {
  id: 'DSN-fixture-current', projectId, frozen: 1, comments: [], runs: [],
  versions: [{ ...first, title: latestBoundTitle, frameworkVersion: 2 }],
};
const unbound: DesignEntry = {
  id: 'DSN-fixture-unbound', projectId, comments: [], runs: [],
  versions: [{ ...first, title: unboundTitle, framework: undefined, frameworkVersion: undefined }],
};
const workspace: DesignWorkspace = {
  projectId, designs: [bound, latestBound, unbound],
  frameworks: [{ id: frameworkId, projectId, versions: [1, 2].map(version => ({
    version, title: frameworkTitle, sourceCommit: 'c'.repeat(40), at, by: author.id,
    note: '维护共享控件的一致性。', material: { tokens: { colors: { primary: '#d05710' } } },
  })) }],
  permissions: { write: true, feedback: true, review: true, sign: true, steward: true, actorId: author.id },
};
const board: PlanningBoard = {
  projectId, protocolVersion: 1, permissions: ['read', 'write'], today: '2026-11-20', pendingReviewCount: 0,
  proposals: [], decisions: [], events: [],
  plans: Array.from({ length: 12 }, (_, index): PlanningBoard['plans'][number] => ({
    id: `PLN-fixture-${index}`, projectId, version: 1, createdAt: at, updatedAt: at,
    title: index === 0 ? '用于窄屏回归的推进计划' : `控制台布局检视 ${index} · ${'PlanningLayoutReference'.repeat(3)}`,
    source: { type: 'manual', ref: 'fixture-plan' }, steps: [{ id: 'step-1', kind: 'task', title: '核对页面尺寸', status: 'doing' }],
  })),
};

function historyScreen(id: string, name: string): DesignScreen {
  return { id, name, route: `#/${id}`, viewport: 'desktop', themes: ['light', 'dark'], impl: null };
}
const previousScreen = historyScreen('previous-settings', '旧版设置第二张画面');
const currentScreen = historyScreen('current-settings', '最新版设置画面');
const previousComment: DesignComment = {
  id: 'CMT-fixture-previous', version: 1, screenId: previousScreen.id, body: '旧版评论仍需跟进',
  x: 0.3, y: 0.4, author, createdAt: at, closed: false,
  replies: [{ author, at, body: '保留了旧版评论的回复' }], reviews: [],
};
const currentComment: DesignComment = {
  ...previousComment, id: 'CMT-fixture-current', version: 2, screenId: currentScreen.id, body: '最新版画面的评论', replies: [],
};
const previousFeedback: DesignFeedback = {
  id: 'FDB-fixture-previous', version: 1, screenId: previousScreen.id, category: 'implementation', title: '旧版实施反馈',
  body: '旧版反馈仍需跟进', evidence: ['docs/fixture-previous.md'], author, createdAt: at, status: 'responded',
  replies: [{ author, at, body: '关联已发布的新修订', revision: 2 }], decisions: [],
};
const currentFeedback: DesignFeedback = {
  ...previousFeedback, id: 'FDB-fixture-current', version: 2, screenId: currentScreen.id, title: '最新版实施反馈',
  body: '记录最新版实现情况', status: 'open', evidence: [], replies: [],
};
const historyDraft: DesignEntry = {
  ...bound, id: 'DSN-fixture-comment-history',
  versions: [{ ...first, prototypeId: 'fixture-prototype-v1', screens: [historyScreen('previous-overview', '旧版首张画面'), previousScreen] },
    { ...second, prototypeId: 'fixture-prototype-v2', screens: [currentScreen] }],
  comments: [previousComment, currentComment], feedback: [previousFeedback, currentFeedback],
};
const historyWorkspace: DesignWorkspace = { ...workspace, designs: [historyDraft] };

function render(Page: ComponentType, url: string, input = workspace): string {
  vi.stubGlobal('document', { documentElement: { dataset: { theme: 'light' } } });
  vi.mocked(usePlanningRead).mockImplementation(endpoint => {
    if (endpoint === '/api/projects') return { loading: false, data: { projects: [{ id: projectId, name: '虚拟工程项目' }] } };
    if (endpoint === `/api/projects/${projectId}/design`) return { loading: false, data: input };
    if (endpoint === `/api/projects/${projectId}/planning`) return { loading: false, data: board };
    return { loading: false };
  });
  const report = console.error;
  const serverWarning = vi.spyOn(console, 'error').mockImplementation((message: unknown, ...args: unknown[]) => {
    if (typeof message !== 'string' || !message.startsWith('Warning: useLayoutEffect does nothing on the server')) report(message, ...args);
  });
  try {
    return renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: [url] }, createElement(Page)));
  } finally {
    serverWarning.mockRestore();
  }
}

function design(query = '', input = workspace): string {
  return render(DesignWorkspacePage, `/design?project=${projectId}${query}`, input);
}

function text(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function visibleText(html: string): string {
  return text(html.replace(/<details\b(?![^>]*\bopen\b)[^>]*>([\s\S]*?)<\/details>/g, (_, contents: string) =>
    contents.match(/<summary\b[^>]*>([\s\S]*?)<\/summary>/)?.[1] ?? ' '));
}

async function withLayout(markup: string, cssFiles: string[], check: (page: Page) => Promise<void>, options?: BrowserContextOptions) {
  const styles = await Promise.all(['web/src/index.css', ...cssFiles].map(file => readFile(file, 'utf8')));
  const postcss = fromWeb('postcss');
  const tailwind = fromWeb('tailwindcss');
  const loadConfig = fromWeb('tailwindcss/loadConfig');
  const { css } = await postcss([tailwind({
    ...loadConfig(path.resolve('web/tailwind.config.js')),
    content: [{ raw: markup, extension: 'html' }],
  }), fromWeb('autoprefixer')]).process(styles.join('\n'), { from: path.resolve('web/src/index.css') });
  const browser = await chromium.launch({ headless: true,
    ...(process.env.CDS_CHROMIUM_PATH ? { executablePath: process.env.CDS_CHROMIUM_PATH } : { channel: 'chrome' }),
  });
  try {
    const page = await browser.newPage({ ...options, serviceWorkers: 'block' });
    await page.route('**/*', routed => routed.abort());
    // Compile the AppShell utilities so the fixture measures the same workspace width as the application.
    await page.setContent(`<!doctype html><html data-theme="light"><head><meta name="viewport" content="width=device-width, initial-scale=1">
      <style>${css}</style></head><body><div id="root">${markup}</div></body></html>`);
    await check(page);
  } finally {
    await browser.close();
  }
}

const draftStyles = ['web/src/pages/engineering-planning/planning.css', 'web/src/pages/design-workspace/design.css'];
const desktopSizes = [[1280, 800], [1024, 640], [853, 533]] as const;
const infoSizes = [...desktopSizes, [375, 812]] as const;
const longTitle = '帮助中心搜索：按产品线、文档类型和更新时间筛选结果';
const layoutDraft: DesignEntry = {
  ...bound,
  frozen: 2,
  versions: [first, second, { ...second, version: 3 }, { ...second, version: 4 }].map(version => ({
    ...version, spec: { tokens: { colors: { primary: '#d05710' } } },
  })),
  comments: ['按版号回看', '核对标题'].map((body, index) => ({
    id: `C-layout-${index}`, version: 4, screenId: 'overview', body, x: 0.3, y: 0.2, createdAt: at, author,
    closed: false, replies: [], reviews: [],
  })),
  feedback: [{
    id: 'FD-layout', version: 4, category: 'acceptance', title: '核对页头', body: '示例反馈', status: 'open',
    evidence: [], author, createdAt: at, replies: [], decisions: [],
  }],
  runs: [{
    id: 'RUN-layout', version: 2, pullRequest: 41, commit: 'd'.repeat(40), createdAt: at, verdict: 'failed',
    previewUrl: 'https://preview.fixture.invalid', issues: {},
    cells: [{ itemId: 'A-03', slot: 'desktop-light', status: 'failed', actual: '待检查页头' }],
  }],
};

const libraryFolder = '项目设置';
const otherFolder = '评审与交付';
const auxiliaryFramework = 'FW-library-other';
function libraryDraft(id: string, title: string, group: string, day: number, change: Partial<DesignVersion> = {}, review = true): DesignEntry {
  return {
    ...unbound, id: `DSN-fixture-library-${id}`, reviewRequested: review,
    ...(review ? {} : { pullRequest: 41 }),
    versions: [{ ...first, title, group, createdAt: '2026-10-01T00:00:00.000Z', ...change }, {
      ...first, version: 2, title, group, createdAt: `2026-11-${day}T00:00:00.000Z`, ...change,
    }],
  };
}
const libraryWorkspace: DesignWorkspace = {
  ...workspace,
  designs: [
    libraryDraft('target', '目标稿件', libraryFolder, 19),
    libraryDraft('framework', '另一套框架稿件', libraryFolder, 18, { framework: auxiliaryFramework }),
    libraryDraft('group', '另一文件夹稿件', otherFolder, 23),
    libraryDraft('status', '实现阶段稿件', libraryFolder, 20, {}, false),
    libraryDraft('tag', '其他分类稿件', libraryFolder, 21, { tags: ['另一个示例标签'] }),
    libraryDraft('old', '较早未绑定稿件', '归档资料', 17, { framework: undefined, frameworkVersion: undefined }),
  ],
  frameworks: [...workspace.frameworks, { ...workspace.frameworks[0], id: auxiliaryFramework }],
};

async function measureDraftHeader(page: Page, title: string, primaryAction?: string) {
  const header = page.locator('.dw-head--draft');
  const heading = header.getByRole('heading', { name: title, exact: true });
  const tabs = header.getByRole('navigation', { name: '稿件标签' });
  const controls = {
    back: header.getByRole('button', { name: '返回设计库', exact: true }),
    heading,
    status: header.locator('.dw-status'),
    framework: header.getByRole('link', { name: new RegExp(frameworkId) }),
    version: header.getByRole('combobox', { name: '稿件版本' }),
    screen: header.getByRole('button', { name: '大屏', exact: true }),
    information: header.getByLabel('稿件信息', { exact: true }),
  };
  async function box(name: string, locator: typeof heading) {
    const rect = await locator.boundingBox({ timeout: 900 });
    if (!rect) throw new Error(`稿件页头缺少可见控件 ${name}，宽度 ${page.viewportSize()?.width}`);
    return rect;
  }
  const [back, head, status, framework, version, screen, information] = await Promise.all(
    Object.entries(controls).map(([name, locator]) => box(name, locator)),
  );
  const titleGroup = [back, head, status, framework];
  const actionGroup = [version, screen, information];
  if (primaryAction) actionGroup.push(await box(primaryAction, header.getByRole('button', { name: primaryAction, exact: true })));
  const headerBox = await box('页头', header);
  const tabsBox = await box('页签', tabs);
  const metrics = await header.evaluate(element => {
    const titleElement = element.querySelector('h1')!;
    const statusElement = element.querySelector('.dw-status')!;
    const tabsElement = element.querySelector<HTMLElement>('nav[aria-label="稿件标签"]')!;
    const titleStyle = getComputedStyle(titleElement);
    const textLines = (node: Element) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      return new Set([...range.getClientRects()].filter(rect => rect.width > 0).map(rect => rect.top)).size;
    };
    const nestedOverflow = [element, ...element.querySelectorAll<HTMLElement>('*')].flatMap(child => {
      if (!(child instanceof HTMLElement) || child === titleElement || titleElement.contains(child)
        || tabsElement.contains(child) || child.clientWidth <= 0 || child.scrollWidth <= child.clientWidth + 1) return [];
      const closed = child.closest('details:not([open])');
      if (closed && closed !== child && !closed.querySelector(':scope > summary')?.contains(child)) return [];
      return [child.getAttribute('aria-label') || child.className || child.tagName];
    });
    return {
      width: innerWidth, height: innerHeight, touchPoints: navigator.maxTouchPoints, documentWidth: document.documentElement.scrollWidth,
      nestedOverflow, titleMeasured: titleElement.scrollWidth, titleAvailable: titleElement.clientWidth,
      titleTooltip: titleElement.getAttribute('title'), titleEllipsis: titleStyle.textOverflow,
      titleLines: textLines(titleElement), statusLines: textLines(statusElement),
      tabOverflow: tabsElement.scrollWidth - tabsElement.clientWidth, tabOverflowMode: getComputedStyle(tabsElement).overflowX,
    };
  });
  return { ...metrics, headerBox, tabsBox, titleGroup, actionGroup, information };
}

function shareRow(boxes: Awaited<ReturnType<typeof measureDraftHeader>>['titleGroup']) {
  return Math.max(...boxes.map(box => box.y)) < Math.min(...boxes.map(box => box.y + box.height));
}

function checkDraftBounds(metrics: Awaited<ReturnType<typeof measureDraftHeader>>, viewportWidth: number) {
  expect.soft(metrics.width, '设备 CSS 视口宽度').toBe(viewportWidth);
  expect.soft(metrics.documentWidth, `${viewportWidth}px 整页横向溢出`).toBeLessThanOrEqual(viewportWidth + 1);
  expect.soft(metrics.headerBox.y + metrics.headerBox.height, `${viewportWidth}px 页头出现在首屏`).toBeLessThanOrEqual(metrics.height);
  expect.soft(metrics.nestedOverflow, `${viewportWidth}px 页头局部横向溢出`).toEqual([]);
  expect.soft(metrics.titleLines, `${viewportWidth}px 标题文字行数`).toBe(1);
  expect.soft(metrics.statusLines, `${viewportWidth}px 状态文字行数`).toBe(1);
  const left = Math.max(0, metrics.headerBox.x);
  const right = Math.min(metrics.width, metrics.headerBox.x + metrics.headerBox.width);
  for (const [index, box] of [...metrics.titleGroup, ...metrics.actionGroup, metrics.tabsBox].entries()) {
    expect.soft(box.x, `${viewportWidth}px 控件 ${index + 1} 的左边缘`).toBeGreaterThanOrEqual(left - 1);
    expect.soft(box.x + box.width, `${viewportWidth}px 控件 ${index + 1} 的右边缘`).toBeLessThanOrEqual(right + 1);
  }
}

async function measureDraftInfo(popover: Locator) {
  return popover.evaluate(panel => {
    panel.scrollLeft = 0;
    const panelLeft = panel.getBoundingClientRect().left + panel.clientLeft;
    const panelRight = panelLeft + panel.clientWidth;
    const outside = (rect: DOMRect, left = panelLeft, right = panelRight) =>
      rect.width > 0 && (rect.left < left - 1 || rect.right > right + 1);
    function textRects(element: Element, omitted?: Element) {
      const boxes: DOMRect[] = [];
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent?.trim() || omitted?.contains(node)) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        boxes.push(...Array.from(range.getClientRects()).filter(rect => rect.width > 0 && rect.height > 0));
      }
      return boxes;
    }
    const clippedGroups = [...panel.querySelectorAll('dl > dt, dl > dd')].flatMap(group => {
      const boxes = [group, ...group.querySelectorAll('*')].flatMap(element => Array.from(element.getClientRects()));
      if (![...boxes, ...textRects(group)].some(rect => outside(rect))) return [];
      return [group.tagName === 'DT' ? group.textContent?.trim() : group.previousElementSibling?.textContent?.trim()];
    });
    function measureLabel(button: HTMLButtonElement) {
      const rect = button.getBoundingClientRect();
      const label = textRects(button);
      const left = Math.max(panelLeft, rect.left + button.clientLeft);
      const right = Math.min(panelRight, rect.left + button.clientLeft + button.clientWidth);
      return {
        width: rect.width,
        lines: new Set(label.map(box => box.top)).size,
        visible: !outside(rect) && label.length > 0 && label.every(box => !outside(box, left, right)),
        centerOffset: Math.abs((Math.min(...label.map(box => box.left)) + Math.max(...label.map(box => box.right))) / 2 - (rect.left + rect.right) / 2),
      };
    }
    const freeze = [...panel.querySelectorAll<HTMLButtonElement>('dd button')].find(button => button.textContent?.trim() === '定为实施基线');
    const revoke = panel.querySelector<HTMLButtonElement>('footer button[data-action="unfreeze"]');
    return {
      width: panel.clientWidth, scrollWidth: panel.scrollWidth, clippedGroups,
      freeze: freeze && {
        ...measureLabel(freeze),
        lineGap: freeze.getBoundingClientRect().top - Math.max(...textRects(freeze.closest('dd')!, freeze).map(box => box.bottom)),
      },
      revoke: revoke && { ...measureLabel(revoke), footerWidth: revoke.closest('footer')!.getBoundingClientRect().width },
    };
  });
}

function checkDraftInfoBounds(metrics: Awaited<ReturnType<typeof measureDraftInfo>>, width: number) {
  expect.soft(metrics.scrollWidth, `${width}px 稿件信息弹层内部横向溢出`).toBeLessThanOrEqual(metrics.width + 1);
  expect.soft(metrics.clippedGroups, `${width}px 稿件信息各组的内容均在弹层内`).toEqual([]);
}

describe('工程规划与设计 V2 前端回归', () => {
  it('panel=cli 从设计库链接直接展开 CLI 说明，普通地址保持折叠', () => {
    function cliDrawer(html: string): string {
      return html.match(/<details\b[^>]*>\s*<summary\b[^>]*data-action="design-cli"[^>]*>[\s\S]*?<\/details>/)?.[0] ?? '';
    }
    const ordinary = cliDrawer(design());
    const shared = cliDrawer(design('&panel=cli'));
    expect(ordinary).toContain('cdscli design list');
    expect(ordinary).not.toMatch(/^<details\b[^>]*\sopen(?:=|[\s>])/);
    expect(shared).toContain('cdscli design list');
    expect(shared).toMatch(/^<details\b[^>]*\sopen(?:=|[\s>])/);
  });

  it('A-19 设计库将项目框架和每份稿件的绑定、落后状态一起展示', () => {
    const html = design();
    expect(text(html)).toContain('本项目框架');
    expect(text(html)).toContain(frameworkTitle);
    expect(text(html)).toContain(frameworkId);
    const cards = Array.from(html.matchAll(/<article\b[^>]*class="[^"]*\bdw-design-card\b[^"]*"[^>]*>([\s\S]*?)<\/article>/g), match => text(match[1]));
    const boundCard = cards.find(card => card.includes(boundTitle));
    expect(boundCard).toContain(frameworkId);
    expect(boundCard).toMatch(/(?:V|v)1\b/);
    expect(boundCard).toMatch(/可升级|落后|有新版本/);
    expect(cards.find(card => card.includes(unboundTitle))).toContain('未绑定框架');
  });

  it('A-29 V3 设计库按最近更新、文件夹和框架排列，375px 不横向溢出', async () => {
    await withLayout(design('', libraryWorkspace), draftStyles, async page => {
      const recentTitle = page.getByRole('heading', { name: '最近更新', exact: true });
      const folderTitle = page.getByRole('heading', { name: /^文件夹/ });
      const recent = recentTitle.locator('xpath=ancestor::section[1]');
      const folders = folderTitle.locator('xpath=ancestor::section[1]');
      const frameworks = page.getByRole('region', { name: '本项目框架' });
      expect.soft(await page.locator('.dw-side').count(), '库不再占用左侧范围栏').toBe(0);
      expect.soft(await recent.locator('.dw-card-title').allTextContents(), '最近更新按最新一版时间排序且只列四份').toEqual([
        '另一文件夹稿件', '其他分类稿件', '实现阶段稿件', '目标稿件',
      ]);
      const folderLabels = await folders.getByRole('button').allTextContents();
      expect.soft(folderLabels).toHaveLength(3);
      for (const group of [libraryFolder, otherFolder, '归档资料']) {
        expect.soft(folderLabels.filter(label => label.includes(group)), `${group} 文件夹卡片`).toHaveLength(1);
      }
      const rects = await Promise.all([recent, folders, frameworks].map(area => area.boundingBox({ timeout: 900 }).catch(() => null)));
      expect.soft(rects.every(Boolean), '最近更新、文件夹和框架都是可见分区').toBe(true);
      if (rects.every(box => box !== null)) {
        expect.soft(rects[0].y).toBeLessThan(rects[1].y);
        expect.soft(rects[1].y).toBeLessThan(rects[2].y);
      }

      const overflow = await page.evaluate(() => ({
        viewport: innerWidth,
        root: document.documentElement.scrollWidth,
        layout: [...document.querySelectorAll<HTMLElement>('.dw-library, .dw-library-bar')]
          .filter(element => element.scrollWidth > element.clientWidth + 1).map(element => element.className),
        cardFacts: [...document.querySelectorAll<HTMLElement>('.dw-design-card footer > div > *')].flatMap(element => {
          const footer = element.closest('footer')!.getBoundingClientRect();
          const box = element.getBoundingClientRect();
          return box.left < footer.left - 1 || box.right > footer.right + 1 ? [element.textContent?.trim()] : [];
        }),
      }));
      expect(overflow.viewport).toBe(375);
      expect(overflow.root).toBeLessThanOrEqual(376);
      expect(overflow.layout, '设计库及筛选栏不能藏有横向溢出').toEqual([]);
      expect(overflow.cardFacts, '稿件卡片底部信息没有被裁切').toEqual([]);
    }, { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
  }, 15_000);

  it('A-30 V3 从稳定地址恢复状态、文件夹、标签和框架的交集，并按范围分节', () => {
    function titles(html: string) {
      return Array.from(html.matchAll(/<(?:a|button)\b[^>]*class="[^"]*\bdw-card-title\b[^"]*"[^>]*>([\s\S]*?)<\/(?:a|button)>/g),
        ([, value]) => text(value));
    }
    const filters = { status: 'review', tag, framework: frameworkId };
    const selected = design(`&${new URLSearchParams({ ...filters, group: libraryFolder })}`, libraryWorkspace);
    const across = design(`&${new URLSearchParams(filters)}`, libraryWorkspace);
    expect.soft(titles(selected), '四个条件必须同时生效').toEqual(['目标稿件']);
    expect.soft(titles(across).sort(), '跨文件夹仍保留状态、标签与框架筛选').toEqual(['另一文件夹稿件', '目标稿件']);
    expect.soft(selected).not.toContain('aria-label="框架标签"');
    expect.soft(selected).not.toContain('class="dw-side"');
    expect.soft(selected).toMatch(/aria-label="清除[^"]*(评审中|待评审)/);
    expect.soft(selected).toMatch(new RegExp(`aria-label="清除[^\"]*${tag}`));

    const headings = (html: string) => Array.from(html.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>/g), ([, value]) => text(value));
    for (const folder of [libraryFolder, otherFolder]) {
      expect.soft(headings(across).some(heading => heading.startsWith(folder)), `${folder} 是跨文件夹结果小节`).toBe(true);
    }
    const folderOnly = design(`&${new URLSearchParams({ group: libraryFolder })}`, libraryWorkspace);
    expect.soft(titles(folderOnly).sort()).toEqual(['其他分类稿件', '另一套框架稿件', '实现阶段稿件', '目标稿件']);
    expect.soft(headings(folderOnly).some(heading => heading.startsWith('待评审'))).toBe(true);
    expect.soft(headings(folderOnly).some(heading => heading.startsWith('实现中'))).toBe(true);
  });

  it('A-20 框架默认进入初衷与范围', () => {
    const html = design(`&framework=${frameworkId}&version=2`);
    const header = html.match(/<nav\b[^>]*aria-label="框架标签"[^>]*>([\s\S]*?)<\/nav>/)?.[1];
    expect(text(header ?? '')).toMatch(/^初衷与范围(?:\s|$)/);
    expect(visibleText(html)).toContain('适用范围');
  });

  it('A-21 框架采用页列出绑定稿、版本状态和同项目未绑定的稿件', () => {
    const html = visibleText(design(`&framework=${frameworkId}&version=2&tab=adoption`));
    expect(html).toContain('采用情况');
    expect(html).toContain(boundTitle);
    expect(html).toContain(latestBoundTitle);
    expect(html).toMatch(/可升级|有新版本/);
    expect(html).toContain('实施基线');
    expect(html).toContain(unboundTitle);
  });

  it('示意稿不增加框架套数，仍能从框架详情进入指定的示意版本', () => {
    const example: DesignEntry = {
      ...bound, id: 'DSN-fixture-framework-example',
      versions: [{ ...first, title: '框架使用示意', group: '框架资料' }, { ...second, title: '更新后的框架使用示意', group: '框架资料' }],
    };
    const framework = workspace.frameworks[0];
    const revision = framework.versions.at(-1)!;
    const input: DesignWorkspace = {
      ...workspace, designs: [example, ...workspace.designs],
      frameworks: [{ ...framework, versions: [framework.versions[0], {
        ...revision, charter: {
          status: 'adopted', intent: '约定控制台常用控件', problems: ['控件排列不一致'], nonGoals: ['业务流程'],
          scope: { system: '合成系统', modules: ['设置'] }, owner: author.label, example: { designId: example.id, version: 1 },
        },
      }] }],
    };
    const home = design('', input);
    const section = home.match(/<section\b[^>]*aria-label="本项目框架"[^>]*>([\s\S]*?)<\/section>/)?.[1] ?? '';
    expect([...section.matchAll(/\bdw-fw-tile\b/g)]).toHaveLength(1);
    expect(text(section)).toContain(frameworkTitle);
    expect(visibleText(home)).not.toContain('更新后的框架使用示意');
    const detail = design(`&framework=${frameworkId}&version=${revision.version}`, input);
    const link = detail.match(new RegExp(`<a[^>]*href="([^\"]+)"[^>]*>示意稿 ${example.id}[^<]*`));
    expect(link).not.toBeNull();
    const destination = new URL(link![1].replaceAll('&amp;', '&'), 'https://cds.fixture.invalid');
    expect(destination.pathname).toBe('/design');
    expect(Object.fromEntries(destination.searchParams.entries())).toEqual({ project: projectId, design: example.id, version: '1' });
    const opened = design('&' + new URLSearchParams({ design: example.id, version: '1' }), input);
    expect(opened).toMatch(/<h1[^>]*>框架使用示意<\/h1>/);
  });

  it('A-03/A-05 稿件页头公开当前版、实施基线、框架、页签及基线操作', () => {
    const html = design(`&design=${bound.id}&version=2&tab=preview`);
    const visible = visibleText(html);
    expect(visible).toMatch(/你在看\s*V2.*实施基线是\s*V1/);
    expect(visible).toContain(frameworkId);
    expect(html).toContain('aria-label="稿件标签"');
    expect(html).toContain('aria-label="稿件分类"');
    expect(html).toContain(`#${tag}`);
    expect(visible).toContain('打开基线');
    expect(visible).toContain('和基线对比');
  });

  it('A-12 有权限时在当前文件区域展示反馈入口', () => {
    const route = `&design=${bound.id}&version=2&tab=delivery`;
    const html = design(route);
    const fileHeader = html.match(/<header\b[^>]*class="dw-delivery-heading"[^>]*>((?:(?!<\/header>)[\s\S])*?<h3>[^<]*<\/h3>[\s\S]*?)<\/header>/)?.[1];
    expect(text(fileHeader ?? '')).toContain(deliveryPath);
    expect(text(fileHeader ?? '')).toContain('对这个文件提反馈');
    const readOnly = { ...workspace, permissions: { ...workspace.permissions, feedback: false, write: false } };
    expect(visibleText(design(route, readOnly))).not.toContain('对这个文件提反馈');
  });

  it('默认打开最新版，历史评论链接回原版的原画面，两版交付都显示实施反馈', async () => {
    const origin = 'https://cds-layout.fixture.invalid';
    const draftParams = { project: projectId, design: historyDraft.id };
    const draftPath = '/design?' + new URLSearchParams(draftParams);
    const latest = render(DesignWorkspacePage, draftPath, historyWorkspace);
    await withLayout(latest, draftStyles, async page => {
      page.setDefaultTimeout(5000);
      async function renderAddress(url: URL) {
        const markup = render(DesignWorkspacePage, url.pathname + url.search + url.hash, historyWorkspace);
        await page.locator('#root').evaluate((root, html) => { root.innerHTML = html; }, markup);
      }

      const version = page.getByRole('combobox', { name: '稿件版本' });
      const screen = page.getByRole('combobox', { name: '选择画面' });
      const comments = page.getByRole('complementary', { name: '画面评论' });
      const selected = comments.locator('article[data-selected="true"]');
      expect(await version.inputValue()).toBe('2');
      expect(await screen.inputValue()).toBe(currentScreen.id);
      await renderAddress(new URL(draftPath + '&comment=' + encodeURIComponent(currentComment.id), origin));
      expect(await comments.isVisible(), '评论参数会打开当前画面的评论栏').toBe(true);
      expect(await selected.innerText()).toContain(currentComment.body);
      expect(await comments.getByRole('heading', { name: '其他版本的画布评论' }).isVisible()).toBe(true);
      const historyLink = comments.getByRole('link', { name: new RegExp(previousComment.body + '.*V1') });
      const historical = new URL((await historyLink.getAttribute('href'))!, origin);
      expect(historical.origin + historical.pathname).toBe(origin + '/design');
      expect(Object.fromEntries(historical.searchParams)).toEqual({
        ...draftParams, version: '1', screen: previousScreen.id, comment: previousComment.id,
      });
      await renderAddress(historical);
      expect(await version.inputValue()).toBe('1');
      expect(await screen.inputValue()).toBe(previousScreen.id);
      expect(await selected.innerText()).toContain(previousComment.body);
      expect(await selected.innerText()).toContain(previousComment.replies[0].body);
      expect(await selected.getByRole('textbox', { name: '回复' }).isVisible()).toBe(true);

      const feedbackLink = comments.getByRole('link', { name: '查看各版实施反馈' });
      const historicalDelivery = new URL((await feedbackLink.getAttribute('href'))!, origin);
      expect(historicalDelivery.origin + historicalDelivery.pathname).toBe(origin + '/design');
      expect(Object.fromEntries(historicalDelivery.searchParams)).toEqual({ ...draftParams, version: '1', tab: 'delivery' });
      expect(historicalDelivery.hash).toBe('#dw-delivery-feedback');
      await renderAddress(historicalDelivery);
      for (const viewed of [1, 2]) {
        if (viewed === 2) await renderAddress(new URL('/design?' + new URLSearchParams({ ...draftParams, tab: 'delivery' }), origin));
        expect(await version.inputValue()).toBe(String(viewed));
        const sections = page.locator('.dw-delivery-panel > section');
        expect(await sections.nth(0).getByRole('heading').innerText()).toMatch(new RegExp(`^V${viewed} 交付摘要`));
        const feedback = sections.nth(1);
        expect(await feedback.getByRole('heading', { name: '实施反馈', exact: true }).isVisible()).toBe(true);
        for (const thread of [previousFeedback, currentFeedback]) {
          const item = feedback.locator('details.dw-delivery-thread').filter({ hasText: thread.title });
          expect(await item.count()).toBe(1);
          expect(await item.getByRole('button', { name: `V${thread.version} 资料`, exact: true }).isVisible()).toBe(true);
          expect(await item.getByText(thread.body, { exact: true }).isVisible()).toBe(true);
        }
        expect(await feedback.getByText(previousFeedback.replies[0].body, { exact: true }).isVisible()).toBe(true);
      }
    });
  }, 30_000);

  it('A-03 V3 桌面稿件页头第一行保留标题和完整动作组，第二行只放页签', async () => {
    const cases = [[4, undefined], [2, '框架候选']] as const;
    for (const [version, action] of cases) {
      const markup = design(`&design=${layoutDraft.id}&version=${version}&tab=preview`, { ...workspace, designs: [layoutDraft] });
      await withLayout(markup, draftStyles, async page => {
        for (const [width, height] of desktopSizes) {
          await page.setViewportSize({ width, height });
          const metrics = await measureDraftHeader(page, boundTitle, action);
          const row = [...metrics.titleGroup, ...metrics.actionGroup];
          const description = `${width}px V${version}`;
          checkDraftBounds(metrics, width);
          expect.soft(shareRow(row), `${description} 标题组和动作组同排`).toBe(true);
          expect.soft(Math.max(...metrics.titleGroup.map(box => box.x + box.width)), `${description} 标题组在动作组左侧`)
            .toBeLessThanOrEqual(Math.min(...metrics.actionGroup.map(box => box.x)) + 1);
          expect.soft(metrics.tabsBox.y, `${description} 页签独占第二行`)
            .toBeGreaterThanOrEqual(Math.max(...row.map(box => box.y + box.height)) - 1);
          expect.soft(metrics.headerBox.height, `${description} 页头总高`).toBeLessThanOrEqual(100);
          if (version === 4) {
            expect.soft(await page.getByRole('button', { name: '定为实施基线', exact: true }).count(), `${description} 页头没有常驻定基线动作`).toBe(0);
          }
        }
      });
    }
  }, 15_000);

  it('A-26 V3 长稿名在 1280px 完整显示，在 853px 省略并保留全名提示', async () => {
    const longDraft: DesignEntry = {
      ...layoutDraft, id: 'DSN-fixture-long', frozen: undefined, reviewRequested: true,
      versions: [{ ...first }, { ...second, title: longTitle }],
    };
    const markup = design(`&design=${longDraft.id}&version=2&tab=preview`, { ...workspace, designs: [longDraft] });
    await withLayout(markup, draftStyles, async page => {
      for (const [width, height] of [desktopSizes[0], desktopSizes[2]]) {
        await page.setViewportSize({ width, height });
        const metrics = await measureDraftHeader(page, longTitle);
        checkDraftBounds(metrics, width);
        expect.soft(metrics.titleAvailable, `${width}px 长标题仍有可见正文`).toBeGreaterThan(0);
        expect.soft(shareRow([...metrics.titleGroup, ...metrics.actionGroup]), `${width}px 长标题不挤掉动作组`).toBe(true);
        if (width === 1280) {
          expect.soft(metrics.titleMeasured, '1280px 长标题需完整看到').toBeLessThanOrEqual(metrics.titleAvailable + 1);
        } else {
          expect.soft(metrics.titleMeasured, '853px 长标题需要局部省略').toBeGreaterThan(metrics.titleAvailable + 1);
          expect.soft(metrics.titleEllipsis, '853px 截断的长标题显示省略号').toBe('ellipsis');
          expect.soft(metrics.titleTooltip, '853px 标题悬停可回读原全名').toBe(longTitle);
        }
      }
    });
  }, 15_000);

  it('A-05/P6 从稿件信息的基线组进入有权限的定稿操作，并按锁定基线打开对比', async () => {
    const input = { ...workspace, designs: [layoutDraft] };
    const current = `&design=${layoutDraft.id}&version=4`;
    const markup = design(`${current}&tab=diff&compareFrom=2`, input);
    await withLayout(markup, draftStyles, async page => {
      const left = page.getByRole('combobox', { name: '对比左侧版本' });
      const right = page.getByRole('combobox', { name: '对比右侧版本' });
      expect(await left.inputValue()).toBe('2');
      expect(await right.inputValue()).toBe('4');
      expect(await page.getByRole('combobox', { name: '稿件版本' }).locator('option:checked').textContent()).toContain('V4 · 最新');
      expect(await page.getByRole('combobox', { name: '稿件版本' }).locator('option[value="2"]').textContent()).toContain('V2 · 实施基线');
      const trigger = page.getByLabel('稿件信息', { exact: true });
      await trigger.click();
      const info = trigger.locator('xpath=..');
      const baseline = info.locator('dt').filter({ hasText: /^基线$/ }).locator('xpath=following-sibling::dd[1]');
      expect(await baseline.getByRole('button', { name: '定为实施基线', exact: true }).isVisible()).toBe(true);
      expect(await info.getByRole('button', { name: '撤销定稿', exact: true }).isVisible()).toBe(true);
      expect(await info.getByRole('link', { name: `#${tag}`, exact: true }).isVisible()).toBe(true);
      const popover = info.locator('.dw-info-body');
      for (const [width, height] of infoSizes) {
        await page.setViewportSize({ width, height });
        const metrics = await measureDraftInfo(popover);
        checkDraftInfoBounds(metrics, width);
        expect(metrics.freeze, `${width}px 有可见的定基线动作`).toBeDefined();
        expect.soft(metrics.freeze!.visible, `${width}px 定基线标签完整落在按钮和弹层内`).toBe(true);
        expect.soft(metrics.freeze!.lines, `${width}px 定基线标签占一行`).toBe(1);
        expect.soft(metrics.freeze!.lineGap, `${width}px 定基线按钮另起一行`).toBeGreaterThanOrEqual(-1);
      }
    });
    const readOnly = { ...input, permissions: { ...input.permissions, write: false, review: false, steward: false } };
    const readOnlyHtml = design(`${current}&tab=preview`, readOnly);
    expect(readOnlyHtml).not.toContain('定为实施基线');
    expect(readOnlyHtml).not.toContain('撤销定稿');
  }, 15_000);

  it('A-27 稿件信息有具名分组，危险操作在底部靠右，缩窄后仍在视口内', async () => {
    const entry: DesignEntry = {
      ...layoutDraft,
      versions: layoutDraft.versions.map(version => ({ ...version, sourceVerification: 'git' })),
    };
    const markup = design(`&design=${entry.id}&version=2&tab=preview`, { ...workspace, designs: [entry] });
    await withLayout(markup, draftStyles, async page => {
      await page.setViewportSize({ width: 1280, height: 800 });
      expect(await page.locator('.dw-draft-heading').innerText()).not.toContain('可升级到');
      const info = page.getByLabel('稿件信息', { exact: true });
      await info.click();
      const popover = info.locator('xpath=..').locator('.dw-info-body');
      const groupNames = await popover.locator('dt').allTextContents();
      expect(groupNames).toEqual(expect.arrayContaining(['发布', '来源', '基线', '框架', '评审人', '说明', '决策']));
      const framework = popover.locator('dt').filter({ hasText: /^框架$/ }).locator('xpath=following-sibling::dd[1]');
      expect(await framework.innerText()).toContain('可升级到 v2');
      const footer = popover.locator('footer');
      const settings = footer.getByRole('button', { name: '设置评审人', exact: true });
      const revoke = footer.getByRole('button', { name: '撤销定稿', exact: true });
      expect(await settings.isVisible()).toBe(true);
      expect(await footer.getByRole('button', { name: '固定版本分享', exact: true }).isVisible()).toBe(true);
      expect(await revoke.isVisible()).toBe(true);
      expect(await revoke.evaluate(element => getComputedStyle(element).color)).not.toBe(await settings.evaluate(element => getComputedStyle(element).color));
      for (const [width, height] of infoSizes) {
        await page.setViewportSize({ width, height });
        const [panel, actions, facts, danger] = await Promise.all([popover, footer, popover.locator('dl'), revoke].map(node => node.boundingBox()));
        expect(panel, `${width}px 信息弹层可见`).not.toBeNull();
        expect.soft(panel!.x, `${width}px 信息弹层左边缘`).toBeGreaterThanOrEqual(0);
        expect.soft(panel!.x + panel!.width, `${width}px 信息弹层右边缘`).toBeLessThanOrEqual(width + 1);
        expect.soft(panel!.y + panel!.height, `${width}px 信息弹层底边`).toBeLessThanOrEqual(height + 1);
        expect.soft(actions!.y, `${width}px 操作在信息组下面`).toBeGreaterThanOrEqual(facts!.y + facts!.height - 1);
        expect.soft(danger!.x + danger!.width, `${width}px 撤销定稿贴近操作区右侧`).toBeGreaterThanOrEqual(actions!.x + actions!.width - 3);
        const metrics = await measureDraftInfo(popover);
        checkDraftInfoBounds(metrics, width);
        expect(metrics.revoke, `${width}px 有可见的撤销定稿动作`).toBeDefined();
        expect.soft(metrics.revoke!.width, `${width}px 撤销定稿没有铺满操作区`).toBeLessThan(metrics.revoke!.footerWidth - 1);
        expect.soft(metrics.revoke!.centerOffset, `${width}px 撤销定稿文字在按钮内居中`).toBeLessThanOrEqual(2);
        expect.soft(metrics.revoke!.visible, `${width}px 撤销定稿标签完整`).toBe(true);
      }
    });
  }, 15_000);

  it('A-28 V3 在 375px 触控视口保留标题、动作、页签三行，只有页签可横滑', async () => {
    const markup = design(`&design=${layoutDraft.id}&version=4&tab=preview`, { ...workspace, designs: [layoutDraft] });
    await withLayout(markup, draftStyles, async page => {
      const metrics = await measureDraftHeader(page, boundTitle);
      checkDraftBounds(metrics, 375);
      expect(metrics.touchPoints, '使用 375px 触控视口').toBeGreaterThan(0);
      expect.soft(shareRow(metrics.titleGroup), '手机标题组各项同排').toBe(true);
      expect.soft(shareRow(metrics.actionGroup), '手机动作组各项同排').toBe(true);
      expect.soft(Math.min(...metrics.actionGroup.map(box => box.y)), '手机动作组完整排在标题组之后')
        .toBeGreaterThanOrEqual(Math.max(...metrics.titleGroup.map(box => box.y + box.height)) - 1);
      expect.soft(metrics.tabsBox.y, '手机页签独立于动作组')
        .toBeGreaterThanOrEqual(Math.max(...metrics.actionGroup.map(box => box.y + box.height)) - 1);
      expect.soft(metrics.information.x + metrics.information.width, '手机稿件信息位于动作行右侧')
        .toBeGreaterThanOrEqual(metrics.headerBox.x + metrics.headerBox.width - 6);
      expect.soft(['auto', 'scroll'], '只有页签使用横向滚动').toContain(metrics.tabOverflowMode);
      expect.soft(metrics.tabOverflow, '真实带计数的页签提供可横滑的内容').toBeGreaterThan(1);
      expect.soft(await page.getByRole('button', { name: '定为实施基线', exact: true }).count(), '手机没有常驻定基线动作').toBe(0);

      if (metrics.tabOverflow > 1) {
        const y = Math.round(metrics.tabsBox.y + metrics.tabsBox.height / 2);
        const left = metrics.tabsBox.x;
        const right = left + metrics.tabsBox.width;
        const session = await page.context().newCDPSession(page);
        for (const [type, x] of [
          ['touchStart', right - 15], ['touchMove', right - 65], ['touchMove', left + 30], ['touchEnd', left],
        ] as const) {
          await session.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: Math.round(x), y }] });
        }
        const tabs = page.getByRole('navigation', { name: '稿件标签' });
        await expect.poll(() => tabs.evaluate(element => element.scrollLeft), { timeout: 1200 }).toBeGreaterThan(0);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(376);
      }
    }, { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
  }, 15_000);

  it('A-02/A-23 等效缩放和手机看板左缘、整页宽度与页面动作可达', async () => {
    const markup = render(EngineeringPlanningPage, `/engineering-planning?project=${projectId}&view=plan`);
    expect(markup).toContain('用于窄屏回归的推进计划');
    await withLayout(markup, [
      'web/src/pages/engineering-planning/planning.css',
      'web/src/pages/engineering-planning/planning-shell.css',
      'web/src/pages/engineering-planning/planning-decision.css',
    ], async page => {
      for (const [width, height] of [[1024, 640], [853, 533], [375, 812]]) {
        await page.setViewportSize({ width, height });
        const metrics = await page.evaluate(() => {
          const board = document.querySelector<HTMLElement>('.ep-advancement-board')!;
          board.scrollLeft = 0;
          const lanes = Array.from(board.querySelectorAll<HTMLElement>('.ep-advancement-lane'), lane => lane.getBoundingClientRect());
          const cardLists = [...board.querySelectorAll<HTMLElement>('.ep-advancement-cards')];
          const narrowVertical = cardLists.flatMap(list => {
            const overflow = getComputedStyle(list).overflowY;
            return overflow !== 'visible' && list.scrollHeight > list.clientHeight + 1
              ? [{ lane: list.parentElement?.getAttribute('aria-label'), overflow, height: list.clientHeight, content: list.scrollHeight }] : [];
          });
          const main = board.closest('main')!;
          const actions = Array.from(document.querySelectorAll('.ep-page-actions :is(button, summary)')).filter(action => {
            const closed = action.closest('details:not([open])');
            return !closed || closed.querySelector(':scope > summary')?.contains(action);
          }).map(action => ({ label: action.getAttribute('aria-label') || action.textContent?.trim(), box: action.getBoundingClientRect() }))
            .filter(({ box }) => box.width > 0 && box.height > 0);
          const clipped = actions.filter(({ box }) => box.left < 0 || box.right > innerWidth + 1)
            .map(({ label, box }) => ({ label, left: Math.round(box.left), right: Math.round(box.right) }));
          return {
            documentWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth,
            boardWidth: board.clientWidth, boardContentWidth: board.scrollWidth,
            mainScrolls: main.scrollHeight > main.clientHeight + 1,
            cards: Math.max(...cardLists.map(list => list.querySelectorAll(':scope > .ep-advancement-card').length)),
            narrowVertical,
            firstLaneInside: lanes.length === 4 && lanes[0].width > 0 && lanes[0].height > 0
              && lanes[0].left >= Math.max(0, board.getBoundingClientRect().left) - 1 && lanes[0].right <= innerWidth + 1,
            actions: actions.length, clipped,
            mobileStacked: lanes.every((lane, i) => i === 0 || lane.top >= lanes[i - 1].bottom - 1 && Math.abs(lane.left - lanes[0].left) < 1),
          };
        });
        expect(metrics.documentWidth, `${width} px 时文档宽度`).toBeLessThanOrEqual(metrics.viewportWidth + 1);
        expect(metrics.firstLaneInside, `${width} px 时最左列可见`).toBe(true);
        expect(metrics.actions, `${width} px 时存在页面动作`).toBeGreaterThan(0);
        expect(metrics.clipped, `${width} px 时页面动作可见`).toEqual([]);
        if (width !== 375) {
          expect(metrics.cards, `${width} px 用真实卡片压测列高`).toBe(12);
          expect(metrics.mainScrolls, `${width} px 由主内容统一纵向滚动`).toBe(true);
          expect(metrics.boardContentWidth, `${width} px 看板自身不能横向溢出`).toBeLessThanOrEqual(metrics.boardWidth + 1);
          expect(metrics.narrowVertical, `${width} px 卡片列表不能独立纵向滚动或裁切`).toEqual([]);
        }
        if (width === 375) expect(metrics.mobileStacked).toBe(true);
      }
    });
  }, 25_000);
});
