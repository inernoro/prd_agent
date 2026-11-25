import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { chromium, type Browser, type BrowserContextOptions, type Locator, type Page } from 'playwright';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { DesignComment, DesignEntry, DesignFeedback, DesignRequirement, DesignScreen, DesignThumbnailStatus, DesignVersion, DesignViewerState, DesignWorkspace } from '../../src/shared/design-workspace';
import type { PlanningBoard } from '../../src/shared/engineering-planning';
import { measureDesignPage } from '../../src/services/design-acceptance-observations';
import { decorateDesignPrototype } from '../../src/services/design-prototype';
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

let fixtureBrowser: Promise<Browser> | undefined;
afterAll(async () => { await fixtureBrowser?.then(browser => browser.close()); });

async function fixturePage(options?: BrowserContextOptions) {
  fixtureBrowser ??= chromium.launch({ headless: true,
    ...(process.env.CDS_CHROMIUM_PATH ? { executablePath: process.env.CDS_CHROMIUM_PATH } : { channel: 'chrome' }),
  });
  return (await fixtureBrowser).newPage({ ...options, serviceWorkers: 'block' });
}

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
const guidedVersion: DesignVersion = {
  ...historyDraft.versions[1], version: 18,
  screens: [currentScreen, ...['comments', 'deliver'].map(pane => ({
    ...historyScreen(`fixture-${pane}`, pane), route: `#/design?pane=${pane}`,
  }))],
};
const guidedDraft = { ...historyDraft, versions: [...historyDraft.versions, guidedVersion] };
const guidedWorkspace = { ...historyWorkspace, designs: [guidedDraft] };

describe('V17 交付工作区', () => {
  it('打开稿件先看画面和这一屏，同时保留旧链接的全文入口', () => {
    const query = `&design=${historyDraft.id}&version=2`;
    const initial = design(query, historyWorkspace);
    const navigation = initial.match(/<nav\b[^>]*aria-label="稿件标签"[^>]*>(.*?)<\/nav>/)?.[1] ?? '';
    expect([...navigation.matchAll(/<button\b/g)]).toHaveLength(3);
    expect(initial).toContain('aria-label="这一屏的需求、说明、反馈和资料"');
    expect(initial).toContain(currentScreen.name);
    expect(initial).not.toContain('data-full-view="need"');
    expect(design(query + '&tab=need', historyWorkspace)).toContain('data-full-view="need"');
    expect(design(query + '&tab=spec', historyWorkspace)).toContain('data-full-view="notes"');
    expect(design(query + '&tab=delivery&part=feedback', historyWorkspace)).toContain('data-full-view="delivery"');
    expect(design(query + '&tab=delivery&side=off', historyWorkspace)).toContain('data-action="side-open"');
  });

  it('给定实际签收版本时显示与实施基线的差值，记录默认展示版本因果', () => {
    const draft = { ...historyDraft, frozen: 2, implementedVersion: 1, versionGap: { direction: 'behind' as const, count: 1 } };
    const input = { ...historyWorkspace, designs: [draft] };
    const html = design(`&design=${draft.id}&tab=log`, input);
    expect(html).toContain('已实现 V1');
    expect(html).toContain('落后 1 版');
    expect(html).toContain('按版本 · 因果');
    expect(html).toContain(previousFeedback.title);
    expect(html).toContain('反馈');
    expect(html).toContain('data-history-view="causal"');
    const timeline = design(`&design=${draft.id}&tab=log&log=timeline`, input);
    expect(timeline).toContain('data-history-view="timeline"');
    expect(timeline).toContain('登记反馈');
    expect(design(`&design=${draft.id}&tab=diff`, input))
      .toMatch(/<select[^>]*aria-label="稿件版本"[^>]*disabled/);
  });

  it('需求全文读取实际交接条款并显示每项结果和缺口', () => {
    const designKey = 'fixture/requirements';
    const rule = { id: 'A-17', rule: '可关闭设置', priority: 'normal' as const, how: 'measure' as const,
      screenId: currentScreen.id, slots: ['desktop-light'] as const, requirementRef: '1' };
    const draft = { ...historyDraft, designKey, versions: [first, { ...historyDraft.versions[1], acceptance: [rule] }] };
    const requirements: DesignRequirement[] = [{ designKey, planId: 'PLN-real', planVersion: 2, proposalId: 'PRO-real',
      sharedAt: at, title: '交接的需求',
      requirements: '## 业务规则与验收\n\n1. 保持 **设置可关闭**。\n2. 保留旧设置。' }];
    const html = design(`&design=${draft.id}&tab=delivery&full=need`, { ...historyWorkspace, requirements, designs: [draft] });
    expect(html).toContain('PLN-real V2');
    expect(html).toContain('2 条里 1 条没有验收');
    expect(html).toContain('A-17');
    expect(html).toContain('未运行');
    expect(html).toContain('<strong>设置可关闭</strong>');
  });

  it('随画面显示右栏，全文关闭、右栏收起以及返回保持同一屏', async () => {
    await withDesignBrowser(() => historyWorkspace, async page => {
      await page.goto(browserDesignUrl({ design: historyDraft.id, version: '1' }));
      const side = page.getByRole('complementary', { name: '这一屏的需求、说明、反馈和资料' });
      await side.getByText('旧版首张画面', { exact: true }).waitFor();
      await page.getByRole('combobox', { name: '选择画面' }).selectOption(previousScreen.id);
      await side.getByText(previousScreen.name, { exact: true }).waitFor();
      await side.getByRole('button', { name: '看全部说明' }).click();
      const overlay = page.locator('[data-full-view="notes"]');
      await overlay.waitFor();
      await expect.poll(() => new URL(page.url()).searchParams.get('screen')).toBe(previousScreen.id);
      await page.keyboard.press('Escape');
      await overlay.waitFor({ state: 'hidden' });
      expect(await page.getByRole('combobox', { name: '选择画面' }).inputValue()).toBe(previousScreen.id);
      await side.getByRole('button', { name: '收起右栏' }).click();
      await side.waitFor({ state: 'hidden' });
      await page.getByRole('button', { name: '打开右栏' }).click();
      await side.getByText(previousScreen.name, { exact: true }).waitFor();
    });
  }, 20_000);

  it('将历史版本定为基线前填写理由，服务端收到所选版本与原基线', async () => {
    await withDesignBrowser(() => ({ ...workspace, designs: [layoutDraft] }), async (page, commands) => {
      await page.goto(browserDesignUrl({ design: layoutDraft.id, version: '1' }));
      await page.getByLabel('更多稿件操作', { exact: true }).click();
      await page.getByRole('button', { name: '定为实施基线', exact: true }).click();
      const modal = page.getByRole('dialog', { name: '将 V1 定为实施基线' });
      const confirm = modal.getByRole('button', { name: '确认实施基线' });
      expect(await confirm.isDisabled()).toBe(true);
      expect(commands).toHaveLength(0);
      await modal.getByRole('textbox', { name: '选择历史版本的理由' }).fill('复核历史版本的成员列表。');
      await confirm.click();
      await expect.poll(() => commands.length).toBe(1);
      expect(commands[0]).toMatchObject({ type: 'design.freeze', designId: layoutDraft.id, version: 1,
        expectedBaseline: 2, reason: '复核历史版本的成员列表。' });
    });
  }, 20_000);

  it('交付、验收和记录切换时页头及三项操作的几何一致', async () => {
    const input = { ...workspace, designs: [layoutDraft] };
    const details = `&design=${layoutDraft.id}&version=4&tab=`;
    await withLayout(design(details + 'delivery', input), draftStyles, async page => {
      const layout = async () => {
        const { titleGroup, actionGroup, headerBox, tabsBox } = await measureDraftHeader(page, boundTitle);
        return { titleGroup, actionGroup, headerBox, tabsBox };
      };
      for (const [width, height] of infoSizes) {
        await page.setViewportSize({ width, height });
        let initial: Awaited<ReturnType<typeof layout>> | undefined;
        for (const tab of ['delivery', 'accept', 'log']) {
          const markup = design(details + tab, input);
          await page.locator('#root').evaluate((scope, html) => { scope.innerHTML = html; }, markup);
          const current = await layout();
          if (initial) expect(current).toEqual(initial);
          else initial = current;
        }
      }
    }, { reducedMotion: 'reduce' });
  }, 20_000);
});

