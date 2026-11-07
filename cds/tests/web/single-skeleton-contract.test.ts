import { DatabasePassCapability } from '../../web/src/components/branch/DatabasePassPanel.js';
import { mergeCleanSettings } from '../../web/src/components/project/ProjectSettingsRefresh.js';
/**
 * 「一个界面一副骨架」守卫（2026-09-17）。
 *
 * 用户反馈：「页面加载的时候出现了两个骨架，一个是原来的老骨架，加载三秒之后出现了第二幅
 * 更接近现在真实的骨架，也有不少页面出现了这种双骨架的问题。」
 *
 * 两处病根，都是「两段等待各画各的」：
 *   1. 分支详情抽屉：等八个接口时画通用横条，数据到了总览再按自己的轮廓画子骨架；
 *   2. 控制台外壳：chunk 未到时画固定的「标题 + 六块方块」，页面挂上后再换成卡片网格。
 *
 * 这类回归编译过、渲染过、单看任何一处都对，只有连着看两帧才显形，所以钉成机械判据：
 * 骨架期用的部件必须**就是**就绪期用的那批部件（同一个导出），而不是长得像的复制品。
 */
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BranchDrawerSkeleton } from '../../web/src/components/branch/BranchDrawerSkeleton.js';
import { RelationCardSkeleton } from '../../web/src/components/branch/RelationCard.js';
import { drawerTabs } from '../../web/src/components/branch/drawerTabs.js';
import { ProjectListSkeleton, pageSkeletonForPath } from '../../web/src/components/skeletons/PageSkeletons.js';
import { SettingsPageSkeleton } from '../../web/src/components/skeletons/SettingsSkeleton.js';
import { branchNoticeVisible, ResourceTcpConnectionStatus, ServiceLogsPanel } from '../../web/src/components/BranchDetailDrawer.js';
import { BranchDetailLoadingSkeleton, LoadingBlock } from '../../web/src/pages/cds-settings/components.js';
import { MonitorCenterSkeleton } from '../../web/src/pages/status/primitives.js';
import { CommonLoadingSkeleton } from '../../web/src/pages/cds-settings/tabs/LoadingPagesTab.js';
import { MetricsSkeleton, OverviewPanel } from '../../web/src/components/branch/OverviewPanel.js';

const SRC = path.resolve(__dirname, '../../web/src');
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8');
/** 扫源码只扫会执行的部分：注释里为讲病根会原样引用错误写法（predicate-and-wiring-discipline 形状 6）。 */
const stripComments = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

describe('资源与日志等待只覆盖真实等待状态', () => {
  it('数据库通行证已禁用且原因缺失时明确结束等待', () => {
    for (const reason of [undefined, '']) {
      const html = renderToStaticMarkup(createElement(DatabasePassCapability,{capability:{enabled:false,host:'',defaultTtlMinutes:30,reason}}));
      expect(html).toContain('当前实例未启用 TCP 直连。');
      expect(html).not.toContain('aria-busy');
    }
    expect(renderToStaticMarkup(createElement(DatabasePassCapability,{capability:null}))).toContain('读取通行证配置');
    expect(renderToStaticMarkup(createElement(DatabasePassCapability,{capability:null,loadError:'读取失败'}))).not.toContain('aria-busy');
  });

  it('TCP 配置只有未到达时 busy；关闭且缺少原因时给出确定说明', () => {
    const render = (capability: Parameters<typeof ResourceTcpConnectionStatus>[0]['capability']) => renderToStaticMarkup(createElement(ResourceTcpConnectionStatus, {capability}));
    expect(render(null)).toContain('aria-busy="true"');
    for (const reason of [undefined, '']) {
      const html = render({enabled:false,host:'',reason});
      expect(html).toContain('当前实例未启用 TCP 直连。');
      expect(html).not.toContain('aria-busy');
    }
    expect(render({enabled:false,host:'',reason:'实例策略未启用'})).toContain('实例策略未启用');
    expect(render({enabled:true,host:'fixture.invalid'})).toContain('fixture.invalid');
  });

  it('日志等待在正常容器内，只有就绪日志进入 pre', () => {
    const service = {profileId:'api',containerName:'fixture-api',hostPort:3000,status:'running' as const};
    const loading = renderToStaticMarkup(createElement(ServiceLogsPanel,{service,state:{status:'loading',profileId:'api'}}));
    expect(loading).toContain('aria-label="读取服务日志"');
    expect(loading).not.toContain('<pre');
    const ready = renderToStaticMarkup(createElement(ServiceLogsPanel,{service,state:{status:'ok',profileId:'api',logs:'fixture-ready-log'}}));
    expect(ready).toContain('<pre');
    expect(ready).toContain('fixture-ready-log');
    expect(ready).not.toContain('aria-busy');
  });
});

