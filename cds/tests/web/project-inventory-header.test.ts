import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { INITIAL_PROJECT_SELECTION, ProjectInventoryHeader, projectEnvironmentNames, projectInventoryStatus, selectInventoryProjects } from '../../web/src/components/project/ProjectInventoryHeader.js';
import type { ProjectSummary } from '../../web/src/pages/ProjectListPage.js';

const projects: ProjectSummary[] = [
  { id: 'live', slug: 'live', name: '甲平台', aliasName: '核心平台', cloneStatus: 'ready', runningServiceCount: 0, runningInfraServiceCount: 1, lastDeployedAt: '2026-11-01T00:00:00Z' },
  { id: 'paused', slug: 'paused', name: '乙任务', paused: true, runningServiceCount: 3, cloneStatus: 'ready', lastDeployedAt: '2026-11-04T00:00:00Z' },
  { id: 'ready', slug: 'ready', name: '丙服务', cloneStatus: 'ready', runningServiceCount: 0 },
  { id: 'error', slug: 'error', name: '丁仓库', cloneStatus: 'error', runningInfraServiceCount: 1 },
  { id: 'pending', slug: 'pending', name: '戊仓库', cloneStatus: 'cloning' },
];
const targets = [
  { projectId: 'live', environment: 'production', isEnabled: true },
  { projectId: 'paused', environment: 'staging', isEnabled: false },
  { projectId: 'unreadable-project', environment: 'private-environment', isEnabled: true },
];
const serviceLabels = new Map([['live', ['.NET', 'MongoDB']]]);

describe('完整项目页保留 Demo 页头与可工作的工具条', () => {
  it('页头包含标题、说明、全部状态数量及完整筛选和视图控件', () => {
    const html = renderToStaticMarkup(createElement(ProjectInventoryHeader, {
      projects, targets, selection: INITIAL_PROJECT_SELECTION, onChange: () => {}, environmentStatus: 'ready',
      canManageProjects: true, importOpen: false, onImport: () => {}, onCreate: () => {},
    }));
    for (const text of ['<h1>项目</h1>', '管理项目、分支环境与部署。', '导入仓库', '新建项目',
      '全部项目<span>5</span>', '运行中<span>1</span>', '已暂停<span>1</span>', '已就绪<span>1</span>',
      '搜索项目或服务', '环境筛选', '项目排序', '卡片视图', '列表视图']) expect(html).toContain(text);
    expect(html).not.toContain('private-environment');
    expect(html).not.toContain('value="staging"');
  });

  it('暂停优先于残留运行数，克隆失败和准备中不会混入运行或就绪筛选', () => {
    expect(projects.map(projectInventoryStatus)).toEqual(['running', 'paused', 'ready', 'error', 'preparing']);
    for (const [status, id] of [['running', 'live'], ['paused', 'paused'], ['ready', 'ready']] as const) {
      expect(selectInventoryProjects(projects, { ...INITIAL_PROJECT_SELECTION, status }, targets, serviceLabels).map(project => project.id)).toEqual([id]);
    }
  });

  it('搜索匹配别名与技术名称，能与状态筛选组合，并保留原始数据顺序', () => {
    expect(selectInventoryProjects(projects, { ...INITIAL_PROJECT_SELECTION, query: '  mongodb ' }, targets, serviceLabels).map(project => project.id)).toEqual(['live']);
    expect(selectInventoryProjects(projects, { ...INITIAL_PROJECT_SELECTION, query: '核心平台', status: 'paused' }, targets, serviceLabels)).toEqual([]);
    expect(selectInventoryProjects(projects, { ...INITIAL_PROJECT_SELECTION, sort: 'recent' }, targets, serviceLabels).map(project => project.id)).toEqual(['paused', 'live', 'ready', 'error', 'pending']);
    expect(projects.map(project => project.id)).toEqual(['live', 'paused', 'ready', 'error', 'pending']);
  });

  it('环境只来自该项目启用的真实发布目标，不把缺失环境伪装成 production', () => {
    expect(projectEnvironmentNames('paused', targets)).toEqual([]);
    expect(selectInventoryProjects(projects, { ...INITIAL_PROJECT_SELECTION, environment: 'production' }, targets, serviceLabels).map(project => project.id)).toEqual(['live']);
    expect(selectInventoryProjects(projects, { ...INITIAL_PROJECT_SELECTION, environment: 'unconfigured' }, targets, serviceLabels).map(project => project.id)).toEqual(['paused', 'ready', 'error', 'pending']);
  });

  it('只读用户仍有搜索筛选，但没有导入或新建入口；环境读取失败明确显示', () => {
    const html = renderToStaticMarkup(createElement(ProjectInventoryHeader, {
      projects, targets: [], selection: INITIAL_PROJECT_SELECTION, onChange: () => {}, environmentStatus: 'error',
      canManageProjects: false, importOpen: false, onImport: () => {}, onCreate: () => {},
    }));
    expect(html).toContain('搜索项目或服务');
    expect(html).toContain('环境读取失败，请刷新');
    expect(html).not.toContain('导入仓库');
    expect(html).not.toContain('新建项目');
  });
});
