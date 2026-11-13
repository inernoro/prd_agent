import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { partitionInventoryProjects, ProjectInventorySections } from '../../web/src/components/project/ProjectInventorySections.js';
import { INITIAL_PROJECT_SELECTION, selectInventoryProjects } from '../../web/src/components/project/ProjectInventoryHeader.js';
import type { ProjectSummary } from '../../web/src/pages/ProjectListPage.js';

const projects: ProjectSummary[] = [
  { id: 'paused-a', slug: 'paused-a', name: '暂停甲', paused: true, runningServiceCount: 3 },
  { id: 'live', slug: 'live', name: '运行项目', runningServiceCount: 1 },
  { id: 'ready', slug: 'ready', name: '就绪项目', runningServiceCount: 0 },
  { id: 'error', slug: 'error', name: '待处理项目', cloneStatus: 'error' },
  { id: 'paused-b', slug: 'paused-b', name: '暂停乙', paused: true },
];
const renderProject = (project: ProjectSummary) => createElement('article', { key: project.id, 'data-project-id': project.id }, project.name);
const render = (selected = projects, separatePaused = true, view: 'grid' | 'list' = 'grid') => renderToStaticMarkup(createElement(ProjectInventorySections, {
  projects: selected, view, separatePaused, filterKey: 'all', renderProject,
}));

describe('项目页仅将已暂停项目独立置底', () => {
  it('按明确的暂停标记分区，零在线或待处理项目保留在上方，输入顺序不变', () => {
    const { active, paused } = partitionInventoryProjects(projects);
    expect(active.map(project => project.id)).toEqual(['live', 'ready', 'error']);
    expect(paused.map(project => project.id)).toEqual(['paused-a', 'paused-b']);
    expect(projects.map(project => project.id)).toEqual(['paused-a', 'live', 'ready', 'error', 'paused-b']);
  });

  it('分区保留已有置顶和筛选排序语义，暂停置顶仍在暂停区内', () => {
    const selected = selectInventoryProjects(projects, INITIAL_PROJECT_SELECTION, [], new Map(), ['paused-a', 'ready']);
    const grouped = partitionInventoryProjects(selected);
    expect(grouped.active.map(project => project.id)).toEqual(['ready', 'live', 'error']);
    expect(grouped.paused.map(project => project.id)).toEqual(['paused-a', 'paused-b']);
    const paused = selectInventoryProjects(projects, { ...INITIAL_PROJECT_SELECTION, status: 'paused' }, [], new Map());
    expect(partitionInventoryProjects(paused).active).toHaveLength(0);
    expect(paused.map(project => project.id)).toEqual(['paused-a', 'paused-b']);
  });

  it('默认展示暂停区及真实数量，卡片和列表共用原有网格样式', () => {
    for (const view of ['grid', 'list'] as const) {
      const html = render(projects, true, view);
      const divider = html.indexOf('aria-label="已暂停项目"');
      expect(divider).toBeGreaterThan(html.indexOf('data-project-id="error"'));
      expect(divider).toBeLessThan(html.indexOf('data-project-id="paused-a"'));
      expect(html).toContain('已暂停 · 2');
      expect(html).toContain('aria-expanded="true"');
      expect((html.match(/cds-project-inventory-grid/g) || [])).toHaveLength(2);
      expect((html.match(/cds-project-inventory--list/g) || [])).toHaveLength(view === 'list' ? 2 : 0);
    }
  });

  it('显式暂停筛选及只有一种状态的结果直接展示，不把筛选结果藏起来', () => {
    for (const html of [render(projects, false), render(projects.filter(project => project.paused)), render(projects.filter(project => !project.paused))]) {
      expect(html).not.toContain('aria-label="已暂停项目"');
      expect((html.match(/cds-project-inventory-grid/g) || [])).toHaveLength(1);
    }
    expect(render(projects, false).indexOf('data-project-id="paused-a"')).toBeLessThan(render(projects, false).indexOf('data-project-id="live"'));
  });
});