describe('分支详情抽屉：骨架期与就绪期共用同一批部件', () => {
  const drawer = stripComments(read('components/BranchDetailDrawer.tsx'));

  it('抽屉等接口时画的是总览形状的 BranchDrawerSkeleton，不再是通用横条', () => {
    expect(drawer).toMatch(/loading && !branch \? <BranchDrawerSkeleton/);
    expect(drawer).not.toContain('BranchDetailLoadingSkeleton');
  });

  it('页签表只有一份：抽屉与骨架都从 drawerTabs 取，抽屉里不许再写一张', () => {
    expect(drawer).toContain("from '@/components/branch/drawerTabs'");
    expect(drawer).not.toMatch(/const drawerTabs\s*[:=]/);
    expect(drawer).toContain('<nav className={DRAWER_TAB_NAV_CLASS}>');
  });

  it('骨架含总览「指挥台」的每一段：说明区、六个页签、六块指标砖、关系行、曲线骨架、服务表', () => {
    const html = renderToStaticMarkup(createElement(BranchDrawerSkeleton, { status: 'idle' }));
    for (const tab of drawerTabs) expect(html).toContain(`>${tab.label}<`);
    for (const label of ['状态', '服务就绪', '已运行', 'CPU 合计', '内存合计', '入口']) expect(html).toContain(`>${label}<`);
    expect(html).toContain('data-testid="relation-card"');
    expect(html).toContain('data-variant="row"');
    expect(html).toContain('data-testid="relation-strip-skeleton"');
    expect(html).toContain('data-testid="metrics-skeleton"');
    for (const label of ['服务', '状态', 'CPU', '内存', '容器']) expect(html).toContain(`<span>${label}</span>`);
    expect(html).toContain('共享基础设施');
    expect(html).toContain('复制集');
  });

  it('总览本体与骨架同一套轮廓：指标砖、关系行、指标网格、服务表按同一顺序出现', () => {
    const panel = stripComments(read('components/branch/OverviewPanel.tsx'));
    const order = ['data-testid="kpi-tiles"', '{relationSlot ?? null}', 'data-testid="metrics-grid"', '<ServiceTable'];
    const idx = order.map((m) => panel.indexOf(m));
    for (let i = 0; i < idx.length; i += 1) expect(idx[i], order[i]).toBeGreaterThan(i === 0 ? -1 : idx[i - 1]);
    expect(drawer).toMatch(/<RelationCard [\s\S]{0,300}?variant="row"/);
  });

  it('关系卡的加载态是同一个导出：RelationCard 自己等 service-graph 时也渲染 RelationCardSkeleton', () => {
    const card = stripComments(read('components/branch/RelationCard.tsx'));
    expect(card).toMatch(/state\.status === 'loading'\) return <RelationCardSkeleton/);
    const html = renderToStaticMarkup(createElement(RelationCardSkeleton, {}));
    expect(html).toContain('data-testid="relation-strip-skeleton"');
    expect(html).toContain('正在体检');
  });

  it('未运行的分支骨架期给「服务未运行」说明留位，运行中的连空 section 都不留（就绪那一帧不许跳）', () => {
    const idle = renderToStaticMarkup(createElement(BranchDrawerSkeleton, { status: 'idle' }));
    const running = renderToStaticMarkup(createElement(BranchDrawerSkeleton, { status: 'running' }));
    expect(idle.length).toBeGreaterThan(running.length);
    // 运行中：页签之上没有任何 section（此前是一条 py-4 的空带，用户圈出）
    expect(running.indexOf('<nav')).toBeLessThan(running.indexOf('<section'));
    expect(idle.indexOf('<section')).toBeLessThan(idle.indexOf('<nav'));
  });

  it('服务表对缺 profileId 的服务也能画（CDS CI 离线冒烟的合成数据就没有它，曾整块崩掉）', () => {
    const html = renderToStaticMarkup(createElement(OverviewPanel, {
      services: [{ containerName: 'c-legacy', status: 'running' } as unknown as { profileId: string; containerName: string; status: string }],
      running: true, branchName: 'demo', entries: [], deployments: [], metricSeries: {}, metricsReady: true,
      replicaSummary: '1 个副本', infraSummary: '无', now: Date.now(), windowMinutes: 30, onRefreshMetrics: () => {},
    }));
    expect(html).toContain('data-testid="service-table"');
    expect(html).toContain('data-service-row="c-legacy"');
  });

  it('抽屉本体的说明区只在有话说时渲染，判据收在 branchNoticeVisible 一处', () => {
    expect(drawer).toMatch(/\{branchNoticeVisible\(branch, currentFailureReason\) \? \(\s*<section className="border-b/);
    expect(branchNoticeVisible({ status: 'running' }, null)).toBe(false);
    expect(branchNoticeVisible({ status: 'building' }, null)).toBe(false);
    expect(branchNoticeVisible({ status: 'idle' }, null)).toBe(true);
    expect(branchNoticeVisible({ status: 'stopped' }, null)).toBe(true);
    expect(branchNoticeVisible({ status: 'running' }, 'boom')).toBe(true);
    expect(branchNoticeVisible({ status: 'error', lastStoppedAt: '2026-09-17T00:00:00Z' }, null)).toBe(true);
    expect(branchNoticeVisible({ status: 'running', lastStoppedAt: '2026-09-17T00:00:00Z' }, null)).toBe(false);
  });
});

describe('控制台外壳：chunk 骨架与页面数据骨架是同一个组件', () => {
  it('外壳的 Suspense fallback 按路由取 pageSkeletonForPath，不再自画固定方块', () => {
    const shell = stripComments(read('components/layout/AppShell.tsx'));
    expect(shell).toContain('pageSkeletonForPath(pathname, { canManageProjects })');
    expect(shell).toContain("from '@/components/skeletons/PageSkeletons'");
    const fallback = shell.slice(shell.indexOf('function ConsoleRouteFallback'), shell.indexOf('function ConsoleRouteFallback') + 1200);
    expect(fallback).not.toContain('cds-loading-skeleton-panel h-40');
  });

  it('分支列表与项目列表页从 PageSkeletons 取骨架，本页不许再定义一份', () => {
    const branchList = stripComments(read('pages/BranchListPage.tsx'));
    const projectList = stripComments(read('pages/ProjectListPage.tsx'));
    expect(branchList).toContain("import { BranchListSkeleton } from '@/components/skeletons/PageSkeletons'");
    expect(branchList).not.toMatch(/function BranchListSkeleton/);
    expect(projectList).toMatch(/import\s+\{[^}]*\bProjectListSkeleton\b[^}]*\}\s+from\s+'@\/components\/skeletons\/PageSkeletons'/);
    expect(projectList).not.toMatch(/function ProjectListSkeleton/);
  });

  it('分支骨架为统计和筛选保留与正文相同的布局槽，不额外插入加载文案', () => {
    const src = stripComments(read('components/skeletons/PageSkeletons.tsx'));
    expect(src).not.toContain('CdsLogoLoader');
    const branch = renderToStaticMarkup(pageSkeletonForPath('/branch-list'));
    const ready = read('pages/BranchListPage.tsx');
    expect(ready).toContain('<BranchListOverview summary=');
    expect(src).toContain('<BranchListOverview loading summary=');
    expect(branch.indexOf('data-branch-summary-slot')).toBeLessThan(branch.indexOf('cds-branch-card-grid'));
    expect(branch.indexOf('data-branch-controls-slot')).toBeLessThan(branch.indexOf('cds-branch-card-grid'));
    expect(branch).toContain('class="mt-6"');
    expect(branch).not.toMatch(/tabindex="0"/);
    expect(branch).not.toContain('加载项目与本地分支列表</');
  });

  it('路由 → 形状：分支页是分支卡网格，项目页是项目卡网格，其余是通用轮廓', () => {
    const branch = renderToStaticMarkup(pageSkeletonForPath('/branches/f9e8b956d3dd'));
    expect(branch).toContain('cds-branch-card-grid');
    expect(renderToStaticMarkup(pageSkeletonForPath('/branch-list'))).toContain('cds-branch-card-grid');
    const project = renderToStaticMarkup(pageSkeletonForPath('/project-list'));
    expect(project).toContain('cds-card-grid');
    expect(project).not.toContain('cds-branch-card-grid');
    const generic = renderToStaticMarkup(pageSkeletonForPath('/release-console'));
    expect(generic).not.toContain('cds-card-grid');
    expect(generic).toContain('cds-loading-skeleton-panel');
  });

  it('设置页签的代码等待保留设置卡片结构', () => {
    const settings = stripComments(read('pages/CdsSettingsPage.tsx'));
    const fallback = settings.slice(settings.indexOf('function SettingsTabFallback'), settings.indexOf('function SettingsTabFallback') + 400);
    expect(fallback).toContain('<SettingsContentSkeleton');
    expect(fallback).not.toContain('<LoadingBlock');
    expect(fallback).not.toContain('CdsLogoLoader');
  });
});


