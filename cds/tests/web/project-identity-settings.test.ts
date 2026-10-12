import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { GeneralTab } from '../../web/src/pages/ProjectSettingsPage.js';
import { ProjectIdentityFields } from '../../web/src/components/project/ProjectIdentityHistory.js';

describe('project settings effective preview identifier', () => {
  it('仓库关联绑定和解绑可见，保留独立 Git 地址并兼容旧记录', () => {
    const base = { name: 'Project', displayName: 'Project', slug: 'project-id', repository: 'https://example.test/repo.git' };
    const linked = { ...base, githubRepository: 'owner/repo' };
    const binding = renderToStaticMarkup(React.createElement(ProjectIdentityFields, { before: base, after: linked }));
    expect(binding).toContain('GitHub 仓库关联');
    expect(binding).toContain('未设置 → owner/repo');
    expect(binding).not.toContain('Git 仓库');
    const removal = renderToStaticMarkup(React.createElement(ProjectIdentityFields, { before: linked, after: base }));
    expect(removal).toContain('owner/repo → 未设置');
    const legacy = renderToStaticMarkup(React.createElement(ProjectIdentityFields, { after: base }));
    expect(legacy).toContain('https://example.test/repo.git');
    expect(legacy).not.toContain('GitHub 仓库关联');
  });
  it('fills the actual default instead of an empty alias input', () => {
    const html = renderToStaticMarkup(React.createElement(GeneralTab, {
      project: { id: 'fixture', name: 'Shown name', slug: 'old-project' },
      projectId: 'fixture', onSaved: () => {}, onToast: () => {},
    }));
    expect(html).toContain('value="old-project"');
    expect(html).toContain('项目 slug');
    expect(html).not.toContain('别名 slug');
    expect(html).not.toContain('旧地址继续可用');
    expect(html).toContain('设置变更记录');
  });

  it('shows exactly the persisted project slug without a second internal slug', () => {
    const html = renderToStaticMarkup(React.createElement(GeneralTab, {
      project: { id: 'fixture', name: 'Shown name', slug: 'short-name' },
      projectId: 'fixture', onSaved: () => {}, onToast: () => {},
    }));
    expect(html).toContain('value="short-name"');
    expect(html).toContain('<dd class="break-all font-mono">short-name</dd>');
    expect(html).toContain('<summary class="cursor-pointer text-sm text-muted-foreground">技术信息</summary>');
    expect(html).not.toContain('创建时的内部标识');
    expect(html).not.toContain('恢复默认标识');
  });
});
