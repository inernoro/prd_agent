import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProjectCard, type ProjectSummary } from '../../web/src/pages/ProjectListPage.js';

const base: ProjectSummary = {
  id: 'project-1', name: '项目名称完整可见', slug: 'map-platform', cloneStatus: 'ready',
  branchCount: 3, appServiceCount: 2, runningServiceCount: 2,
  infraServiceCount: 2, runningInfraServiceCount: 2,
  appServices: [
    { id: 'api', branch: 'main', dockerImage: 'mcr.microsoft.com/dotnet/aspnet:8.0', runningCount: 1 },
    { id: 'web', branch: 'main', dockerImage: 'node:20', runningCount: 1 },
  ],
  infraServices: [
    { id: 'mongo', dockerImage: 'mongo:7', status: 'running' },
    { id: 'redis', dockerImage: 'redis:7', status: 'running' },
  ],
  resourceUsage: { projectId: 'project-1', cpuPercent: 218, memUsedMB: 512, runningContainers: 4, recentBuilds1h: 6, recentBuilds24h: 12 },
};

function render(patch: Partial<ProjectSummary> = {}, canManageProjects = false): string {
  return renderToStaticMarkup(createElement(ProjectCard, {
    project: { ...base, ...patch }, canManageProjects,
    onClone: () => {}, onAgentKeys: () => {}, onAgentSessions: () => {}, onDelete: () => {}, onTogglePause: () => {},
  }));
}

describe('项目卡片保留运维信号与真实服务组成', () => {
  it('CPU 合计超过单核仍显示真实数值与危险色，构建频率和环境不丢失', () => {
    const html = render();
    expect(html).toMatch(/cds-project-cpu text-bad/);
    expect(html).toContain('218%');
    expect(html).toContain('6 次构建/时');
    expect(html).toContain('production');
    expect(html).toContain('4<span');
    expect(html).toContain('/4');
    expect(html).toContain('3 分支');
    for (const label of ['.NET', 'Node.js', 'MongoDB', 'Redis']) expect(html).toContain(label);
    expect(html).toContain('href="/branches/project-1"');
  });

  it('零值与尚未采集明确区分，手机端也不靠 hidden 隐藏监控字段', () => {
    const zero = render({ resourceUsage: { ...base.resourceUsage!, cpuPercent: 0, recentBuilds1h: 0 } });
    expect(zero).toContain('0%');
    expect(zero).toContain('0 次构建/时');
    const missing = render({ resourceUsage: null });
    expect(missing).toContain('CPU 使用率尚未采集');
    expect(missing).toContain('构建频率 —');
    expect(missing).not.toContain('0%');
    expect(zero).not.toContain('sm:inline');
  });

  it('暂停不再遮挡名称或把异常读数一起灰掉', () => {
    const html = render({ paused: true });
    expect(html).toContain('已暂停');
    expect(html).toContain('项目名称完整可见');
    expect(html).toContain('218%');
    expect(html).not.toContain('grayscale');
    expect(html).not.toContain('pr-[13.5rem]');
  });

  it('没有识别出的技术栈时不会把未知配置伪装成 GitHub 仓库', () => {
    const html = render({ appServices: [], infraServices: [], githubRepoFullName: undefined, gitRepoUrl: undefined });
    expect(html).toContain('尚未配置应用服务');
    expect(html).not.toContain('已关联仓库');
    const repo = render({ appServices: [], infraServices: [], githubRepoFullName: 'team/repo' });
    expect(repo).toContain('team/repo');
    expect(repo).toContain('已关联仓库');
  });

  it('克隆失败保留错误与未就绪语义；只读用户不出现管理操作', () => {
    const failed = render({ cloneStatus: 'error', cloneError: '仓库不可访问' });
    expect(failed).toContain('克隆失败');
    expect(failed).toContain('仓库不可访问');
    expect(failed).toContain('href="#"');
    expect(render({}, false)).not.toContain('项目操作');
  });
});