describe('统一骨架：路由、数据和预览共用组件', () => {
  const markup = (node: ReturnType<typeof createElement>) => renderToStaticMarkup(node);

  it('监控、分支详情、通用局部页的路由等待与数据等待轮廓一致', () => {
    expect(markup(pageSkeletonForPath('/status'))).toBe(markup(createElement(MonitorCenterSkeleton)));
    expect(markup(pageSkeletonForPath('/branch-panel/fixture'))).toBe(markup(createElement(BranchDetailLoadingSkeleton)));
    expect(markup(pageSkeletonForPath('/cds-settings'))).toBe(markup(createElement(SettingsPageSkeleton)));
    for (const route of ['/reports', '/task-schedule']) {
      expect(markup(pageSkeletonForPath(route))).toBe(markup(createElement(LoadingBlock)));
    }
  });

  it('预览展示实际的页面骨架，不再用 Logo 点阵替代', () => {
    for (const [scenarioId, expected] of [
      ['project-list', pageSkeletonForPath('/project-list')],
      ['branch-list', pageSkeletonForPath('/branch-list')],
      ['branch-detail', createElement(BranchDetailLoadingSkeleton)],
      ['relation-flow', createElement(RelationCardSkeleton, { variant: 'row' })],
      ['metrics', createElement(MetricsSkeleton, { filled: 0, windowLabel: '近 30 分钟', note: '正在读取指标历史' })],
      ['container-logs', createElement(LoadingBlock)],
    ] as const) {
      expect(markup(createElement(CommonLoadingSkeleton, { scenarioId }))).toBe(markup(expected));
    }
    const source = stripComments(read('pages/cds-settings/tabs/LoadingPagesTab.tsx'));
    expect(source).not.toContain('ShapeGridSkeletonPreview');
    expect(source).not.toContain('ShapeGridWaitingPreview');
    expect(source).not.toContain('CdsLogoLoader');
  });

  it('关系与指标的占位统一走共享样式，保留真实说明和图表轮廓', () => {
    const relation = markup(createElement(RelationCardSkeleton, { variant: 'row' }));
    const metrics = markup(createElement(MetricsSkeleton, { filled: 0, windowLabel: '近 30 分钟', note: '正在读取指标历史' }));
    for (const html of [relation, metrics]) {
      expect(html).toContain('cds-loading-skeleton-line');
      expect(html).toContain('cds-loading-skeleton-panel');
      expect(html).not.toContain('animate-pulse');
      expect(html).not.toContain('linear-gradient');
    }
    expect(metrics).toContain('height:38%');
    expect(metrics).toContain('正在读取指标历史');
  });

  it('监控柱条均分空间，不再每根都占父容器全宽', () => {
    const monitor = markup(createElement(MonitorCenterSkeleton));
    expect(monitor).toContain('cds-loading-skeleton-line min-w-0 flex-1');
    expect(monitor).not.toContain('w-full shrink-0');
  });
});


