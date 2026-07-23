import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const shellSource = fs.readFileSync(
  path.resolve(process.cwd(), 'web/src/components/layout/AppShell.tsx'),
  'utf8',
);
const accessSource = fs.readFileSync(
  path.resolve(process.cwd(), 'web/src/components/AccessRequestInbox.tsx'),
  'utf8',
);
const operatorSource = fs.readFileSync(
  path.resolve(process.cwd(), 'web/src/components/OperatorApprovalModal.tsx'),
  'utf8',
);
const updateSource = fs.readFileSync(
  path.resolve(process.cwd(), 'web/src/components/GlobalUpdateBadge.tsx'),
  'utf8',
);
const pendingImportSource = fs.readFileSync(
  path.resolve(process.cwd(), 'web/src/components/PendingImportInbox.tsx'),
  'utf8',
);
const authTabSource = fs.readFileSync(
  path.resolve(process.cwd(), 'web/src/pages/cds-settings/tabs/AuthTab.tsx'),
  'utf8',
);
const agentDialogSource = fs.readFileSync(
  path.resolve(process.cwd(), 'web/src/components/SkillDownloadDialog.tsx'),
  'utf8',
);
const globalAgentAccessSource = fs.readFileSync(
  path.resolve(process.cwd(), 'web/src/components/GlobalAgentAccess.tsx'),
  'utf8',
);
const appSource = fs.readFileSync(
  path.resolve(process.cwd(), 'web/src/App.tsx'),
  'utf8',
);
const commitInboxSource = fs.readFileSync(
  path.resolve(process.cwd(), 'web/src/components/CommitInbox.tsx'),
  'utf8',
);
const styles = fs.readFileSync(
  path.resolve(process.cwd(), 'web/src/index.css'),
  'utf8',
);
const serverSource = fs.readFileSync(
  path.resolve(process.cwd(), 'src/server.ts'),
  'utf8',
);

