import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { chromium } from 'playwright';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DesignEntry, DesignVersion, DesignWorkspace } from '../../src/shared/design-workspace';
import type { PlanningBoard } from '../../src/shared/engineering-planning';
import { DesignWorkspacePage } from '../../web/src/pages/DesignWorkspacePage';
import { EngineeringPlanningPage } from '../../web/src/pages/EngineeringPlanningPage';
import { usePlanningRead } from '../../web/src/pages/engineering-planning/planning-ui';

const { MemoryRouter } = createRequire(path.resolve('web/package.json'))('react-router-dom');

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
  plans: [{
    id: 'PLN-fixture', projectId, title: '用于窄屏回归的推进计划', version: 1, createdAt: at, updatedAt: at,
    source: { type: 'manual', ref: 'fixture-plan' }, steps: [{ id: 'step-1', kind: 'task', title: '核对页面尺寸', status: 'doing' }],
  }],
};

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

async function withLayout(markup: string, cssFiles: string[], check: (page: import('playwright').Page) => Promise<void>) {
  const styles = await Promise.all(['web/src/index.css', ...cssFiles].map(file => readFile(file, 'utf8')));
  const browser = await chromium.launch({ headless: true,
    ...(process.env.CDS_CHROMIUM_PATH ? { executablePath: process.env.CDS_CHROMIUM_PATH } : { channel: 'chrome' }),
  });
  try {
    const page = await browser.newPage({ serviceWorkers: 'block' });
    await page.route('**/*', routed => routed.abort());
    // The real component markup and layout CSS run in a browser with a synthetic API read model.
    await page.setContent(`<!doctype html><html data-theme="light"><head><style>
      *,::before,::after{box-sizing:border-box}body{margin:0}
      ${styles.join('\n')}
      </style></head><body><div id="root">${markup}</div></body></html>`);
    await check(page);
  } finally {
    await browser.close();
  }
}

describe('工程规划与设计 V2 前端回归', () => {
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

  it('A-03/A-05 稿件页头公开当前版、实施基线、框架、标签及基线操作', () => {
    const html = design(`&design=${bound.id}&version=2&tab=preview`);
    const visible = visibleText(html);
    expect(visible).toMatch(/当前\s*V2.*实施基线\s*V1/);
    expect(visible).toContain(frameworkId);
    expect(visible).toContain(tag);
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

  it('A-03 稿件页头宽屏同行，窄屏依次显示标题、标识和动作', async () => {
    const markup = design(`&design=${bound.id}&version=2&tab=preview`);
    await withLayout(markup, ['web/src/pages/engineering-planning/planning.css', 'web/src/pages/design-workspace/design.css'], async page => {
      const header = page.locator('.dw-head--draft');
      const controls = [
        [header.getByText(boundTitle, { exact: true }), '标题'],
        [header.locator('.dw-draft-marks .dw-status'), '稿件状态'],
        [header.getByText(/实施基线\s*V1/), '实施基线'],
        [header.getByText(new RegExp(frameworkId)), '框架'],
        [header.getByText(new RegExp(tag)), '标签'],
        [header.getByRole('button', { name: '大屏', exact: true }), '大屏入口'],
      ] as const;
      for (const width of [1280, 760]) {
        await page.setViewportSize({ width, height: 800 });
        const boxes = await Promise.all(controls.map(async ([control, label]) => {
          const visible = control.filter({ visible: true });
          expect(await visible.count(), `${width} px 时页头可见的${label}`).toBeGreaterThan(0);
          return visible.first().boundingBox({ timeout: 900 });
        }));
        expect(boxes.every(box => box && box.x >= 0 && box.x + box.width <= width + 1)).toBe(true);
        const statusLines = await header.locator('.dw-draft-marks .dw-status').evaluate(element => {
          const content = document.createRange();
          content.selectNodeContents(element);
          return new Set([...content.getClientRects()].map(rect => rect.top)).size;
        });
        expect(statusLines).toBe(1);
        const [titleBox, ...rest] = boxes.map(box => box!);
        const actionBox = rest.pop()!;
        if (width === 1280) {
          expect(Math.max(...boxes.map(box => box!.y))).toBeLessThan(Math.min(...boxes.map(box => box!.y + box!.height)));
        } else {
          expect(titleBox.y + titleBox.height).toBeLessThanOrEqual(Math.min(...rest.map(box => box.y)) + 1);
          expect(Math.max(...rest.map(box => box.y + box.height))).toBeLessThanOrEqual(actionBox.y + 1);
        }
      }
    });
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
          const actions = Array.from(document.querySelectorAll('.ep-page-actions :is(button, summary)')).filter(action => {
            const closed = action.closest('details:not([open])');
            return !closed || closed.querySelector(':scope > summary')?.contains(action);
          }).map(action => ({ label: action.getAttribute('aria-label') || action.textContent?.trim(), box: action.getBoundingClientRect() }))
            .filter(({ box }) => box.width > 0 && box.height > 0);
          const clipped = actions.filter(({ box }) => box.left < 0 || box.right > innerWidth + 1)
            .map(({ label, box }) => ({ label, left: Math.round(box.left), right: Math.round(box.right) }));
          return {
            documentWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth,
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
        if (width === 375) expect(metrics.mobileStacked).toBe(true);
      }
    });
  }, 15_000);
});
