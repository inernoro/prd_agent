import { createRequire } from 'node:module';
import path from 'node:path';
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesignCell, DesignEntry, DesignRequirement, DesignRun, DesignVersion } from '../../src/shared/design-workspace';
import { DesignAcceptancePanel } from '../../web/src/pages/design-workspace/DesignAcceptancePanel';
import { usePlanningRead } from '../../web/src/pages/engineering-planning/planning-ui';

vi.mock('../../web/src/pages/engineering-planning/planning-ui', async importOriginal => ({
  ...await importOriginal<typeof import('../../web/src/pages/engineering-planning/planning-ui')>(),
  usePlanningRead: vi.fn(),
}));

const { MemoryRouter } = createRequire(path.resolve('web/package.json'))('react-router-dom') as {
  MemoryRouter: ComponentType<{ initialEntries: string[]; children: React.ReactNode }>;
};
const at = '2026-11-24T10:00:00Z';
const version: DesignVersion = {
  version: 17, title: '工作区验收', sourceCommit: 'b'.repeat(40), sha256: 'f'.repeat(64),
  prototypeId: 'fixture-prototype', createdAt: at, publisher: { id: 'designer', label: '设计方' },
  acceptanceMode: 'objective',
  screens: [{ id: 'screen-focus', name: '列表', route: '#/list', viewport: 'desktop', themes: ['light'], impl: '/list' }],
  acceptance: [{ id: 'A-01', rule: '选择项目', how: 'measure', priority: 'high', slots: ['desktop-light'], screenId: 'screen-focus', requirementRef: '1' }],
  rationale: '', spec: {}, tags: [], decisionIds: [], resolves: {},
};
const run: DesignRun = { id: 'RUN-active', version: 17, pullRequest: 2, commit: 'a'.repeat(40), createdAt: at,
  cells: [{ itemId: 'A-01', slot: 'desktop-light', status: 'failed', actual: '列表错位' }],
  verdict: 'failed', previewUrl: 'https://preview.test', issues: {} };
const entry: DesignEntry = { id: 'DSN-fixture', projectId: 'fixture', versions: [version], comments: [], runs: [run], frozen: 17, pullRequest: 2 };
const requirement: DesignRequirement = { designKey: 'fixture/design', planId: 'PLN-fixture', planVersion: 1, proposalId: 'PRO-fixture',
  title: '测试需求', sharedAt: at, requirements: '## 业务规则与验收\n\n1. 列表可选择项目\n2. 项目之间权限隔离' };

function page(check = '', draft: DesignEntry = entry, selected = version, installedAcceptance = false) {
  return renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: [`/design?tab=accept${check ? `&check=${check}` : ''}`],
    children: createElement(DesignAcceptancePanel, { entry: draft, version: selected, busy: false, canWrite: true,
      canReview: true, canSign: true, command: async () => true, onPreviewStale: () => {}, onOpen: () => {}, requirement, installedAcceptance }) }));
}

describe('V17 项目验收界面', () => {
  beforeEach(() => vi.mocked(usePlanningRead).mockReturnValue({ loading: false, data: { projectId: 'fixture', commit: 'c'.repeat(40), url: run.previewUrl } } as never));

  it('根因优先，随后追溯条款、画面、方法、下一步', () => {
    const html = page();
    const sections = [...html.matchAll(/<li\b[^>]*data-item="([^"]+)"/g)].map(match => match[1]);
    expect(sections.slice(0, 5)).toEqual(['verdict', 'trace', 'by-screen', 'methods', 'steps']);
    expect(html.indexOf('data-tone="block"')).toBeLessThan(html.indexOf('data-tone="fail"'));
    expect(html).toContain('data-check="regress"');
    expect(html).toContain('1 条需求没有关联验收项');
    expect(html).toContain('谁执行');
  });

  it('未启用的冒烟提供启用、做法和示例入口，没有伪造结果', () => {
    const html = page('smoke');
    expect(html).toContain('未启用');
    expect(html).toContain('data-action="enable-method"');
    expect(html).toContain('data-action="show-demo"');
    expect(html).toContain('通过标准');
    expect(html).not.toContain('data-item="smoke-details"');
  });

  it('历史版本保留八个 V11 入口', () => {
    const historical = { ...version, version: 11, acceptanceMode: undefined, acceptancePlan: {} };
    const html = page('', { ...entry, versions: [historical, version], frozen: 11 }, historical);
    expect([...html.matchAll(/role="tab"/g)]).toHaveLength(8);
    expect(html).not.toContain('data-check="regress"');
  });

  it('刷新地址可直接打开同一个示例和指定画面对照', () => {
    expect(page('flow&demo=flow')).toMatch(/data-action="show-demo"[^>]*aria-expanded="true"/);
    expect(page('flow&demo=visual')).toMatch(/data-action="show-demo"[^>]*aria-expanded="false"/);
    const comparison = page('compare&compare-screen=screen-focus&compare-slot=desktop-light');
    expect(comparison).toMatch(/data-action="visual-open"[^>]*aria-expanded="true"/);
    expect(page('compare&compare-screen=unknown')).not.toMatch(/data-action="visual-open"[^>]*aria-expanded="true"/);
  });

  it('主用运行以正式构建核对，没有空 PR', () => {
    const installedRun: DesignRun = { ...run, pullRequest: undefined, target: 'installed' };
    const html = page('', { ...entry, runs: [installedRun] }, version, true);
    expect(usePlanningRead).toHaveBeenCalledWith('/api/projects/fixture/design/installed', 0);
    expect(html).toContain('主用 CDS');
    expect(html).not.toContain('PR #undefined');
  });
});