describe('CDS 壳层用户入口与授权提醒契约', () => {
  it('把系统设置和用户头像固定在侧栏底部，并将退出收进用户菜单', () => {
    const spacerIndex = shellSource.indexOf('<div className="flex-1" />');
    const footerIndex = shellSource.indexOf('<div className="cds-rail-footer">');
    const settingsIndex = shellSource.indexOf('aria-label="CDS 系统设置"', footerIndex);
    const accountIndex = shellSource.indexOf('<UserAccountMenu', footerIndex);

    expect(spacerIndex).toBeGreaterThan(-1);
    expect(footerIndex).toBeGreaterThan(spacerIndex);
    expect(settingsIndex).toBeGreaterThan(footerIndex);
    expect(accountIndex).toBeGreaterThan(settingsIndex);
    expect(shellSource).toContain('className="cds-rail-item cds-account-trigger"');
    expect(shellSource).toContain('用户与认证');
    expect(shellSource).toContain('退出登录');
    expect(shellSource).not.toContain('cds-rail-item cds-rail-item--danger');
    expect(shellSource).not.toContain('function FloatingThemeToggle');
  });

  it('在侧栏常驻 Agent 接入入口，并由全局壳层提供上下文弹窗', () => {
    const footerIndex = shellSource.indexOf('<div className="cds-rail-footer">');
    const agentIndex = shellSource.indexOf('aria-label="接入 Agent"', footerIndex);
    const settingsIndex = shellSource.indexOf('aria-label="CDS 系统设置"', footerIndex);
    const accountIndex = shellSource.indexOf('<UserAccountMenu', footerIndex);

    expect(agentIndex).toBeGreaterThan(footerIndex);
    expect(settingsIndex).toBeGreaterThan(agentIndex);
    expect(accountIndex).toBeGreaterThan(settingsIndex);
    expect(shellSource).toContain('data-agent-action="connect"');
    expect(shellSource).toContain('data-agent-context={agentContext.id}');
    expect(shellSource).toContain('requestAgentAccess()');
    expect(appSource).toContain('<GlobalAgentAccess />');
    expect(globalAgentAccessSource).toContain('OPEN_AGENT_ACCESS_EVENT');
    expect(globalAgentAccessSource).toContain('<SkillDownloadDialog');
    expect(globalAgentAccessSource).toContain('STANDALONE_PATHS');
    expect(globalAgentAccessSource).toContain('className="cds-agent-access-floating"');
    expect(agentDialogSource).toContain('data-agent-context={context.id}');
    expect(agentDialogSource).toContain('当前页面任务');
  });

  it('登录与认证页可以把 SSO 配置直接交给 Agent，并声明密钥保护策略', () => {
    expect(authTabSource).toContain('data-agent-capability="auth.sso.configure"');
    expect(authTabSource).toContain('data-agent-secret-policy="protected-input-only"');
    expect(authTabSource).toContain("requestAgentAccess('auth')");
    expect(authTabSource).toContain('交给 Agent 配置');
    expect(authTabSource).toContain('客户端密钥只在受保护的输入框中填写');
  });

  it('从认证状态接口向壳层返回安全的用户展示信息', () => {
    expect(serverSource).toContain("app.get('/api/auth/status', (req, res)");
    expect(serverSource).toContain("authMode === 'github' && sessionUser");
    expect(serverSource).toContain('avatarUrl: sessionUser.avatarUrl ?? null');
    expect(shellSource).toContain('user?: ShellUser | null');
  });

  it('将更新、导入和授权统一放在右下角消息栈', () => {
    const stackIndex = shellSource.indexOf('<div className="cds-global-action-stack">');
    const accessIndex = shellSource.indexOf('<AccessRequestInbox />', stackIndex);
    const pendingIndex = shellSource.indexOf('<PendingImportInbox />', stackIndex);
    const updateIndex = shellSource.indexOf('<GlobalUpdateBadge />', stackIndex);

    expect(stackIndex).toBeGreaterThan(-1);
    expect(accessIndex).toBeGreaterThan(stackIndex);
    expect(pendingIndex).toBeGreaterThan(accessIndex);
    expect(updateIndex).toBeGreaterThan(pendingIndex);
    expect(styles).toMatch(/\.cds-global-action-stack\s*\{[\s\S]*?right:\s*1rem;[\s\S]*?bottom:\s*1rem;/);
    expect(shellSource).toContain("data-nav-open={navOpen ? 'true' : 'false'}");
    expect(styles).toContain(".cds-app-shell[data-nav-open='true'] .cds-global-action-stack");
    expect(updateSource).not.toContain('fixed bottom-4 left-4');
    expect(pendingImportSource).not.toContain('fixed bottom-4 right-4');
    expect(commitInboxSource).toContain('fixed bottom-4 left-4');
    expect(commitInboxSource).not.toContain('updateBadgeVisible');
  });

  it('有授权时直接展示申请详情和明确操作，不再退化成小徽章', () => {
    expect(accessSource).toContain('role="alert"');
    expect(accessSource).toContain('aria-live="assertive"');
    expect(accessSource).toContain('需要你的授权');
    expect(accessSource).toContain('{primary.purpose}');
    expect(accessSource).toContain('void reject(primary.id)');
    expect(accessSource).toContain('void approve(primary.id)');
    expect(accessSource).toContain('批准项目访问');
    expect(accessSource).not.toContain('fixed bottom-16 right-4');
    expect(accessSource).toContain('className="max-w-3xl overflow-hidden"');
  });

  it('运维授权弹窗使用更醒目的标题和宽版内容区', () => {
    expect(operatorSource).toContain('需要你的明确授权');
    expect(operatorSource).toContain('className="max-w-2xl overflow-hidden"');
    expect(operatorSource).toContain("style={{ maxHeight: 'min(760px, calc(100dvh - 32px))' }}");
  });
});
