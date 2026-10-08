import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect } from 'vitest';
import { AppRail, canManageSystemSettings } from '../../web/src/components/layout/AppShell';
import { settingsTabForViewer } from '../../web/src/pages/CdsSettingsPage';

const { MemoryRouter } = createRequire(path.resolve('web/package.json'))('react-router-dom');

const read = (file: string) => fs.readFileSync(path.resolve('web/src', file), 'utf8');

describe('human project access UI wiring', () => {
  const list = read('pages/ProjectListPage.tsx');
  it('treats a scoped empty list as authoritative, not a reason to revive revoked cards', () => {
    expect(list).toMatch(/const canManageProjects = projectsRes\.canManageProjects !== false/);
    expect(list).toMatch(/if \(nextProjects\.length > 0 \|\| !canManageProjects\)/);
    expect(list).toMatch(/const suspiciousEmpty =\s*canManageProjects && nextProjects\.length === 0/);
  });
  it('hides owner actions and explains how an unassigned member gets access', () => {
    expect(list).toContain('center={canManageProjects ? (');
    expect(list).toContain('{canManageProjects ? <DropdownMenu');
    expect(list).toContain('canManageProjects={canManageProjects}');
    expect(list).toContain('还没有获授权的项目');
    expect(list).toContain('用户管理 → 项目授权');
  });
  it('binds the user selection to the persisted user ID and server-authoritative saved set', () => {
    const dialog = read('pages/cds-settings/components/UserProjectAccessDialog.tsx');
    expect(dialog).toContain('encodeURIComponent(user.id)');
    expect(dialog).toContain('method: \'PUT\', body: { projectIds: selected }');
    expect(dialog).toContain('setData(result)');
    expect(dialog).not.toMatch(/localStorage|sessionStorage/);
  });
  it('renders only project and personal activity navigation for members, preserving owner controls', () => {
    const render = (canManageSettings: boolean) => renderToStaticMarkup(createElement(MemoryRouter, null,
      createElement(AppRail, { active: 'projects', canManageSettings, canLogout: false, logoutState: 'idle',
        onLogout() {}, onAgentAccess() {}, onBugReport() {} })));
    const member = render(false);
    expect(member).toContain('href="/project-list"');
    expect(member).toContain('href="/cds-settings#activity"');
    expect(member).toContain('个人操作痕迹');
    for (const ownerRoute of ['/overview', '/release-console', '/task-schedule', '/reports', '/status']) {
      expect(member).not.toContain(`href="${ownerRoute}"`);
    }
    expect(member).not.toContain('CDS 系统设置');
    const owner = render(true);
    expect(owner).toContain('CDS 系统设置');
    expect(owner).toContain('href="/release-console"');
  });
  it('fails closed before auth resolves and keeps legacy owner/disabled mode compatibility', () => {
    expect(canManageSystemSettings(null)).toBe(false);
    expect(canManageSystemSettings({ enabled: true, user: { isSystemOwner: false } })).toBe(false);
    expect(canManageSystemSettings({ enabled: true, user: { isSystemOwner: true } })).toBe(true);
    expect(canManageSystemSettings({ enabled: false, mode: 'disabled', user: null })).toBe(true);
    for (const requested of ['maintenance', 'users', 'auth', 'activity'] as const) {
      expect(settingsTabForViewer(requested, false)).toBe('activity');
      expect(settingsTabForViewer(requested, true)).toBe(requested);
    }
    const page = read('pages/CdsSettingsPage.tsx');
    expect(page).toContain('settingsTabForViewer(requestedTab, canManageSettings)');
    expect(page).toContain('canManageSystemSettings(viewerStatus)');
  });
});
