import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BranchSearchDropdown } from '../../web/src/components/branch/BranchSearchDropdown';
import { reviewBranchSource } from '../../web/src/lib/codeReviews';
const tracked = Array.from({ length: 25 }, (_, i) => ({ id: `id-${i}`, branch: `feature/tracked-${i}`, status: 'idle' }));
const remote = [...tracked.map(b => ({ name: b.branch })), ...Array.from({ length: 30 }, (_, i) => ({ name: `feature/remote-${i}` }))];
function render(query = '', extra = {}) {
  return renderToStaticMarkup(createElement(BranchSearchDropdown, { query, tracked, remote, remoteLoading: false,
    trackedByName: new Map(tracked.map(b => [b.branch, b])), actions: {},
    onPickTracked: () => {}, onPickRemote: () => {}, onForceFetchRemote: () => {}, ...extra }));
}
describe('共享分支选择', () => {
  it('完整渲染已登记和远程分支，按名称去重，不截断第12项之后的数据', () => {
    const html = render();
    expect(html).toContain('已跟踪 · 25'); expect(html).toContain('远程 · 30');
    expect(html).toContain('feature/tracked-24'); expect(html).toContain('feature/remote-29');
    expect(html.match(/feature\/tracked-0</g)).toHaveLength(1);
    expect(html).toContain('刷新远程'); expect(html).not.toContain('配置来源');
  });
  it('忽略大小写搜索；失败保留缓存与重试入口，正在拉取时禁止再次刷新', () => {
    const html = render('REMOTE-29', { remoteError: '远程分支读取失败' });
    expect(html).toContain('feature/remote-29'); expect(html).not.toContain('feature/remote-28');
    expect(html).toContain('role="alert"'); expect(html).toContain('刷新远程');
    expect(render('absent', { remoteLoading: true })).toMatch(/disabled=""/);
  });
  it('分支页仍可选择配置来源，审查页默认不展示部署配置', () => {
    const html = render('', { onChangeConfigSource: () => {}, configSourceBranchId: 'id-24' });
    expect(html).toContain('项目模板(默认,不派生)');
    expect(html).toContain('<option value="id-24" selected="">');
    expect(html).toContain('派生自 feature/tracked-24');
  });
  it('已登记分支使用分支ID，远程分支使用所选项目仓库和原始ref，不创建部署', () => {
    expect(reviewBranchSource({ githubRepoFullName: 'owner/repo' }, tracked[0], '')).toEqual({ sourceType: 'cds', branchId: 'id-0' });
    expect(reviewBranchSource({ githubRepoFullName: 'owner/repo' }, undefined, 'feature/远程')).toEqual({ sourceType: 'github', githubUrl: 'https://github.com/owner/repo', ref: 'feature/远程' });
    expect(reviewBranchSource(undefined, undefined, 'main')).toBeUndefined();
    expect(reviewBranchSource({ githubRepoFullName: 'owner/repo/extra' }, undefined, 'main')).toBeUndefined();
  });
});