describe('已发布的演示、评论和交付布局', () => {
  const thumbnailPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGPwL5wJAAJsAVpBgUBhAAAAAElFTkSuQmCC', 'base64');

  it('同一份稿件的新版展示新右栏，历史版沿用原画面入口', async () => {
    await withDesignBrowser(() => guidedWorkspace, async page => {
      await page.goto(browserDesignUrl({ design: guidedDraft.id, version: '18' }));
      const side = page.getByRole('complementary', { name: '演示、评论和交付' });
      await side.getByRole('heading', { name: '演示流程' }).waitFor();
      await side.getByRole('tab', { name: '评论' }).click();
      await side.getByText('这一版还没有评论。').waitFor();
      await side.getByRole('tab', { name: '交付' }).click();
      for (const item of ['做出什么', '做到什么算完成', '为什么要这样', '拿什么做', '还没定的']) {
        await side.getByRole('heading', { name: new RegExp(item) }).waitFor();
      }
      await page.getByRole('combobox', { name: '稿件版本' }).selectOption('2');
      await side.waitFor({ state: 'hidden' });
      await page.getByRole('complementary', { name: '这一屏的需求、说明、反馈和资料' })
        .getByText(currentScreen.name, { exact: true }).waitFor();
    });
  }, 20_000);

  it('画廊和演示区通过可见入口打开缺图与读图失败的原型', async () => {
    const available = historyScreen('gallery-available', '设计库概览');
    const missing = historyScreen('gallery-missing', '设计库列表');
    const broken = historyScreen('gallery-broken', '连接设置');
    const version: DesignVersion = {
      ...guidedVersion,
      version: 24,
      title: '交付画廊缩略图检查',
      screens: [available, missing, broken].map(screen => ({ ...screen, themes: ['light' as const] })),
      demo: [available, missing, broken].map(screen => ({ screen: screen.id, title: screen.name })),
      renders: {
        [available.id]: { light: { id: 'fixture-thumbnail-available', sha256: 'a'.repeat(64) } },
        [broken.id]: { light: { id: 'fixture-thumbnail-broken', sha256: 'b'.repeat(64) } },
      },
    };
    const draft = { ...guidedDraft, id: 'DSN-fixture-gallery', versions: [version], comments: [], feedback: [] };
    await withDesignBrowser(() => ({ ...guidedWorkspace, designs: [draft] }), async (page, commands) => {
      const thumbnailReads: URLSearchParams[] = [];
      await page.route(url => url.pathname === `/api/projects/${projectId}/design` && url.searchParams.get('view') === 'thumbnails', route => {
        thumbnailReads.push(new URL(route.request().url()).searchParams);
        return route.fulfill({ json: { designId: draft.id, version: version.version, state: 'unavailable',
          total: 3, completed: 2, renders: version.renders } });
      });
      await page.route('**/design/artifacts/fixture-thumbnail-available', route =>
        route.fulfill({ contentType: 'image/png', body: thumbnailPng }));
      await page.route(url => url.pathname.endsWith('/design/artifacts/fixture-thumbnail-broken'), route => route.fulfill({ status: 404 }));
      await page.route(url => url.pathname.endsWith('/design/artifacts/' + version.prototypeId), route => route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: decorateDesignPrototype(`<!doctype html><html><head><title>演示原型</title></head><body>
          <h1></h1><script>document.querySelector('h1').textContent = '原型 ' + location.hash.slice(2);</script>
          </body></html>`),
      }));

      await page.goto(browserDesignUrl());
      await page.getByRole('link', { name: version.title, exact: true }).first().click();
      const all = page.getByRole('button', { name: '全部 3 屏', exact: true });
      await all.click();
      const gallery = page.locator('.dw-all-screens');
      const card = (screen: DesignScreen) => gallery.getByRole('button', { name: '打开原型 ' + screen.name, exact: true });
      const frame = page.locator('.dw-single .dw-frame');
      await gallery.waitFor();
      expect(await gallery.locator('iframe').count()).toBe(0);
      expect(await card(missing).innerText()).toContain('缺少缩略图');
      await card(missing).getByText('打开原型', { exact: true }).waitFor();
      await card(broken).getByText('缩略图加载失败', { exact: true }).waitFor();
      await card(broken).getByText('打开原型', { exact: true }).waitFor();
      await expect.poll(() => card(available).locator('img').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
      await expect.poll(() => thumbnailReads.some(params => params.get('designId') === draft.id && params.get('version') === '24')).toBe(true);
      await page.getByText(/自动.*缩略图.*(?:暂不可用|未启用|尚未配置)|(?:暂不可用|未启用|尚未配置).*自动.*缩略图/).first().waitFor();
      expect(await page.getByRole('button', { name: '生成缩略图', exact: true }).count()).toBe(0);
      expect(commands).toHaveLength(0);
      const inspect = async (screen: DesignScreen) => {
        await frame.waitFor();
        expect(await frame.getAttribute('data-screen')).toBe(screen.id);
        expect(new URL(page.url()).searchParams.get('screen')).toBe(screen.id);
        const prototype = frame.locator('iframe');
        expect(await prototype.getAttribute('sandbox')).toBe('allow-scripts');
        expect(new URL((await prototype.getAttribute('src'))!, page.url()).hash).toBe(screen.route);
        await expect.poll(() => frame.getAttribute('data-preview-state'), { timeout: 6000 }).toBe('ready');
        await prototype.contentFrame().getByRole('heading', { name: '原型 ' + screen.id, exact: true }).waitFor();
      };
      await card(missing).focus();
      await page.keyboard.press('Enter');
      await inspect(missing);

      const side = page.getByRole('complementary', { name: '演示、评论和交付' });
      const missingStep = side.locator(`button[data-screen="${missing.id}"]`);
      await missingStep.getByText('打开原型', { exact: true }).waitFor();

      await all.click();
      await card(broken).click();
      await inspect(broken);

      await all.click();
      await card(available).click();
      await inspect(available);
    });
  }, 20_000);

  it('画廊打开时点击演示侧栏的当前画面或其他画面都返回单屏', async () => {
    await withDesignBrowser(() => guidedWorkspace, async page => {
      await page.goto(browserDesignUrl());
      await page.getByRole('link', { name: guidedVersion.title, exact: true }).first().click();
      const side = page.getByRole('complementary', { name: '演示、评论和交付' });
      const gallery = page.locator('.dw-all-screens');
      const all = page.getByRole('button', { name: '全部 3 屏', exact: true });
      const selected = page.getByRole('combobox', { name: '选择画面' });
      await expect.poll(() => selected.inputValue()).toBe(currentScreen.id);
      await all.click();
      await gallery.waitFor();
      await side.locator(`button[data-screen="${currentScreen.id}"]`).click();
      await expect.poll(() => gallery.isVisible()).toBe(false);
      expect(await selected.inputValue()).toBe(currentScreen.id);

      const next = guidedVersion.screens[1];
      await all.click();
      await gallery.waitFor();
      await side.locator(`button[data-screen="${next.id}"]`).click();
      await expect.poll(() => gallery.isVisible()).toBe(false);
      expect(await selected.inputValue()).toBe(next.id);
      expect(new URL(page.url()).searchParams.get('screen')).toBe(next.id);
    });
  }, 15_000);

  it('所选版本补图后显示进度，部分完成时可重试并取回剩余图片', async () => {
    const firstScreen = historyScreen('recovery-overview', '补图概览');
    const nextScreen = historyScreen('recovery-details', '补图详情');
    const version: DesignVersion = {
      ...guidedVersion, version: 24, title: '同一版本补图检查',
      screens: [firstScreen, nextScreen].map(screen => ({ ...screen, themes: ['light' as const] })),
    };
    const draft = { ...guidedDraft, id: 'DSN-fixture-recovery', versions: [version], comments: [], feedback: [] };
    const renders: DesignThumbnailStatus['renders'] = {};
    let state: DesignThumbnailStatus['state'] = 'idle';
    await withDesignBrowser(() => ({ ...guidedWorkspace, designs: [{ ...draft, versions: [{ ...version, renders }] }] }), async (page, commands) => {
      const path = `/api/projects/${projectId}/design`;
      await page.route(url => url.pathname === path && url.searchParams.get('view') === 'thumbnails', route =>
        route.fulfill({
          json: { designId: draft.id, version: version.version, state,
            total: 2, completed: Object.keys(renders).length, renders } satisfies DesignThumbnailStatus,
        }));
      await page.route(url => url.pathname === path + '/commands', async route => {
        commands.push(route.request().postDataJSON());
        state = 'running';
        return route.fulfill({ json: { projectId, result: { designId: draft.id, version: version.version } } });
      });
      await page.route('**/design/artifacts/fixture-generated-*', route =>
        route.fulfill({ contentType: 'image/png', body: thumbnailPng }));

      await page.goto(browserDesignUrl());
      await page.getByRole('link', { name: version.title, exact: true }).first().click();
      await page.getByRole('button', { name: '全部 2 屏', exact: true }).click();
      const gallery = page.locator('.dw-all-screens');
      const card = (screen: DesignScreen) => gallery.getByRole('button', { name: '打开原型 ' + screen.name, exact: true });
      const progress = page.getByText(/正在生成|生成中/).first();
      await page.getByRole('button', { name: '生成缩略图', exact: true }).click();
      await progress.waitFor();
      expect(commands).toHaveLength(1);
      const expected = { type: 'reference.generate', designId: draft.id, version: version.version };
      expect(commands[0]).toMatchObject(expected);
      renders[firstScreen.id] = { light: { id: 'fixture-generated-overview', sha256: 'a'.repeat(64) } };
      state = 'incomplete';
      const retry = page.getByRole('button', { name: /重试.*(?:生成|缩略图)/ });
      await retry.waitFor();
      await expect.poll(() => card(firstScreen).locator('img').count()).toBe(1);
      await card(nextScreen).getByText('缺少缩略图', { exact: true }).waitFor();

      await retry.click();
      await progress.waitFor();
      expect(commands).toHaveLength(2);
      expect(commands[1]).toMatchObject(expected);
      renders[nextScreen.id] = { light: { id: 'fixture-generated-details', sha256: 'b'.repeat(64) } };
      state = 'ready';
      await expect.poll(() => gallery.locator('img').count(), { timeout: 6000 }).toBe(2);
      expect(await gallery.locator('iframe').count()).toBe(0);
      expect(await retry.isVisible()).toBe(false);
      await progress.waitFor({ state: 'hidden' });
    });
  }, 30_000);

  it('新版桌面页头一行，手机保留完整版本文案和可用的三个页签', async () => {
    const markup = design(`&design=${guidedDraft.id}&version=18`, guidedWorkspace);
    await withLayout(markup, [...draftStyles, 'web/src/pages/design-workspace/design-v18.css'], async page => {
      await page.setViewportSize({ width: 1280, height: 800 });
      const header = page.locator('.dw-head--v18');
      const tabs = header.getByRole('navigation', { name: '稿件标签' });
      expect((await header.boundingBox())!.height).toBeCloseTo(44, 0);
      expect(shareRow([(await header.locator('.dw-draft-actions').boundingBox())!,
        (await tabs.boundingBox())!])).toBe(true);
      expect(await tabs.evaluate(node => Number.parseFloat(getComputedStyle(node).columnGap))).toBeCloseTo(14.08, 1);
      expect((await tabs.getByRole('button', { name: '记录', exact: true }).boundingBox())!.height).toBeCloseTo(41, 0);
      await page.setViewportSize({ width: 375, height: 812 });
      const mobile = await measureDraftHeader(page, guidedVersion.title);
      checkDraftBounds(mobile, 375);
      expect(shareRow(mobile.titleGroup)).toBe(true);
      expect(shareRow(mobile.actionGroup)).toBe(true);
      expect(mobile.tabOverflow).toBeLessThanOrEqual(1);
    }, { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
  }, 15_000);
});

describe('设计的导航与状态', () => {
  it('在三个标签下保留旧预览、对比、说明和交付验收入口', () => {
    const tabs = { preview: '交付', diff: '交付', delivery: '交付', accept: '验收', rationale: '交付', spec: '交付', notes: '交付', need: '交付', log: '记录' };
    for (const [legacy, label] of Object.entries(tabs)) {
      const html = design(`&design=${historyDraft.id}&version=2&tab=${legacy}`, historyWorkspace);
      const navigation = html.match(/<nav\b[^>]*aria-label="稿件标签"[^>]*>(.*?)<\/nav>/)?.[1] ?? '';
      expect([...navigation.matchAll(/<button\b/g)]).toHaveLength(3);
      expect(navigation).toMatch(new RegExp(`aria-current="true"[^>]*>${label}`));
    }
    const oldChecks = design(`&design=${historyDraft.id}&version=2&tab=delivery&part=checks`, historyWorkspace);
    expect(oldChecks).toContain('data-item="steps"');
  });

  it('文件夹封面在首屏没有实拍时使用当前版本同主题的可用截图', () => {
    const overview = historyScreen('cover-overview', '封面首屏');
    const settings = historyScreen('cover-settings', '封面设置页');
    const version: DesignVersion = { ...second, screens: [overview, settings], renders: {
      [overview.id]: { dark: { id: 'fixture-cover-overview-dark', sha256: '4'.repeat(64) } },
      [settings.id]: { light: { id: 'fixture-cover-settings-light', sha256: '5'.repeat(64) } },
    } };
    const library = { ...workspace, designs: [{ ...bound, versions: [first, version] }] };
    const html = design('', library);
    const folder = html.match(/<button[^>]*class="dw-folder dw-surface"[^>]*>.*?<\/button>/)?.[0];

    expect(folder).toContain('/artifacts/fixture-cover-settings-light');
    expect(folder).not.toContain('fixture-cover-overview-dark');
    expect(folder).not.toContain('<iframe');
  });

  it('展示 V2 与登记基线 V1 的关系，当前稿只读时仍可回看基线', () => {
    const url = `&design=${historyDraft.id}&version=2`;
    const html = design(url, historyWorkspace);
    expect(html).toContain('V2 · 最新 · 基线 V1');
    expect(html).not.toContain('实现仍按基线');
    expect(html).toContain('aria-label="更多稿件操作"');
    const reader = design(url, { ...historyWorkspace, permissions: { ...workspace.permissions, review: false, steward: false } });
    expect(reader).not.toContain('data-action="freeze"');
    expect(reader).toContain('实施基线');
  });
});

function render(Page: ComponentType, url: string, input = workspace): string {
  vi.stubGlobal('document', { documentElement: { dataset: { theme: 'light' } } });
  vi.mocked(usePlanningRead).mockImplementation(endpoint => {
    if (endpoint === '/api/projects') return { loading: false, data: { projects: [{ id: projectId, name: '虚拟工程项目' }] } };
    if (endpoint?.split('?')[0] === `/api/projects/${projectId}/design`) return { loading: false, data: input };
    if (endpoint === `/api/projects/${projectId}/planning`) return { loading: false, data: board };
    if (endpoint === `/api/projects/${projectId}/planning?timeline=1`) {
      return { loading: false, data: { ...board, timeline: { debts: [], debtEvents: [] } } };
    }
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
  const page = await fixturePage(options);
  try {
    await page.route('**/*', routed => routed.abort());
    // Compile the AppShell utilities so the fixture measures the same workspace width as the application.
    await page.setContent(`<!doctype html><html data-theme="light"><head><meta name="viewport" content="width=device-width, initial-scale=1">
      <style>${css}</style></head><body><div id="root">${markup}</div></body></html>`);
    await check(page);
  } finally {
    await page.close();
  }
}

type RecordedDesignCommand = Record<string, unknown> & { type: string };
type FixtureView = { kind: 'library' } | { kind: 'brief'; designKey: string; sharedAt: string }
  | { kind: 'design'; designId: string; version: number; feedbackAt?: string };
const browserDesignOrigin = 'http://127.0.0.1:1';
let browserDesignScript: Promise<string> | undefined;

async function withDesignBrowser(input: () => DesignWorkspace,
  check: (page: Page, commands: RecordedDesignCommand[], views: FixtureView[]) => Promise<void>) {
  browserDesignScript ??= build({
    stdin: {
      contents: `import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { BrowserRouter } from 'react-router-dom';
        import { DesignWorkspacePage } from './src/pages/DesignWorkspacePage';
        createRoot(document.getElementById('root')).render(
          React.createElement(BrowserRouter, null, React.createElement(DesignWorkspacePage)));
      `,
      resolveDir: path.resolve('web'),
    },
    alias: { '@': path.resolve('web/src') },
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
    loader: { '.css': 'empty', '.svg': 'dataurl' }, jsx: 'automatic', bundle: true, write: false,
  }).then(result => result.outputFiles[0].text);
  const script = await browserDesignScript;
  const page = await fixturePage();
  try {
    page.setDefaultTimeout(8000);
    page.setDefaultNavigationTimeout(15_000);
    const commands: RecordedDesignCommand[] = [];
    const views: FixtureView[] = [];
    const viewer = structuredClone(input().viewer);
    const designPath = `/api/projects/${projectId}/design`;
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== browserDesignOrigin) return route.abort();
      if (url.pathname === '/fixture-design.js') return route.fulfill({ body: script, contentType: 'text/javascript' });
      if (url.pathname === '/design') return route.fulfill({ contentType: 'text/html', body:
        '<!doctype html><html data-theme="light"><body><div id="root"></div><script src="/fixture-design.js"></script></body></html>',
      });
      if (url.pathname === '/api/projects') {
        return route.fulfill({ json: { projects: [{ id: projectId, name: '虚拟工程项目' }] } });
      }
      if (url.pathname === designPath) return route.fulfill({ json: { ...input(), ...(viewer ? { viewer } : {}) } });
      if (url.pathname === `${designPath}/viewed` && viewer && route.request().method() === 'POST') {
        const view: FixtureView = route.request().postDataJSON();
        views.push(view);
        if (view.kind === 'brief') viewer.briefs[view.designKey] = view.sharedAt;
        if (view.kind === 'design') {
          const prior = viewer.designs[view.designId];
          viewer.designs[view.designId] = { version: Math.max(prior?.version ?? 0, view.version),
            feedbackAt: [prior?.feedbackAt ?? '', view.feedbackAt ?? ''].sort().at(-1) };
        }
        return route.fulfill({ json: { projectId, viewer } });
      }
      if ([`${designPath}/commands`, `${designPath}/feedback`].includes(url.pathname) && route.request().method() === 'POST') {
        commands.push(route.request().postDataJSON());
        return route.fulfill({ json: { projectId } });
      }
      return route.abort();
    });
    await check(page, commands, views);
  } finally {
    await page.close();
  }
}

