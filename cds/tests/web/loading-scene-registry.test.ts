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
    const standalone = new Set(['/', '/login', '/auth/sso', '/preview-preparing', '/hello', '/s/:token', '*']);
    expect(scenes.filter(s=>s.scope!=='standalone').map(s => s.route).sort()).toEqual(routes.filter(route => !standalone.has(route)).sort());
    expect(new Set(scenes.map(s => s.route)).size).toBe(scenes.length);
    for (const scene of scenes.filter(s=>s.scope!=='standalone')) {
      expect(fs.existsSync(path.join(src, scene.page)), scene.page).toBe(true);
      const sample = scene.route.replace(/:[^/]+/g, 'fixture');
      expect(loadingSceneForPath(sample + '/')).toEqual(scene);
      expect(render(pageSkeletonForPath(sample))).not.toContain('md:grid-cols-2 xl:grid-cols-3');
    }
    expect(loadingSceneForPath('/settings-extra/fixture')).toBeUndefined();
    expect(loadingSceneForPath('/branches')).toBeUndefined();
  });

  it('发布控制台和项目设置的路由、数据和预览共用真实导出', () => {
    const release = render(createElement(ReleaseConsoleSkeleton));
    const project = render(createElement(SettingsPageSkeleton, { label: '加载项目设置' }));
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

  it('独立登录和公开状态也登记并复用专用骨架', () => {
    const { MemoryRouter } = createRequire(path.resolve('web/package.json'))('react-router-dom');
    expect(pageSkeletonForPath('/login').type).toBe(AuthPageSkeleton);
    expect(render(createElement(MemoryRouter,null,pageSkeletonForPath('/login')))).toContain('data-auth-form-skeleton');
    expect(render(pageSkeletonForPath('/s/fixture-token'))).toBe(render(createElement(PublicStatusSkeleton)));
    const login = fs.readFileSync(path.join(src,'pages/LoginPage.tsx'),'utf8');
    expect(login).not.toMatch(/function AuthFormSkeleton/);
    expect(login).toContain('!loginMethodsReady || !bootstrapReady');
    expect(render(createElement(AuthFormSkeleton))).not.toMatch(/<(?:input|button)\b/);
  });

  it('等待分类覆盖 loaded/ready/pending 表达式，而非只查 loading 单词', () => {
    for (const condition of ['!projectsLoaded && !error', '!isReady', "state.status === 'pending'", "state.status === 'loading'", 'isFetching']) expect(loadingCondition(condition), condition).toBe(true);
    for (const condition of ['!loading && items.length === 0', "state.status === 'error'"]) {
      expect(loadingCondition(condition), condition).toBe(false);
    }
  });
});
