import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect } from 'vitest';
import { AppRail, canManageSystemSettings, canUseConsolePreview, ConsoleAuthContext, OwnerConsoleRoute, PaletteHint } from '../../web/src/components/layout/AppShell';
import { settingsTabForViewer } from '../../web/src/pages/CdsSettingsPage';
import { ExtraServicesPanel } from '../../web/src/components/branch/ExtraServicesPanel';
import { VariablesPanel } from '../../web/src/components/BranchDetailDrawer';

const { MemoryRouter, Routes, Route } = createRequire(path.resolve('web/package.json'))('react-router-dom');

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
  it('loads project capability before polling owner-only maintenance and import APIs', () => {
    const refresh = list.slice(list.indexOf('const refresh = useCallback'), list.indexOf('// 暂停 / 恢复一个项目。'));
    expect(refresh).toContain('const projectsRes = await apiRequest<ProjectsResponse>');
    expect(refresh).toMatch(/const legacyRes = canManageProjects\s*\?/);
    expect(refresh).toMatch(/if \(canManageProjects\) void loadPendingImports\(\);/);
    expect(list).toContain('open={canManageProjects && pendingImportOpen}');
    expect(list).toContain('{canManageProjects ? <CreateProjectDialog');
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
  it('uses one owner capability for route mounting, search hints, shortcuts and version reads', () => {
    const shell = read('components/layout/AppShell.tsx');
    const routes = read('App.tsx');
    const branches = read('pages/BranchListPage.tsx');
    const drawer = read('components/BranchDetailDrawer.tsx');
    expect(shell).toContain('export function useCanManageConsole');
    expect(shell).toContain('export function OwnerConsoleRoute');
    expect(shell).toContain('if (!canManageSettings) return;');
    expect(shell).toContain('if (!useCanManageConsole()) return null;');
    expect(routes).toContain('<Route element={<OwnerConsoleRoute />}>');
    expect(branches).toContain('const canManageConsole = useCanManageConsole();');
    expect(branches).toContain('canManageConsole ? apiRequest');
    expect(drawer).toContain('canManageConsole ? apiRequest');
    expect(drawer).toContain('不可变部署版本仅系统所有者可用');
  });
  it('mounts the global report shortcut only inside the owner-capable persistent shell', () => {
    expect(read('App.tsx')).not.toContain('<BugReportDialog />');
    const shell = read('components/layout/AppShell.tsx');
    expect(shell).toContain('{canManageSettings ? <BugReportDialog /> : null}');
    expect(shell.indexOf('<ConsoleAuthContext.Provider')).toBeLessThan(shell.indexOf('<BugReportDialog />'));
  });
  it.each(['multi', 'simple', 'port'] as const)('keeps owner previews and limits member controls to supported %s mode', mode => {
    expect(canUseConsolePreview(mode, true)).toBe(true);
    expect(canUseConsolePreview(mode, false)).toBe(mode === 'multi');
    expect(canUseConsolePreview(undefined, false)).toBe(false);
  });
  it('wires the same preview-mode gate to list actions, detail and drawer entry links', () => {
    for (const file of ['pages/BranchListPage.tsx', 'pages/BranchDetailPage.tsx', 'components/BranchDetailDrawer.tsx']) {
      const source = read(file);
      expect(source, file).toContain('canUseConsolePreview');
      expect(source, file).toContain('MEMBER_PREVIEW_MODE_NOTICE');
    }
    const branches = read('pages/BranchListPage.tsx');
    expect(branches).toContain('canPreview: canOpenPreview');
    expect(branches).toContain('if (!canOpenPreview) {');
    expect(read('components/BranchDetailDrawer.tsx')).toContain('previewUrl && canOpenPreview');
  });
  it('keeps member groups readable while gating every editing surface and save on owner capability', () => {
    const branches = read('pages/BranchListPage.tsx');
    expect(branches).toContain('const groupsReadOnly = !canManageConsole || Boolean(branchGroups?.readOnly);');
    expect(branches).toContain('const groupsEditable = groupedView && !groupsReadOnly;');
    expect(branches).toContain('open={Boolean(groupEditor) && !groupsReadOnly}');
    const save = branches.slice(branches.indexOf('const saveBranchGroups ='), branches.indexOf('const openExistingGroupEditor ='));
    expect(save).toContain('if (!canManageConsole)');
    expect(save.indexOf('if (!canManageConsole)')).toBeLessThan(save.indexOf('pendingGroupUpdatesRef.current = [...'));
    expect(branches).toContain('分组只读（仅系统所有者可编辑）');
  });
  it('preserves member read-only SQL execution but guards write, initialization and migration affordances', () => {
    const drawer = read('components/BranchDetailDrawer.tsx');
    const sqlPanel = drawer.slice(drawer.indexOf('function SqlResourceDataPanel('), drawer.indexOf('function DbResultTable('));
    expect(sqlPanel).toContain('const canManageConsole = useCanManageConsole();');
    expect(sqlPanel).toContain('const sqlReadOnly = sqlCommandIsReadOnly(sql, resource.runtime);');
    expect(sqlPanel).toContain('!canManageConsole && !sqlReadOnly');
    expect(sqlPanel).toContain('if (!canManageConsole || !basePath || !initSql.trim()) return;');
    expect(sqlPanel).toContain('if (!canManageConsole || !resource.branchId || !migrationCommand.trim()) return;');
    expect(sqlPanel).toContain('普通账号仅支持只读查询；写入、初始化和迁移请联系系统所有者。');
  });
  it('keeps masked variables readable without member editing, reveal, secret copy or cached plaintext', () => {
    const props = {
      state: { status: 'ok' as const, data: { branchId: 'fixture', projectId: 'project', projectSlug: 'project', total: 2,
        bySource: { branch: 0, project: 2, global: 0, mirror: 0, 'cds-derived': 0, 'cds-builtin': 0 },
        variables: [{ key: 'PUBLIC_LABEL', value: 'safe-label', source: 'project' as const, isSecret: false },
          { key: 'API_TOKEN', value: '••••', source: 'project' as const, isSecret: true, valueLength: 30 }] } },
      revealedValues: new Map([['API_TOKEN', 'fake-cached-secret']]), query: '', branchId: 'fixture', projectId: 'project', editorOpen: true,
      onToggleReveal() {}, onCopySecret() {}, onQuery() {}, onRefresh() {}, onToggleEditor() {}, onEnvChanged() {}, onToast() {},
    };
    const render = (owner: boolean) => renderToStaticMarkup(createElement(VariablesPanel, { ...props, canManageConsole: owner }));
    const member = render(false);
    expect(member).toContain('PUBLIC_LABEL');
    expect(member).toContain('safe-label');
    expect(member).toContain('API_TOKEN');
    expect(member).not.toContain('编辑本分支');
    expect(member).not.toContain('fake-cached-secret');
    expect(member).not.toContain('aria-label="显示值"');
    expect(member).not.toContain('aria-label="隐藏值"');
    expect(member.match(/aria-label="复制"/g)).toHaveLength(1);
    expect(member).not.toContain('href="/settings/');
    const owner = render(true);
    expect(owner).toContain('编辑本分支');
    expect(owner).toContain('fake-cached-secret');
    expect(owner.match(/aria-label="复制"/g)).toHaveLength(2);
    expect(owner).toContain('aria-label="隐藏值"');
    const drawer = read('components/BranchDetailDrawer.tsx');
    expect(drawer).toContain('canManageConsole={canManageConsole}');
    expect(drawer).toContain('if (!canManageConsole) return;');
  });
  it('does not mount owner route contents or advertise search for members and unresolved auth', () => {
    const render = (status: Parameters<typeof canManageSystemSettings>[0], pending = false) =>
      renderToStaticMarkup(createElement(MemoryRouter, null,
        createElement(ConsoleAuthContext.Provider, { value: { status, pending, retry() {} } },
          createElement(PaletteHint),
          createElement(Routes, null,
            createElement(Route, { element: createElement(OwnerConsoleRoute) },
              createElement(Route, { path: '/', element: createElement('div', null, 'owner-content-mounted') }))))));
    const member = render({ enabled: true, user: { isSystemOwner: false } });
    expect(member).toContain('此页面仅系统所有者可用');
    expect(member).not.toContain('owner-content-mounted');
    expect(member).not.toContain('打开命令面板');
    const pending = render(null, true);
    expect(pending).toContain('页面加载中');
    expect(pending).not.toContain('owner-content-mounted');
    const failed = render(null);
    expect(failed).toContain('登录状态暂时无法确认');
    expect(failed).toContain('重新检查登录状态');
    expect(failed).not.toContain('owner-content-mounted');
    for (const owner of [{ enabled: true, user: { isSystemOwner: true } }, { enabled: false }]) {
      const html = render(owner);
      expect(html).toContain('owner-content-mounted');
      expect(html).toContain('打开命令面板');
    }
  });
  it('wires branch detail and shared configuration editors to the same owner capability', () => {
    const detail = read('pages/BranchDetailPage.tsx');
    expect(detail).toContain('const canManageConsole = useCanManageConsole();');
    expect(detail).toContain('配置仅供查看，修改请联系系统所有者。');
    expect(detail).toContain('canManageConsole ? apiRequest<ProxyLogResponse>');
    expect(detail).toContain("if (state.status !== 'ok' || !canManageConsole) return;");
    for (const component of ['ExtraServicesPanel', 'EffectiveConfigPanel', 'ReferencesPanel']) {
      expect(read(`components/branch/${component}.tsx`)).toContain('const canManageConsole = useCanManageConsole();');
    }
  });
  it('keeps temporary services readable while exposing additions only to owners or disabled local auth', () => {
    const render = (status: Parameters<typeof canManageSystemSettings>[0]) =>
      renderToStaticMarkup(createElement(ConsoleAuthContext.Provider, { value: { status, pending: false, retry() {} } },
        createElement(ExtraServicesPanel, { branchId: 'fixture' })));
    for (const status of [null, { enabled: true, user: { isSystemOwner: false } }]) {
      const html = render(status);
      expect(html).toContain('临时额外服务');
      expect(html).not.toContain('添加服务');
    }
    for (const status of [{ enabled: true, user: { isSystemOwner: true } }, { enabled: false }]) {
      expect(render(status)).toContain('添加服务');
    }
  });
});