function browserDesignUrl(params: Record<string, string> = {}) {
  return browserDesignOrigin + '/design?' + new URLSearchParams({ project: projectId, ...params });
}

const draftStyles = ['web/src/pages/engineering-planning/planning.css', 'web/src/pages/design-workspace/design.css',
  'web/src/pages/design-workspace/design-v17-delivery.css'];
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
const awaitingBrief: DesignRequirement = {
  designKey: 'settings/start-workspace', planId: 'PLN-fixture-brief', planVersion: 3, proposalId: 'PRO-fixture-brief',
  title: '待出稿的示例需求', requirements: '核对首次进入设置的空状态。', sharedAt: at, owner: author,
};
const publishedBrief: DesignRequirement = { ...awaitingBrief, designKey: 'settings/already-published', title: '已经出稿的示例需求' };
const viewerBeforeChanges: DesignViewerState = { firstVisitAt: '2026-11-16T00:00:00.000Z', designs: {}, briefs: {} };
const requirementWorkspace: DesignWorkspace = {
  ...libraryWorkspace,
  designs: libraryWorkspace.designs.map((draft, index) => index === 0 ? { ...draft, designKey: publishedBrief.designKey } : draft),
  requirements: [awaitingBrief, publishedBrief],
  viewer: viewerBeforeChanges,
};

