import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { GeneralTab } from '../../web/src/pages/ProjectSettingsPage.js';

describe('project settings effective preview identifier', () => {
  it('fills the actual default instead of an empty alias input', () => {
    const html = renderToStaticMarkup(React.createElement(GeneralTab, {
      project: { id: 'fixture', name: 'Shown name', slug: 'old-project', previewIdentifier: 'old-project' },
      projectId: 'fixture', onSaved: () => {}, onToast: () => {},
    }));
    expect(html).toContain('value="old-project"');
    expect(html).toContain('预览地址标识');
    expect(html).not.toContain('别名 slug');
    expect(html).not.toContain('旧地址继续可用');
    expect(html).toContain('设置变更记录');
  });

  it('shows the server effective identifier consistently when it differs from the internal identity', () => {
    const html = renderToStaticMarkup(React.createElement(GeneralTab, {
      project: { id: 'fixture', name: 'Shown name', slug: 'old-project', aliasSlug: 'short-name', previewIdentifier: 'short-name' },
      projectId: 'fixture', onSaved: () => {}, onToast: () => {},
    }));
    expect(html).toContain('value="short-name"');
    expect(html).toContain('<dd class="break-all font-mono">short-name</dd>');
    expect(html).toContain('<summary class="cursor-pointer text-sm text-muted-foreground">技术信息</summary>');
  });
});
