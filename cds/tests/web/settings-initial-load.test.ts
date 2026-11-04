import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import { settingsTitleForViewer } from '../../web/src/pages/CdsSettingsPage';
import { AppRail } from '../../web/src/components/layout/AppShell';
import { SettingsPageSkeleton } from '../../web/src/components/skeletons/SettingsSkeleton';

const { MemoryRouter } = createRequire(path.resolve('web/package.json'))('react-router-dom');

describe('设置首载身份语义', () => {
  it('未知身份不冒充普通成员，确认后再显示个人痕迹', () => {
    expect(settingsTitleForViewer(null)).toBe('系统设置');
    expect(settingsTitleForViewer({ enabled: true, user: null })).toBe('系统设置');
    expect(settingsTitleForViewer({ enabled: true, user: { isSystemOwner: true } })).toBe('系统设置');
    expect(settingsTitleForViewer({ enabled: false })).toBe('系统设置');
    expect(settingsTitleForViewer({ enabled: true, user: { isSystemOwner: false } })).toBe('个人痕迹');
  });

  it('身份未确认不展示成员专属入口，也不提前展示管理入口', () => {
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(AppRail, {
      active: 'cds-settings', canManageSettings: false, authPending: true, canLogout: false, logoutState: 'idle',
      onLogout() {}, onAgentAccess() {}, onBugReport() {},
    })));
    expect(html).not.toContain('个人操作痕迹');
    expect(html).not.toContain('aria-label="CDS 系统设置"');
    expect(html).toContain('href="/project-list"');
  });

  it('专用骨架保留导航和表单卡片，不放置可交互控件或虚构标题', () => {
    const html = renderToStaticMarkup(createElement(SettingsPageSkeleton));
    expect(html).toContain('cds-settings-layout');
    expect(html).toContain('cds-settings-rail');
    expect(html).toContain('data-settings-content-skeleton');
    expect(html).not.toMatch(/<(?:input|button|a)\b/);
    expect(html).not.toContain('个人痕迹');
    expect(html).toContain('cds-loading-skeleton-line');
  });
});
