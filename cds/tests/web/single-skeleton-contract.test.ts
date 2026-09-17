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

  it('骨架含总览的每一段：说明区、六个页签、判断行、关系卡骨架、入口、曲线骨架、部署环境', () => {
    const html = renderToStaticMarkup(createElement(BranchDrawerSkeleton, { status: 'idle' }));
    for (const tab of drawerTabs) expect(html).toContain(`>${tab.label}<`);
    expect(html).toContain('服务就绪');
    expect(html).toContain('data-testid="relation-card"');
    expect(html).toContain('data-testid="relation-strip-skeleton"');
    expect(html).toContain('>入口<');
    expect(html).toContain('data-testid="metrics-skeleton"');
    for (const label of ['复制集', '基础设施', '服务']) expect(html).toContain(`>${label}<`);
  });

  it('关系卡的加载态是同一个导出：RelationCard 自己等 service-graph 时也渲染 RelationCardSkeleton', () => {
    const card = stripComments(read('components/branch/RelationCard.tsx'));
    expect(card).toMatch(/state\.status === 'loading'\) return <RelationCardSkeleton/);
    const html = renderToStaticMarkup(createElement(RelationCardSkeleton, {}));
    expect(html).toContain('data-testid="relation-strip-skeleton"');
    expect(html).toContain('正在体检');
  });

  it('未运行的分支骨架期给「服务未运行」说明留位，运行中的不留（就绪那一帧不许跳）', () => {
    const idle = renderToStaticMarkup(createElement(BranchDrawerSkeleton, { status: 'idle' }));
    const running = renderToStaticMarkup(createElement(BranchDrawerSkeleton, { status: 'running' }));
    expect(idle.length).toBeGreaterThan(running.length);
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
