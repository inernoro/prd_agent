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
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BranchDrawerSkeleton } from '../../web/src/components/branch/BranchDrawerSkeleton.js';
import { RelationCardSkeleton } from '../../web/src/components/branch/RelationCard.js';
import { drawerTabs } from '../../web/src/components/branch/drawerTabs.js';
import { pageSkeletonForPath } from '../../web/src/components/skeletons/PageSkeletons.js';
import { branchNoticeVisible } from '../../web/src/components/BranchDetailDrawer.js';
import { OverviewPanel } from '../../web/src/components/branch/OverviewPanel.js';

const SRC = path.resolve(__dirname, '../../web/src');
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8');
/** 扫源码只扫会执行的部分：注释里为讲病根会原样引用错误写法（predicate-and-wiring-discipline 形状 6）。 */
const stripComments = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

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
    expect(shell).toContain('pageSkeletonForPath(pathname)');
    expect(shell).toContain("from '@/components/skeletons/PageSkeletons'");
    const fallback = shell.slice(shell.indexOf('function ConsoleRouteFallback'), shell.indexOf('function ConsoleRouteFallback') + 1200);
    expect(fallback).not.toContain('cds-loading-skeleton-panel h-40');
  });

  it('分支列表与项目列表页从 PageSkeletons 取骨架，本页不许再定义一份', () => {
    const branchList = stripComments(read('pages/BranchListPage.tsx'));
    const projectList = stripComments(read('pages/ProjectListPage.tsx'));
    expect(branchList).toContain("import { BranchListSkeleton } from '@/components/skeletons/PageSkeletons'");
    expect(branchList).not.toMatch(/function BranchListSkeleton/);
    expect(projectList).toContain("import { ProjectListSkeleton } from '@/components/skeletons/PageSkeletons'");
    expect(projectList).not.toMatch(/function ProjectListSkeleton/);
  });

  it('列表骨架顶上不再放一行「加载…」文案：它把骨架撑得比正文高，切换那一帧整片网格往上跳', () => {
    const src = stripComments(read('components/skeletons/PageSkeletons.tsx'));
    expect(src).not.toContain('CdsLogoLoader');
    const branch = renderToStaticMarkup(pageSkeletonForPath('/branch-list'));
    // 第一个子元素就是卡片网格，前面没有任何说明行
    expect(branch).toMatch(/aria-live="polite"[^>]*><div class="cds-branch-card-grid"/);
    expect(branch).not.toContain('加载项目与本地分支列表</');
  });

  it('路由 → 形状：分支页是分支卡网格，项目页是项目卡网格，其余是通用轮廓', () => {
    const branch = renderToStaticMarkup(pageSkeletonForPath('/branches/f9e8b956d3dd'));
    expect(branch).toContain('cds-branch-card-grid');
    expect(renderToStaticMarkup(pageSkeletonForPath('/branch-list'))).toContain('cds-branch-card-grid');
    const project = renderToStaticMarkup(pageSkeletonForPath('/project-list'));
    expect(project).toContain('cds-card-grid');
    expect(project).not.toContain('cds-branch-card-grid');
    const generic = renderToStaticMarkup(pageSkeletonForPath('/reports'));
    expect(generic).not.toContain('cds-card-grid');
    expect(generic).toContain('cds-loading-skeleton-panel');
  });

  it('CDS 系统设置的页签 chunk 骨架与页签数据骨架同形（LoadingBlock 横条，不是居中 logo）', () => {
    const settings = stripComments(read('pages/CdsSettingsPage.tsx'));
    const fallback = settings.slice(settings.indexOf('function SettingsTabFallback'), settings.indexOf('function SettingsTabFallback') + 400);
    expect(fallback).toContain('<LoadingBlock');
    expect(fallback).not.toContain('CdsLogoLoader');
  });
});