describe('V22 A-64 验收概览', () => {
  it('旧提交优先，按原因归并大量待补项，卡片只展示摘要、负责方和一个处理动作', () => {
    const measurements = Array.from({ length: 23 }, (_, index) => `页头宽 ${1154.4375 + index} px`);
    const scenarios: Pick<DesignCell, 'status' | 'actual'>[] = [
      ...measurements.map(actual => ({ status: 'unverified' as const, actual })),
      { status: 'missing', actual: '正式站没有这种状态：新建计划待确认' },
      { status: 'missing', actual: '正式站没有这种状态：稿件有待回复的评论' },
      { status: 'missing', actual: '验收规则冲突：页头上限有两种写法' },
      { status: 'failed', actual: '移动画布被右栏遮挡' },
      { status: 'passed', actual: '页面成功打开' },
    ];
    const latest: DesignVersion = {
      ...version, version: 22,
      acceptance: scenarios.map((_, index) => ({ ...version.acceptance[0], id: `A-${String(index + 1).padStart(2, '0')}` })),
      videos: [{ page: 'accept', file: 'videos/methods.mp4', artifactId: 'fixture-video', title: '验收方法演示', chapters: [] }],
    };
    const recentRun: DesignRun = { ...run, version: 22, verdict: 'needs_evidence', cells: latest.acceptance.map((rule, index) => ({
      ...scenarios[index], itemId: rule.id, slot: 'desktop-light',
    })) };
    vi.mocked(usePlanningRead).mockReturnValue({ loading: false, data: { projectId: 'fixture', commit: 'c'.repeat(40), url: run.previewUrl } } as never);
    const html = page('', { ...entry, frozen: 22, versions: [latest], runs: [recentRun] }, latest);
    const hero = /<div class="dw-ac-hero">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? '';
    for (const text of ['暂不能签收', '验收项 28', '通过 1', '不通过 1', '缺证据 26']) expect(hero).toContain(text);
    const causeList = /<ol class="dw-ac-causes[^"]*"[^>]*>([\s\S]*?)<\/ol>/.exec(html)?.[1] ?? '';
    const cards = causeList.split(/(?=<li\b[^>]*data-tone=)/).filter(Boolean);

    expect(cards.length).toBeGreaterThan(0);
    expect(cards.length).toBeLessThanOrEqual(6);
    expect(cards[0]).toContain('重新运行');
    expect(cards.find(card => card.includes('用演示数据截'))).toContain('实现方');
    expect(cards.find(card => card.includes('补证据'))).toContain('实现方');
    expect(cards.find(card => card.includes('看冲突'))).toContain('设计方');
    for (const card of cards) {
      const folded = /<details\b[^>]*>[\s\S]*?<\/details>/.exec(card)?.[0] ?? '';
      expect(folded).toContain('看清单');
      expect(folded).not.toMatch(/<details\b[^>]*\bopen\b/);
      const visible = card.replace(folded, '');
      const title = /<strong\b[^>]*>([\s\S]*?)<\/strong>/.exec(visible)?.[1] ?? '';
      expect(title).not.toBe('');
      expect([...title.replace(/<b\b[^>]*>[\s\S]*?<\/b>|<[^>]*>/g, '').trim()].length).toBeLessThanOrEqual(30);
      expect(visible).not.toMatch(/页头宽 \d/);
      expect(visible).toMatch(/实现方|设计方|智能体|验收人|执行人|评审人/);
      expect(visible.match(/<(?:button|a)\b/g)).toHaveLength(1);
    }
    const details = cards.map(card => /<details\b[^>]*>([\s\S]*?)<\/details>/.exec(card)?.[1]).join('\n');
    for (const measurement of measurements) expect(details).toContain(measurement);
  });
});
