import { createRequire } from 'node:module';
import { AuthPageSkeleton, AuthFormSkeleton } from '../../web/src/components/skeletons/AuthPageSkeleton';
import { PublicStatusSkeleton } from '../../web/src/components/skeletons/PublicStatusSkeleton';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import scenes from '../../web/src/components/skeletons/loading-scenes.json';
import { loadingSceneForPath } from '../../web/src/components/skeletons/loadingScenes';
import { pageSkeletonForPath } from '../../web/src/components/skeletons/PageSkeletons';
import { AgentRequestsSkeleton, ReleaseCenterSkeleton, TopologyPageSkeleton } from '../../web/src/components/skeletons/WorkspaceSkeletons';
import { ReleaseConsoleSkeleton } from '../../web/src/components/skeletons/ReleaseConsoleSkeleton';
import { SettingsPageSkeleton } from '../../web/src/components/skeletons/SettingsSkeleton';
import { CommonLoadingSkeleton, commonLoadingScenarios } from '../../web/src/pages/cds-settings/tabs/LoadingPagesTab';
import { loadingCondition } from '../../scripts/loading-coverage-audit.mjs';

const render = renderToStaticMarkup;
const src = path.resolve('web/src');
describe('加载场景登记由真实路由约束', () => {
  it('人工抽检选项的标识与显示名称唯一，避免一个骨架有两个入口', () => {
    expect(new Set(commonLoadingScenarios.map(s => s.id)).size).toBe(commonLoadingScenarios.length);
    expect(new Set(commonLoadingScenarios.map(s => s.label)).size).toBe(commonLoadingScenarios.length);
  });
  it('所有控制台路由有明确登记，不能静默退回六方块', () => {
    const routes = [...fs.readFileSync(path.join(src, 'App.tsx'), 'utf8').matchAll(/<Route path="([^"]+)"/g)].map(m => m[1]);
    const standalone = new Set(['/', '/login', '/auth/sso', '/preview-preparing', '/preview-access', '/hello', '/s/:token', '*']);
    expect(scenes.filter(s=>s.scope!=='standalone').map(s => s.route).sort()).toEqual(routes.filter(route => !standalone.has(route)).sort());
    expect(new Set(scenes.map(s => s.route)).size).toBe(scenes.length);
    for (const scene of scenes.filter(s=>s.scope!=='standalone')) {
      expect(fs.existsSync(path.join(src, scene.page)), scene.page).toBe(true);
      const sample = scene.route.replace(/:[^/]+/g, 'fixture');
      expect(loadingSceneForPath(sample + '/')).toEqual(scene);
      expect(render(pageSkeletonForPath(sample))).not.toContain('md:grid-cols-2 xl:grid-cols-3');
    }
    expect(loadingSceneForPath('/release-center/approval')).toEqual(loadingSceneForPath('/release-center/approval/fixture'));
    expect(loadingSceneForPath('/overview')).toBeUndefined();
    expect(loadingSceneForPath('/settings-extra/fixture')).toBeUndefined();
    expect(loadingSceneForPath('/branches')).toBeUndefined();
  });

  it('发布控制台和项目设置的路由、数据和预览共用真实导出', () => {
    const release = render(createElement(ReleaseConsoleSkeleton));
    const project = render(createElement(SettingsPageSkeleton, { label: '加载项目设置', project: true }));
    expect(render(pageSkeletonForPath('/release-console'))).toBe(release);
    expect(render(pageSkeletonForPath('/settings/fixture'))).toBe(project);
    expect(render(createElement(CommonLoadingSkeleton, { scenarioId: 'release-console' }))).toBe(release);
    expect(render(createElement(CommonLoadingSkeleton, { scenarioId: 'project-settings' }))).toBe(project);
    for (const [route, Component, scenarioId] of [['/release-center', ReleaseCenterSkeleton, 'release-center'], ['/branch-topology', TopologyPageSkeleton, 'topology-page'], ['/agent-requests/fixture', AgentRequestsSkeleton, 'agent-requests']] as const) {
      expect(render(pageSkeletonForPath(route))).toBe(render(createElement(Component)));
      expect(render(createElement(CommonLoadingSkeleton,{scenarioId}))).toBe(render(createElement(Component)));
    }
    const releasePage = fs.readFileSync(path.join(src, 'pages/ReleaseConsolePage.tsx'), 'utf8');
    expect(releasePage).toContain('initialLoading ? <ReleaseConsoleSkeleton');
    for (const key of ['RELEASE_CONSOLE_LAYOUT_CLASS', 'RELEASE_CONSOLE_LEFT_CLASS', 'RELEASE_CONSOLE_CENTER_CLASS', 'RELEASE_CONSOLE_RIGHT_CLASS']) expect(releasePage).toContain(`className={${key}}`);
    expect(fs.readFileSync(path.join(src, 'pages/ProjectSettingsPage.tsx'), 'utf8')).toContain('<SettingsPageSkeleton label="加载项目设置"');
  });

  it('按实际深链区分发布模式和项目设置分区，并为审批与项目监控提供独立骨架', () => {
    const single = render(createElement(ReleaseConsoleSkeleton, { batch: false }));
    for (const search of ['?mode=single', '?target=site', '?intent=rollback']) {
      expect(render(pageSkeletonForPath('/release-console', { search }))).toBe(single);
    }
    const projectEnv = render(createElement(SettingsPageSkeleton, { label: '加载项目设置', project: true, projectTab: 'env' }));
    expect(render(pageSkeletonForPath('/settings/fixture', { hash: '#env', search: '?tab=general' }))).toBe(projectEnv);
    expect(projectEnv).not.toContain('cds-settings-aside-col');
    expect(render(pageSkeletonForPath('/settings/fixture', { hash: '#unknown' }))).toContain('cds-settings-aside-col');
    expect(render(pageSkeletonForPath('/release-center/approval', { search: '?project=fixture&target=site' }))).toContain('data-release-approval-skeleton');
    expect(render(pageSkeletonForPath('/status/fixture'))).toContain('data-project-status-skeleton');
  });

  it('验收中心代码等待保留导航槽，按真实 URL 选择页签且未就绪时不可操作', () => {
    for (const [search, selected] of [['', '验收报告'], ['?view=templates', '测试清单'], ['?view=tasks', '执行任务'], ['?view=matrix', '历史矩阵'], ['?view=overview', '验收报告'], ['?view=tasks&report=report-1', '验收报告']]) {
      const html = render(pageSkeletonForPath('/reports', { search }));
      expect(html).toContain('aria-label="验收中心导航"');
      const buttons = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)];
      expect(buttons).toHaveLength(4);
      expect(buttons.every(([, attrs]) => attrs.includes('disabled'))).toBe(true);
      expect(buttons.filter(([, attrs]) => attrs.includes('aria-current="page"')).map(([, , label]) => label)).toEqual([selected]);
      expect(html).toContain('aria-busy="true"');
    }
    expect(render(pageSkeletonForPath('/task-schedule'))).not.toContain('验收中心导航');
    expect(fs.readFileSync(path.join(src, 'components/skeletons/PageSkeletons.tsx'), 'utf8')).not.toContain('pages/reports/AcceptanceWorkspace');
  });

  it('独立登录和公开状态也登记并复用专用骨架', () => {
    const { MemoryRouter } = createRequire(path.resolve('web/package.json'))('react-router-dom');
    expect(pageSkeletonForPath('/login').type).toBe(AuthPageSkeleton);
    expect(render(createElement(MemoryRouter,null,pageSkeletonForPath('/login')))).toContain('data-auth-form-skeleton');
    expect(render(pageSkeletonForPath('/s/fixture-token'))).toBe(render(createElement(PublicStatusSkeleton)));
    expect(render(pageSkeletonForPath('/preview-access'))).toContain('aria-label="正在核对预览访问权限"');
    const login = fs.readFileSync(path.join(src,'pages/LoginPage.tsx'),'utf8');
    expect(login).not.toMatch(/function AuthFormSkeleton/);
    expect(login).toContain('!loginMethodsReady || !bootstrapReady');
    expect(render(createElement(AuthFormSkeleton))).not.toMatch(/<(?:input|button)\b/);
  });

  it('二级页按入口和查询参数选择相同的页面与数据骨架', () => {
    const branchDetail = render(pageSkeletonForPath('/branch-panel/fixture'));
    const branchAlias = render(pageSkeletonForPath('/branch-panel', { search: '?project=example&id=fixture' }));
    const branchSelector = render(pageSkeletonForPath('/branch-panel', { search: '?project=example' }));
    expect(branchAlias).toBe(branchDetail);
    expect(branchDetail).toContain('预览别名');
    expect(branchSelector).toContain('md:grid-cols-2');
    expect(branchSelector).not.toContain('预览别名');

    const dtsSelector = render(pageSkeletonForPath('/dts'));
    const dtsProject = render(pageSkeletonForPath('/dts', { search: '?project=example' }));
    expect(dtsSelector).toContain('请选择项目');
    expect(dtsSelector).not.toContain('正在加载数据同步');
    expect(dtsProject).toContain('正在加载数据同步');
    expect(dtsProject).toContain('md:grid-cols-[1fr_auto_1fr]');

    const relations = render(pageSkeletonForPath('/branch-relations/fixture'));
    expect(relations).toContain('data-branch-relations-skeleton');
    expect(relations).toContain('读取服务关系');
    expect(relations).not.toMatch(/<(?:button|input)\b/);
  });

  it('等待分类覆盖 loaded/ready/pending 表达式，而非只查 loading 单词', () => {
    for (const condition of ['!projectsLoaded && !error', '!isReady', "state.status === 'pending'", "state.status === 'loading'", 'isFetching']) expect(loadingCondition(condition), condition).toBe(true);
    for (const condition of ['!loading && items.length === 0', "state.status === 'error'"]) {
      expect(loadingCondition(condition), condition).toBe(false);
    }
  });
});