async function measureDraftHeader(page: Page, title: string) {
  const header = page.locator('.dw-head--draft');
  const heading = header.getByRole('heading', { name: title, exact: true });
  const tabs = header.getByRole('navigation', { name: '稿件标签' });
  const controls = {
    heading,
    status: header.locator('.dw-status'),
    version: header.getByRole('combobox', { name: '稿件版本' }),
    screen: header.getByRole('button', { name: '大屏', exact: true }),
    information: header.getByLabel('更多稿件操作', { exact: true }),
  };
  async function box(name: string, locator: typeof heading) {
    const rect = await locator.boundingBox({ timeout: 900 });
    if (!rect) throw new Error(`稿件页头缺少可见控件 ${name}，宽度 ${page.viewportSize()?.width}`);
    return rect;
  }
  const [head, status, version, screen, information] = await Promise.all(
    Object.entries(controls).map(([name, locator]) => box(name, locator)),
  );
  const titleGroup = [head, status];
  const actionGroup = [version, screen, information];
  const headerBox = await box('页头', header);
  const tabsBox = await box('页签', tabs);
  const metrics = await header.evaluate(element => {
    const titleElement = element.querySelector('h1')!;
    const statusElement = element.querySelector('.dw-status')!;
    const tabsElement = element.querySelector<HTMLElement>('nav[aria-label="稿件标签"]')!;
    const versions = element.querySelector<HTMLSelectElement>('select[aria-label="稿件版本"]')!;
    const versionStyle = getComputedStyle(versions);
    const textMeter = document.createElement('canvas').getContext('2d')!;
    textMeter.font = `${versionStyle.fontWeight} ${versionStyle.fontSize} ${versionStyle.fontFamily}`;
    const labelWidth = Math.ceil(textMeter.measureText(versions.selectedOptions[0].textContent!.trim()).width);
    const versionTextWidth = Math.floor(versions.clientWidth - parseFloat(versionStyle.paddingLeft)
      - parseFloat(versionStyle.paddingRight) - 20);
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
      labelWidth, versionTextWidth,
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
  expect.soft(metrics.versionTextWidth, `${viewportWidth}px 完整显示版本和实施基线`).toBeGreaterThanOrEqual(metrics.labelWidth);
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
    const freeze = panel.querySelector<HTMLButtonElement>('footer button[data-action="freeze"]');
    const revoke = panel.querySelector<HTMLButtonElement>('footer button[data-action="unfreeze"]');
    return {
      width: panel.clientWidth, scrollWidth: panel.scrollWidth, clippedGroups,
      freeze: freeze && {
        ...measureLabel(freeze),
        lineGap: freeze.getBoundingClientRect().top - panel.querySelector('dl')!.getBoundingClientRect().bottom,
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
  it('A-30 桌面状态筛选标签与工具同排，窄屏组合筛选可读', async () => {
    const markup = design('&status=attention', libraryWorkspace);
    await withLayout(markup, [...draftStyles, 'web/src/pages/design-workspace/design-skills.css'], async page => {
      await page.setViewportSize({ width: 1280, height: 800 });
      const status = page.getByRole('combobox', { name: '状态', exact: true });
      const chip = page.getByRole('button', { name: /^清除 等[你我]处理$/u });
      expect(shareRow([(await status.boundingBox())!, (await chip.boundingBox())!])).toBe(true);
    });
    const combined = design(`&${new URLSearchParams({ status: 'review', tag, framework: frameworkId })}`, libraryWorkspace);
    await withLayout(combined, draftStyles, async page => {
      await page.setViewportSize({ width: 375, height: 812 });
      expect(await page.getByRole('button', { name: /^清除/ }).count()).toBe(3);
      expect((await measureDesignPage(page)).content).toBeLessThanOrEqual(375);
    });
  }, 15_000);

  it('库页搜索、筛选和动作在同排时保持对齐', async () => {
    await withLayout(design('', libraryWorkspace), [...draftStyles, 'web/src/pages/design-workspace/design-skills.css'], async page => {
      await page.getByRole('combobox', { name: '状态', exact: true }).waitFor();
      for (const width of [1280, 1024, 853]) {
        await page.setViewportSize({ width, height: 800 });
        const measurement = await measureDesignPage(page);
        const controls = await page.locator('.dw-library-bar .dw-tools > :is(label, select, button), .dw-library-bar .dw-tools > details > summary')
          .evaluateAll(elements => elements.map(element => ({
            control: element.getAttribute('aria-label') ?? element.tagName,
            box: [element.getBoundingClientRect().top, element.getBoundingClientRect().height],
          })));
        const evidence = `${width}px 同排控件 ${JSON.stringify(controls)}`;
        expect(measurement.headerAlignment, evidence).not.toBeNull();
        expect(measurement.headerAlignment!, evidence).toBeLessThanOrEqual(1);
      }
    });
  }, 15_000);

  it('弹窗打开后只测活动滚动区域，并检测弹窗内部的额外滚动', async () => {
    const page = await fixturePage();
    try {
      await page.setViewportSize({ width: 853, height: 533 });
      await page.setContent(`<style>.scroll { height: 100px; overflow-y: auto; } .long { height: 250px; }</style>
        <body data-scroll-locked="1">
          <main aria-hidden="true"><div class="scroll"><div class="long"></div></div>
            <aside class="scroll"><div class="long"></div></aside></main>
          <section class="scroll" role="dialog"><div class="long" id="extra"></div></section>
        </body>`);
      expect((await measureDesignPage(page)).vertical).toBe(1);
      await page.locator('#extra').evaluate(element => {
        element.className = 'scroll';
        (element as HTMLElement).style.height = '150px';
        element.innerHTML = '<div class="long"></div>';
      });
      expect((await measureDesignPage(page)).vertical).toBe(2);
    } finally {
      await page.close();
    }
  }, 10_000);

  it('旧 CLI 深链和用技能深链都可打开六环节指引，普通地址保持折叠', () => {
    function skillDrawer(html: string): string {
      return html.match(/<details\b[^>]*>\s*<summary\b[^>]*data-action="design-skills"[^>]*>[\s\S]*?<\/details>/)?.[0] ?? '';
    }
    const ordinary = skillDrawer(design());
    expect(ordinary).toContain('用技能');
    expect(ordinary).not.toMatch(/^<details\b[^>]*\sopen(?:=|[\s>])/);
    for (const panel of ['cli', 'skills']) {
      const shared = skillDrawer(design('&panel=' + panel));
      expect(shared).toContain('用 /cds 走完整个开发流程');
      expect(shared).toContain('接入 Agent');
      expect(shared).toMatch(/^<details\b[^>]*\sopen(?:=|[\s>])/);
    }
  });

  it('A-19 首页范围行进入项目框架，稿件卡保留绑定版本和可升级状态', async () => {
    const html = design();
    expect(text(html)).toContain(frameworkId);
    const cards = Array.from(html.matchAll(/<article\b[^>]*class="[^"]*\bdw-design-card\b[^"]*"[^>]*>([\s\S]*?)<\/article>/g), match => text(match[1]));
    const boundCard = cards.find(card => card.includes(boundTitle));
    expect(boundCard).toContain(frameworkId);
    expect(boundCard).toMatch(/(?:V|v)1\b/);
    expect(boundCard).toMatch(/可升级|落后|有新版本/);
    expect(cards.find(card => card.includes(unboundTitle))).toContain('未绑定框架');
    await withDesignBrowser(() => workspace, async page => {
      await page.goto(browserDesignUrl());
      const frameworks = page.locator('.dw-library-bar').getByRole('button', { name: '框架 1 套', exact: true });
      await frameworks.waitFor();
      expect(await page.getByRole('region', { name: '本项目框架' }).count()).toBe(0);
      await frameworks.click();
      await page.waitForURL(url => url.searchParams.get('view') === 'frameworks');
      const card = page.locator('.dw-framework-card');
      expect(await card.count()).toBe(1);
      expect(await card.innerText()).toContain(frameworkTitle);
      expect(await card.innerText()).toContain('2 份稿件使用');
    });
    const scope = { systemId: 'fixture-console', moduleId: 'settings' };
    const module = design(`&system=${scope.systemId}&module=${scope.moduleId}`, {
      ...workspace, designs: [{ ...bound, scope }], systems: [{ id: scope.systemId, name: '示例控制台',
        modules: [{ id: scope.moduleId, name: libraryFolder, framework: frameworkId }] }],
    });
    expect(module).toContain('aria-label="适用框架"');
    expect(visibleText(module)).toContain(frameworkTitle);
  }, 20_000);

  it('A-29 V3 设计库按最近更新、文件夹和框架排列，375px 不横向溢出', async () => {
    const withoutPending = { ...libraryWorkspace, designs: libraryWorkspace.designs.map(draft => ({ ...draft, reviewRequested: false })) };
    const empty = { ...withoutPending, designs: [], frameworks: [], requirements: [] };
    expect(visibleText(design('', empty))).toContain('此项目还没有稿件');
    await withLayout(design('', withoutPending), draftStyles, async page => {
      const first = page.locator('.dw-library > section').first();
      expect.soft(await first.getByRole('heading').innerText(), '有稿、没有待办时首页仍从待办空态开始').toMatch(/^等你处理(?:\s|$)/);
      expect.soft(await first.innerText()).toMatch(/(?:没有|暂无)[^。\n]*(?:处理|待办|事项)|全部处理完/);
      const recentTitle = page.getByRole('heading', { name: '最近更新', exact: true });
      const folderTitle = page.getByRole('heading', { name: /^文件夹/ });
      const recent = recentTitle.locator('xpath=ancestor::section[1]');
      const folders = folderTitle.locator('xpath=ancestor::section[1]');
      const frameworks = page.locator('.dw-library-bar').getByRole('button', { name: '框架 2 套', exact: true });
      expect.soft(await page.locator('.dw-side').count(), '库不再占用左侧范围栏').toBe(0);
      expect.soft(await recent.locator('.dw-card-title').allTextContents(), '最近更新按最新一版时间排序且只列四份').toEqual([
        '另一文件夹稿件', '其他分类稿件', '实现阶段稿件', '目标稿件',
      ]);
      const folderLabels = await folders.getByRole('button').allTextContents();
      expect.soft(folderLabels).toHaveLength(3);
      for (const group of [libraryFolder, otherFolder, '归档资料']) {
        expect.soft(folderLabels.filter(label => label.includes(group)), `${group} 文件夹卡片`).toHaveLength(1);
      }
      const rects = await Promise.all([frameworks, first, recent, folders].map(area => area.boundingBox({ timeout: 900 }).catch(() => null)));
      expect.soft(rects.every(Boolean), '范围入口、待办、最近更新和文件夹均可见').toBe(true);
      if (rects.every(box => box !== null)) {
        for (let i = 1; i < rects.length; i++) expect.soft(rects[i - 1].y).toBeLessThan(rects[i].y);
      }

      const overflow = await page.evaluate(() => ({
        viewport: innerWidth,
        root: document.documentElement.scrollWidth,
        layout: [...document.querySelectorAll<HTMLElement>('.dw-library, .dw-library-bar')]
          .filter(element => element.scrollWidth > element.clientWidth + 1).map(element => element.className),
        cardFacts: [...document.querySelectorAll<HTMLElement>('.dw-design-card footer > div > *')].flatMap(element => {
          if (!element.getClientRects().length) return [];
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

  it('A-29/A-32 设计库优先展示待处理事项，未出稿需求归到同模块文件夹且不重复列稿', async () => {
    const failedTitle = '实施基线验收未通过的合成稿';
    const failedDraft: DesignEntry = { ...layoutDraft, id: 'DSN-fixture-failed-baseline', pullRequest: 41,
      versions: layoutDraft.versions.map(version => ({ ...version, title: failedTitle })) };
    const input = { ...requirementWorkspace, designs: [
      ...requirementWorkspace.designs.map((draft, index) => ({ ...draft, reviewRequested: index === 0 })), failedDraft,
    ] };
    await withDesignBrowser(() => input, async (page, _commands, views) => {
      await page.goto(browserDesignUrl());
      const firstSection = page.locator('.dw-library > section').first();
      const pending = firstSection.getByRole('link', { name: new RegExp(awaitingBrief.title) });
      const recent = page.getByRole('heading', { name: '最近更新' }).locator('xpath=ancestor::section[1]');
      await recent.waitFor();
      expect.soft(await firstSection.getByRole('heading').innerText()).toMatch(/^等你处理(?:\s|$)/);
      expect.soft(await firstSection.innerText()).toContain('目标稿件');
      expect.soft(await pending.count(), '可发布的设计方从第一节直接进待出稿需求').toBe(1);
      if (await pending.count() === 1) {
        const href = new URL((await pending.getAttribute('href'))!, browserDesignOrigin);
        expect.soft(Object.fromEntries(href.searchParams)).toEqual({ project: projectId, brief: awaitingBrief.designKey });
      }
      expect.soft(await firstSection.innerText()).not.toContain(publishedBrief.title);
      const recentTitles = await recent.locator('.dw-card-title').allTextContents();
      expect.soft(recentTitles).toHaveLength(4);
      expect.soft(new Set(recentTitles).size).toBe(recentTitles.length);
      expect.soft(recentTitles).not.toContain('目标稿件');
      expect.soft(await page.locator('main').getByText(awaitingBrief.title, { exact: true }).count(), '需求没有在首页额外浮出一节').toBe(1);
      const folder = page.locator('.dw-folder').filter({ hasText: libraryFolder });
      expect.soft(await folder.innerText()).toContain('1 份待出稿');
      const badge = firstSection.getByText('新需求', { exact: true });
      expect.soft(await badge.isVisible()).toBe(true);
      if (await pending.count() === 1) {
        await pending.click();
        await page.getByRole('heading', { name: awaitingBrief.title }).waitFor();
        await expect.poll(() => views.find(view => view.kind === 'brief')).toEqual({
          kind: 'brief', designKey: awaitingBrief.designKey, sharedAt: awaitingBrief.sharedAt,
        });
        await page.goto(browserDesignUrl());
        await pending.waitFor();
        expect(await badge.isVisible()).toBe(false);
      }

      const failedCard = firstSection.getByRole('article').filter({ hasText: failedTitle });
      const failure = failedCard.getByRole('link', { name: '打开稿件 ' + failedTitle, exact: true });
      expect.soft(await failure.count(), '已续版的稿件仍把实施基线验收失败放在待办图卡').toBe(1);
      if (await failure.count() === 1) {
        expect.soft(await failedCard.innerText()).not.toMatch(/\d+\s+不通过/);
        const title = failedCard.getByRole('link', { name: failedTitle, exact: true });
        expect(await failure.getAttribute('href')).toBe(await title.getAttribute('href'));
        await title.click();
        await page.waitForURL(url => url.searchParams.get('design') === failedDraft.id && url.searchParams.get('tab') === 'accept');
        expect(new URL(page.url()).searchParams.get('version')).toBe('2');
        expect(await page.getByRole('combobox', { name: '稿件版本' }).inputValue()).toBe('2');
        expect(await page.getByRole('button', { name: /^验收/ }).getAttribute('aria-current')).toBe('true');
        expect(await page.locator('.dw-ac-steps').getByText(/PR #41 · 提交/).isVisible()).toBe(true);
      }

      await page.goto(browserDesignUrl({ group: libraryFolder }));
      await page.locator('.dw-library > section').first().waitFor();
      expect.soft(await firstSection.getByRole('heading').innerText()).toMatch(/^待出稿\s*1/);
      expect.soft(await firstSection.getByRole('link', { name: new RegExp(awaitingBrief.title) }).count()).toBe(1);
      expect.soft(await firstSection.innerText()).not.toContain(publishedBrief.title);
    });
  }, 20_000);

  it('A-33 无稿需求提供回原文件夹和开始出稿，撤回从页尾经二次确认', async () => {
    let input = requirementWorkspace;
    await withDesignBrowser(() => input, async (page, commands) => {
      await page.goto(browserDesignUrl({ brief: awaitingBrief.designKey }));
      const brief = page.locator('.dw-brief');
      const heading = brief.getByRole('heading', { name: awaitingBrief.title });
      await heading.waitFor();
      const nav = page.getByRole('navigation', { name: '位置' }).locator('.dw-crumb-desktop');
      const parent = nav.getByRole('link', { name: libraryFolder });
      expect.soft(await nav.getByRole('link', { name: '设计', exact: true }).count()).toBe(1);
      expect.soft(await parent.count()).toBe(1);
      if (await parent.count() === 1) {
        const href = new URL((await parent.getAttribute('href'))!, browserDesignOrigin);
        expect.soft(Object.fromEntries(href.searchParams)).toEqual({ project: projectId, group: libraryFolder });
      }
      const facts = brief.locator('dl');
      expect.soft((await facts.allTextContents()).join(' '), '交接人和认领的出稿人应分开')
        .toMatch(/所属[\s\S]*项目设置[\s\S]*交接[\s\S]*11月20日[\s\S]*出稿[\s\S]*等设计方认领/);
      const source = new URL((await brief.getByRole('link', { name: /原计划|来源计划/ }).getAttribute('href'))!, browserDesignOrigin);
      expect.soft(source.pathname).toBe('/engineering-planning');
      expect.soft(Object.fromEntries(source.searchParams)).toEqual({ project: projectId, kind: 'plan', item: awaitingBrief.planId });
      const start = heading.locator('xpath=ancestor::header[1]').getByText('开始出稿', { exact: true });
      expect.soft(await start.isVisible(), '开始出稿是未发布需求的主动作').toBe(true);
      if (await start.isVisible()) {
        await start.click();
        const cli = await brief.locator('code:visible').allTextContents();
        expect.soft(cli.some(line => /^cdscli design intake\b/.test(line))).toBe(true);
        const publish = cli.find(line => /^cdscli design publish\b/.test(line));
        expect.soft(publish).toMatch(/--private\b/);
        expect.soft(publish).toMatch(/--intent\s+create/);
        expect.soft(publish).toContain(`--design-key ${awaitingBrief.designKey}`);
        expect.soft(commands, '打开命令说明不会写数据').toEqual([]);
      }

      const revoke = brief.getByRole('button', { name: /^撤回需求交接/ });
      expect.soft(await revoke.locator('xpath=ancestor::footer[1]').count()).toBe(1);
      await revoke.click();
      expect(commands).toEqual([]);
      await page.getByRole('button', { name: '取消', exact: true }).click();
      expect(commands).toEqual([]);
      await revoke.click();
      await page.getByRole('button', { name: '确认撤回', exact: true }).click();
      await expect.poll(() => commands.length).toBe(1);
      expect(commands[0]).toMatchObject({ type: 'brief.revoke', designKey: awaitingBrief.designKey,
        planId: awaitingBrief.planId, expectedVersion: awaitingBrief.planVersion, requestId: expect.any(String) });

      await page.goto(browserDesignUrl({ brief: publishedBrief.designKey }));
      await brief.getByRole('link', { name: '查看稿件' }).waitFor();
      expect(await brief.getByText('开始出稿', { exact: true }).isVisible()).toBe(false);
      input = { ...requirementWorkspace, permissions: { ...requirementWorkspace.permissions, write: false, steward: false } };
      await page.goto(browserDesignUrl({ brief: awaitingBrief.designKey }));
      await heading.waitFor();
      expect(await start.isVisible()).toBe(false);
      expect(await revoke.isVisible()).toBe(false);
      await page.goto(browserDesignUrl({ group: libraryFolder }));
      await page.getByRole('link', { name: new RegExp(awaitingBrief.title) }).waitFor();
    });
  }, 20_000);

  it('A-33 已采用框架的出稿命令可复制，未采用时先指引查看接入清单', () => {
    const scope = { systemId: 'fixture-console', moduleId: 'settings' };
    const requirement: DesignRequirement = { ...awaitingBrief, scope, title: "核对 O'Neil 的设计 $DRAFT_NAME" };
    const module = { id: scope.moduleId, name: libraryFolder };
    const withFramework: DesignWorkspace = { ...workspace, requirements: [requirement], systems: [
      { id: scope.systemId, name: '示例控制台', modules: [{ ...module, framework: frameworkId }] },
    ] };
    const query = '&' + new URLSearchParams({ brief: requirement.designKey, panel: 'brief-start' });
    const markup = design(query, withFramework);
    const scaffold = markup.match(/<code>\s*(cdscli design scaffold\b[^<]+)<\/code>/)?.[1]
      .replaceAll('&#x27;', "'").replaceAll('&quot;', '"');
    expect.soft(scaffold).toMatch(/^cdscli design scaffold\b.*--framework FW-fixture\b.*--framework-version 2\b.*--dir \S+/);
    expect.soft(["'核对 O'\\''Neil 的设计 $DRAFT_NAME'", `'核对 O'"'"'Neil 的设计 $DRAFT_NAME'`], '单引号保护撇号、空格和美元符号')
      .toContain(scaffold?.split(' --title ').at(-1));

    const withoutFramework = { ...withFramework, systems: [{ id: scope.systemId, name: '示例控制台', modules: [module] }] };
    const steps = visibleText(design(query, withoutFramework));
    const intakeAt = steps.indexOf('cdscli design intake');
    const scaffoldAt = steps.indexOf('cdscli design scaffold');
    expect(intakeAt).toBeGreaterThanOrEqual(0);
    expect(scaffoldAt).toBeGreaterThan(intakeAt);
    expect(steps.slice(intakeAt, scaffoldAt)).toMatch(/接入清单[^\n]*(?:采用框架|采用.*框架)/);
  });

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
    expect.soft(headings(folderOnly).some(heading => heading.startsWith('设计中'))).toBe(true);
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
      id: 'DSN-fixture-framework-example', projectId, comments: [], runs: [],
      versions: [{ ...first, title: '框架使用示意', group: '框架资料' }],
    };
    const reviewTitle = '旧版被引作示意的普通稿最新待评审';
    const active: DesignEntry = { ...bound, reviewRequested: true, versions: [first, second,
      { ...second, version: 3 }, { ...second, version: 4, title: reviewTitle }] };
    const framework = workspace.frameworks[0];
    const revision = framework.versions.at(-1)!;
    const charter = {
      status: 'adopted' as const, intent: '约定控制台常用控件', problems: ['控件排列不一致'], nonGoals: ['业务流程'],
      scope: { system: '合成系统', modules: ['设置'] }, owner: author.label,
    };
    const input: DesignWorkspace = {
      ...workspace, designs: [example, active, latestBound, unbound],
      frameworks: [{ ...framework, versions: [
        { ...framework.versions[0], charter: { ...charter, example: { designId: active.id, version: 2 } } },
        { ...revision, charter: { ...charter, example: { designId: example.id, version: 1 } } },
      ] }],
    };
    const home = design('', input);
    expect(visibleText(home)).toContain('框架 1 套');
    expect(visibleText(home)).not.toContain('框架使用示意');
    const pending = home.match(/<section\b[^>]*aria-label="等你处理"[^>]*>([\s\S]*?)<\/section>/)?.[1] ?? '';
    expect(text(pending)).toContain(reviewTitle);
    expect(text(pending)).toContain('新 V4');
    const frameworks = design('&view=frameworks', input);
    expect([...frameworks.matchAll(/\bdw-framework-card\b/g)]).toHaveLength(1);
    expect(visibleText(frameworks)).toContain('2 份稿件使用');
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
    expect(visible).toContain('V2 · 最新 · 基线 V1');
    expect(html).toContain(frameworkId);
    expect(html).toContain('aria-label="稿件标签"');
    expect(html).toContain('aria-label="稿件分类"');
    expect(html).toContain(`#${tag}`);
    expect(visible).not.toContain('实现仍按基线');
    expect(html).toContain('data-action="freeze"');
  });

  it('A-12 有权限时在当前文件区域展示反馈入口', () => {
    const route = `&design=${bound.id}&version=2&tab=delivery&part=files&file=artifact-doc`;
    const html = design(route);
    const fileHeader = html.match(/<header\b[^>]*class="dw-dl-detail-head dw-dl-reader-head"[^>]*>([\s\S]*?)<\/header>/)?.[1];
    expect(text(fileHeader ?? '')).toContain(deliveryPath);
    expect(text(fileHeader ?? '')).toContain('对这个文件提反馈');
    const readOnly = { ...workspace, permissions: { ...workspace.permissions, feedback: false, write: false } };
    expect(visibleText(design(route, readOnly))).not.toContain('对这个文件提反馈');
  });

  it('A-40 对文件的反馈带当前版路径，保存诉求和验收标准', async () => {
    await withDesignBrowser(() => workspace, async (page, commands) => {
      await page.goto(browserDesignUrl({ design: bound.id, version: '2', tab: 'delivery', part: 'files', file: 'artifact-doc' }));
      await page.getByRole('button', { name: '对这个文件提反馈' }).click();
      const form = page.locator('.dw-dl-detail form');
      await form.locator('textarea[name="ask"]').fill('可以直接读到交付说明的结尾');
      await form.locator('textarea[name="done"]').fill('下一段打开后看到文档尾注');
      await form.getByRole('button', { name: '提交反馈' }).click();
      await expect.poll(() => commands.length).toBe(1);
      expect(commands[0]).toMatchObject({
        type: 'feedback.create', designId: bound.id, version: 2, filePath: deliveryPath,
        body: '## 诉求\n\n可以直接读到交付说明的结尾\n\n## 怎么算解决\n\n下一段打开后看到文档尾注',
      });
    });
  }, 15_000);

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
      expect(Object.fromEntries(historicalDelivery.searchParams)).toEqual({ ...draftParams, version: '1', tab: 'delivery', full: 'delivery', part: 'feedback' });
      expect(historicalDelivery.hash).toBe('#dw-delivery-feedback');
      await renderAddress(historicalDelivery);
      for (const viewed of [1, 2]) {
        if (viewed === 2) await renderAddress(new URL('/design?' + new URLSearchParams({ ...draftParams, tab: 'delivery' }), origin));
        expect(await version.inputValue()).toBe(String(viewed));
        for (const thread of [previousFeedback, currentFeedback]) {
          await renderAddress(new URL('/design?' + new URLSearchParams({ ...draftParams, version: String(viewed),
            tab: 'delivery', part: 'feedback', fb: thread.id }), origin));
          const item = page.locator('.dw-dl-detail');
          expect(await item.count()).toBe(1);
          expect(await item.getByRole('button', { name: `V${thread.version} 资料`, exact: true }).isVisible()).toBe(true);
          expect(await item.getByText(thread.body, { exact: true }).isVisible()).toBe(true);
          if (thread.replies.length) expect(await item.getByText(thread.replies[0].body, { exact: true }).isVisible()).toBe(true);
        }
      }
    });
  }, 30_000);

  it('跨版交付只把未关闭反馈计入待办，打开交付才清除新反馈，旧版的新回复可再次提示', async () => {
    const closed: DesignFeedback = { ...previousFeedback, id: 'FDB-fixture-closed', title: '已经处理的旧版反馈',
      body: '可回读的已处理反馈原文', status: 'closed', replies: [], decisions: [
        { decision: 'close', body: '已按原版画面复核关闭', author, at: '2026-11-21T00:00:00.000Z' },
      ] };
    let feedback = [previousFeedback, currentFeedback, closed];
    const seen = { ...viewerBeforeChanges, designs: { [historyDraft.id]: { version: 2 } } };
    await withDesignBrowser(() => ({ ...historyWorkspace, viewer: seen, designs: [{ ...historyDraft, feedback }] }), async page => {
      const newFeedback = page.locator('.dw-design-card').filter({ hasText: boundTitle }).getByRole('link', { name: '新反馈' });
      const draftPath = { design: historyDraft.id };
      await page.goto(browserDesignUrl());
      await newFeedback.waitFor();
      await page.goto(browserDesignUrl({ ...draftPath, version: '1' }));
      await page.getByRole('heading', { name: boundTitle }).waitFor();
      await page.goto(browserDesignUrl());
      await newFeedback.click();
      await page.waitForURL(url => url.searchParams.get('tab') === 'delivery');
      const list = page.locator('[aria-label="反馈列表"]');
      const detail = page.locator('.dw-dl-detail');
      expect(await list.innerText()).toContain('待处理 2');
      for (const thread of [previousFeedback, currentFeedback]) {
        await list.getByRole('button', { name: new RegExp(thread.title) }).click();
        expect(await detail.getByText(thread.body, { exact: true }).isVisible()).toBe(true);
        expect(await detail.count()).toBe(1);
      }
      await list.getByRole('button', { name: '全部 3', exact: true }).click();
      await list.getByRole('button', { name: new RegExp(closed.title) }).click();
      expect(await detail.getByText(closed.decisions[0].body, { exact: true }).isVisible()).toBe(true);

      await page.goto(browserDesignUrl());
      await page.locator('.dw-design-card').filter({ hasText: boundTitle }).waitFor();
      await expect.poll(() => newFeedback.count()).toBe(0);
      const reply = '旧版反馈在打开交付后收到的新回复';
      feedback = [{ ...previousFeedback, replies: [...previousFeedback.replies,
        { author, at: '2026-11-22T00:00:00.000Z', body: reply }] }, currentFeedback, closed];
      await page.reload();
      await newFeedback.click();
      await list.getByRole('button', { name: new RegExp(previousFeedback.title) }).click();
      await detail.getByText(reply, { exact: true }).waitFor();
      expect(await page.getByRole('combobox', { name: '稿件版本' }).inputValue()).toBe('2');
      expect(await list.innerText()).toContain('待处理 2');
    });
  }, 20_000);

  it('A-03 稿件页头的标题、页签和操作可达', async () => {
    for (const version of [4, 2]) {
      const markup = design(`&design=${layoutDraft.id}&version=${version}&tab=preview`, { ...workspace, designs: [layoutDraft] });
      await withLayout(markup, draftStyles, async page => {
        for (const [width, height] of desktopSizes) {
          await page.setViewportSize({ width, height });
          const metrics = await measureDraftHeader(page, boundTitle);
          const description = `${width}px V${version}`;
          checkDraftBounds(metrics, width);
          expect.soft(shareRow(metrics.titleGroup), `${description} 标题和状态同排`).toBe(true);
          expect.soft(shareRow(metrics.actionGroup), `${description} 版本和操作同排`).toBe(true);
          expect.soft(metrics.tabsBox.y, `${description} 标签位于标题下方`)
            .toBeGreaterThanOrEqual(Math.max(...metrics.titleGroup.map(box => box.y + box.height)) - 1);
          expect.soft(metrics.headerBox.height, `${description} 页头总高`).toBeLessThanOrEqual(100);
          if (version === 4) {
            expect.soft(await page.getByRole('button', { name: '定为实施基线', exact: true }).count(), `${description} 页头没有常驻定基线动作`).toBe(0);
          }
        }
      });
    }
  }, 15_000);

  it('A-26 长稿名保持单行并保留操作与全名提示', async () => {
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
        expect.soft(shareRow(metrics.actionGroup), `${width}px 长标题不挤掉动作组`).toBe(true);
        if (width === 1280) {
          expect.soft(metrics.titleMeasured, '1280px 长标题需完整看到').toBeLessThanOrEqual(metrics.titleAvailable + 1);
        } else {
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
      const trigger = page.getByLabel('更多稿件操作', { exact: true });
      await trigger.click();
      const info = trigger.locator('xpath=..');
      expect(await info.locator('dt').filter({ hasText: /^基线$/ }).isVisible()).toBe(true);
      expect(await info.getByRole('button', { name: '定为实施基线', exact: true }).isVisible()).toBe(true);
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

  it('A-35 定实施基线须确认旧验收留存、续版不移动基线和记入记录，且确认前不发送命令', async () => {
    const input = { ...workspace, designs: [layoutDraft] };
    await withDesignBrowser(() => input, async (page, commands) => {
      const version = page.getByRole('combobox', { name: '稿件版本' });
      await page.goto(browserDesignUrl({ design: layoutDraft.id }));
      await version.waitFor();
      expect(await version.inputValue()).toBe('4');
      await page.getByRole('button', { name: '对比', exact: true }).click();
      const left = page.getByRole('combobox', { name: '对比左侧版本' });
      const baselineShortcut = page.getByRole('button', { name: '和基线 V2 对比', exact: true });
      expect(await left.inputValue()).toBe('2');
      expect(await baselineShortcut.count()).toBe(0);
      await left.selectOption('3');
      await baselineShortcut.click();
      await page.waitForURL(url => url.searchParams.get('compareFrom') === '2');
      expect(await left.inputValue()).toBe('2');
      expect(await page.getByRole('combobox', { name: '对比右侧版本' }).inputValue()).toBe('4');
      expect(await baselineShortcut.count()).toBe(0);
      const action = page.getByRole('button', { name: /^定为实施基线(?:[.…]+)?$/ });
      const info = page.getByLabel('更多稿件操作', { exact: true });
      const modal = page.getByRole('dialog', { name: /V4.*定为实施基线/ });
      expect(await action.isVisible()).toBe(false);
      await info.click();
      await action.click();
      await modal.waitFor();
      const consequences = await modal.innerText();
      expect.soft(consequences, '明确从实施基线 V2 改到 V4').toMatch(/实施基线[^。\n]*V2[^。\n]*V4/);
      expect.soft(consequences, '明确旧基线及其验收和签收保留').toMatch(/(?:原基线|V2)[^。\n]*验收[^。\n]*签收[^。\n]*保留/);
      expect.soft(consequences, '明确普通续版不会更改当前实施基线').toMatch(/(?:新版本|续版)[^。\n]*(?:不会|不)[^。\n]*(?:改变|移动|变更|自动更新)[^。\n]*基线/);
      expect.soft(consequences, '明确此次定稿写入记录').toMatch(/定稿[^。\n]*(?:记入|写入|记录)[^。\n]*(?:稿件记录|版本记录|谁)/);
      expect(commands).toEqual([]);
      await modal.getByRole('button', { name: '取消', exact: true }).click();
      await modal.waitFor({ state: 'hidden' });
      expect(await page.getByRole('combobox', { name: '对比左侧版本' }).inputValue()).toBe('2');
      expect(commands).toEqual([]);
      if (!(await action.isVisible())) await info.click();
      await action.click();
      await modal.getByRole('button', { name: /^确认.*实施基线$/ }).click();
      await expect.poll(() => commands.length).toBe(1);
      expect(commands[0]).toMatchObject({ type: 'design.freeze', designId: layoutDraft.id, version: 4, requestId: expect.any(String) });
    });
  }, 20_000);

  it('A-27 稿件信息有具名分组，危险操作在底部靠右，缩窄后仍在视口内', async () => {
    const entry: DesignEntry = {
      ...layoutDraft,
      versions: layoutDraft.versions.map(version => ({ ...version, sourceVerification: 'git' })),
    };
    const markup = design(`&design=${entry.id}&version=2&tab=preview`, { ...workspace, designs: [entry] });
    await withLayout(markup, draftStyles, async page => {
      await page.setViewportSize({ width: 1280, height: 800 });
      expect(await page.locator('.dw-draft-heading').innerText()).not.toContain('可升级到');
      const info = page.getByLabel('更多稿件操作', { exact: true });
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

  it('A-28 在 375px 触控视口可操作三个页签，无横向滚动', async () => {
    const markup = design(`&design=${layoutDraft.id}&version=4&tab=preview`, { ...workspace, designs: [layoutDraft] });
    await withLayout(markup, draftStyles, async page => {
      const metrics = await measureDraftHeader(page, boundTitle);
      checkDraftBounds(metrics, 375);
      expect(metrics.touchPoints, '使用 375px 触控视口').toBeGreaterThan(0);
      expect.soft(shareRow(metrics.titleGroup), '手机标题组各项同排').toBe(true);
      expect.soft(shareRow(metrics.actionGroup), '手机动作组各项同排').toBe(true);
      const titleBottom = Math.max(...metrics.titleGroup.map(box => box.y + box.height));
      const actionsTop = Math.min(...metrics.actionGroup.map(box => box.y));
      const actionsBottom = Math.max(...metrics.actionGroup.map(box => box.y + box.height));
      expect.soft(actionsTop, '稿件动作另起一行，位于标题下方').toBeGreaterThanOrEqual(titleBottom);
      expect.soft(metrics.tabsBox.y, '页签位于稿件动作下方').toBeGreaterThanOrEqual(actionsBottom);
      expect.soft(metrics.titleAvailable, '手机标题完整可读').toBeGreaterThanOrEqual(metrics.titleMeasured - 1);
      expect.soft(actionsTop - metrics.headerBox.y, '手机动作顶部与稿件参考的距离').toBeCloseTo(32, 0);
      expect.soft(metrics.tabsBox.y - metrics.headerBox.y, '手机页签顶部与稿件参考的距离').toBeCloseTo(66, 0);
      expect.soft(metrics.actionGroup[0].x, '版本选择位于手机动作行左侧').toBeCloseTo(metrics.headerBox.x, 0);
      expect.soft(metrics.information.x + metrics.information.width, '手机稿件信息位于动作行右侧')
        .toBeGreaterThanOrEqual(metrics.headerBox.x + metrics.headerBox.width - 6);
      expect.soft(metrics.tabOverflow, '三个页签完整可见').toBeLessThanOrEqual(1);
      const more = page.getByLabel('更多稿件操作', { exact: true });
      expect(await page.getByRole('button', { name: '定为实施基线', exact: true }).isVisible()).toBe(false);
      await more.click();
      expect(await page.getByRole('button', { name: '定为实施基线', exact: true }).isVisible()).toBe(true);
    }, { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  }, 15_000);

  it('A-02/A-23 等效缩放和手机看板左缘、整页宽度与页面动作可达', async () => {
    const markup = render(EngineeringPlanningPage, `/engineering-planning?project=${projectId}&view=plan`);
    expect(markup).toContain('用于窄屏回归的推进计划');
    await withLayout(markup, [
      'web/src/pages/engineering-planning/planning.css',
      'web/src/pages/engineering-planning/planning-shell.css',
      'web/src/pages/engineering-planning/planning-decision.css',
      'web/src/pages/engineering-planning/planning-timeline.css',
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

  it('A-31 原型或旧响应只有上次访问时间时仍能区分新旧稿、需求及反馈', () => {
    const older = libraryDraft('legacy-viewed', '较早发布的示例稿', libraryFolder, 17, {}, false);
    const newer = libraryDraft('legacy-unread', '最近发布的示例稿', libraryFolder, 20, {}, false);
    const earlier = '2026-11-17T00:00:00.000Z';
    const staleBrief = { ...awaitingBrief, designKey: 'settings/earlier-reference', title: '上次访问前的示例需求', sharedAt: earlier };
    const html = design('', {
      ...workspace,
      designs: [{ ...older, feedback: [{ ...currentFeedback, createdAt: earlier }] }, { ...newer, feedback: [currentFeedback] }],
      requirements: [staleBrief, awaitingBrief],
      viewer: { lastVisitAt: '2026-11-18T00:00:00.000Z' } as DesignViewerState,
    });
    const cards = [...html.matchAll(/<article\b[^>]*class="[^"]*\bdw-design-card\b[^"]*"[^>]*>([\s\S]*?)<\/article>/g)]
      .map(([, card]) => text(card));
    const olderCard = cards.find(card => card.includes(older.versions.at(-1)!.title));
    const newerCard = cards.find(card => card.includes(newer.versions.at(-1)!.title));
    expect(olderCard).toBeDefined();
    expect(olderCard).not.toMatch(/新 V|新稿|新反馈/);
    expect(newerCard).toContain('新 V2');
    expect(newerCard).not.toContain('新反馈');

    const briefRows = [...html.matchAll(/<a\b[^>]*href="[^"]*\bbrief=[^"]+"[^>]*>([\s\S]*?)<\/a>/g)]
      .map(([, row]) => text(row));
    const staleRow = briefRows.find(row => row.includes(staleBrief.title));
    expect(staleRow).toBeDefined();
    expect(staleRow).not.toContain('新需求');
    expect(briefRows.find(row => row.includes(awaitingBrief.title))).toContain('新需求');
  });
});