describe('项目设置刷新保留草稿并接收未编辑的服务器值', () => {
  it('保留新建、编辑、删除三类草稿，同时更新干净字段', () => {
    expect(mergeCleanSettings(
      { edited: 'draft', clean: 'old', added: 'draft' },
      { edited: 'old', clean: 'old', removed: 'old' },
      { edited: 'remote', clean: 'new', removed: 'remote', remote: 'new' },
    )).toEqual({ edited: 'draft', clean: 'new', added: 'draft', remote: 'new' });
  });
  it('数据库初始化对象未改动时跟随服务器，改过时保留本地值', () => {
    expect(mergeCleanSettings(
      { clean: { mode: 'empty' }, edited: { mode: 'clone', source: 'draft' } },
      { clean: { mode: 'empty' }, edited: { mode: 'empty' } },
      { clean: { mode: 'clone', source: 'remote' }, edited: { mode: 'empty' } },
    )).toEqual({ clean: { mode: 'clone', source: 'remote' }, edited: { mode: 'clone', source: 'draft' } });
  });
});

describe('项目页从骨架到正文保持相同布局', () => {
  it('加载与就绪页头使用同一个布局组件，窄屏筛选及工具条不再简化成两根横条', () => {
    const ready = stripComments(read('components/project/ProjectInventoryHeader.tsx'));
    const skeleton = stripComments(read('components/skeletons/PageSkeletons.tsx'));
    expect(ready).toContain('<ProjectInventoryLayout');
    expect(skeleton).toContain('<ProjectInventoryLayout');
    const html = renderToStaticMarkup(createElement(ProjectListSkeleton, { canManageProjects: true }));
    for (const label of ['管理项目、分支环境与部署。', '全部项目', '运行中', '已暂停', '已就绪']) expect(html).toContain(label);
    for (const group of ['cds-project-status-filters', 'cds-project-inventory-tools', 'cds-project-inventory-search', 'cds-project-view-switch']) expect(html).toContain(group);
    expect((html.match(/<button[^>]*disabled/g) || []).length).toBe(8);
    expect((html.match(/<select[^>]*disabled/g) || []).length).toBe(2);
    expect(html).not.toContain('h-8 w-72');
  });

  it('已保存的列表视图在代码和数据加载阶段都保持列表形状', () => {
    vi.stubGlobal('window', { localStorage: { getItem: () => JSON.stringify({ view: 'list', pinnedProjectIds: [] }) } });
    try {
      for (const html of [renderToStaticMarkup(createElement(ProjectListSkeleton)), renderToStaticMarkup(pageSkeletonForPath('/project-list'))]) {
        expect(html).toContain('cds-project-inventory--list');
        expect((html.match(/cds-project-card-link/g) || []).length).toBe(6);
      }
    } finally { vi.unstubAllGlobals(); }
  });
});


describe('项目加载骨架遵从已知管理能力', () => {
  it('身份未知和普通成员不画管理操作，明确的所有者保留操作轮廓', () => {
    for (const node of [createElement(ProjectListSkeleton), createElement(ProjectListSkeleton, { canManageProjects: false }), pageSkeletonForPath('/project-list')]) {
      const html = renderToStaticMarkup(node);
      expect(html).not.toContain('导入仓库');
      expect(html).not.toContain('新建项目');
      expect(html).toContain('cds-project-status-filters');
    }
    for (const node of [createElement(ProjectListSkeleton, { canManageProjects: true }), pageSkeletonForPath('/project-list', { canManageProjects: true })]) {
      const html = renderToStaticMarkup(node);
      expect(html).toContain('导入仓库');
      expect(html).toContain('新建项目');
    }
  });
});
