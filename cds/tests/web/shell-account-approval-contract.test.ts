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
const agentMapSource = fs.readFileSync(
  path.resolve(process.cwd(), 'web/src/components/AgentAccessMap.tsx'),
  'utf8',
);
const agentMissionRegistrySource = fs.readFileSync(
  path.resolve(process.cwd(), 'web/src/lib/agent-mission-registry.ts'),
  'utf8',
);
const agentOnboardingSource = fs.readFileSync(
  path.resolve(process.cwd(), 'web/src/lib/agent-onboarding.ts'),
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
const informationCenterSource = fs.readFileSync(
  path.resolve(process.cwd(), 'web/src/components/SiteNoticeInbox.tsx'),
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
  /*
   * 2026-09-02 契约变更（用户选定方向 A）：栏底不再是「五项一起被顶下去」。
   * 工具组（Agent / 缺陷 / 设置）跟着导航贴顶，flex-1 之后的 footer 只留主题与账号——
   * 原来中间空出约 190px，一根栏被读成两根。
   * 仍然钉住的是：撑开的 spacer 存在、footer 在它之后、账号在 footer 里且是最后一项。
   * 设置属于工具组，它的位置由「常驻 Agent 接入入口」那条用例钉。
   */
  it('主题与账号固定在侧栏底部，工具组不跟着被顶下去，退出收进用户菜单', () => {
    const spacerIndex = shellSource.indexOf('<div className="flex-1" />');
    const toolsIndex = shellSource.indexOf('<div className="cds-rail-tools">');
    const footerIndex = shellSource.indexOf('<div className="cds-rail-footer">');
    const themeIndex = shellSource.indexOf('<RailThemeToggle />', footerIndex);
    const accountIndex = shellSource.indexOf('<UserAccountMenu', footerIndex);

    expect(spacerIndex).toBeGreaterThan(-1);
    // 工具组在 spacer 之前——这就是「不跟着被顶到栏底」的机读判据。
    expect(toolsIndex, '工具组不见了').toBeGreaterThan(-1);
    expect(toolsIndex, '工具组跑到 spacer 后面了，中间那段断裂会回来').toBeLessThan(spacerIndex);
    expect(footerIndex).toBeGreaterThan(spacerIndex);
    expect(themeIndex).toBeGreaterThan(footerIndex);
    expect(accountIndex).toBeGreaterThan(themeIndex);
    expect(shellSource).toContain('className="cds-rail-item cds-account-trigger"');
    expect(shellSource).toContain('用户与认证');
    expect(shellSource).toContain('退出登录');
    expect(shellSource).not.toContain('cds-rail-item cds-rail-item--danger');
    expect(shellSource).not.toContain('function FloatingThemeToggle');
  });

  it('在侧栏常驻 Agent 接入入口，并由全局壳层提供上下文弹窗', () => {
    // 2026-09-02：工具组（Agent / 缺陷 / 设置）跟着导航贴顶，栏底只留主题与账号。
    // 顺序契约不变——Agent → 缺陷 → 设置 → 账号，账号仍在最后。
    const toolsIndex = shellSource.indexOf('<div className="cds-rail-tools">');
    const agentIndex = shellSource.indexOf('aria-label="接入 Agent"', toolsIndex);
    const bugIndex = shellSource.indexOf('aria-label="提交缺陷"', toolsIndex);
    const settingsIndex = shellSource.indexOf('aria-label="CDS 系统设置"', toolsIndex);
    const accountIndex = shellSource.indexOf('<UserAccountMenu', toolsIndex);

    expect(toolsIndex, '工具组没了？三个全局动作应当在同一段里').toBeGreaterThan(-1);
    expect(agentIndex).toBeGreaterThan(toolsIndex);
    expect(bugIndex).toBeGreaterThan(agentIndex);
    expect(settingsIndex).toBeGreaterThan(bugIndex);
    expect(accountIndex).toBeGreaterThan(settingsIndex);
    expect(shellSource).toContain('data-agent-action="connect"');
    expect(shellSource).toContain('data-agent-context={agentContext.id}');
    expect(shellSource).toContain('requestAgentAccess()');
    expect(appSource).toContain('<GlobalAgentAccess />');
    expect(globalAgentAccessSource).toContain('OPEN_AGENT_ACCESS_EVENT');
    expect(globalAgentAccessSource).toContain('<SkillDownloadDialog');
    expect(globalAgentAccessSource).toContain('STANDALONE_PATHS');
    expect(globalAgentAccessSource).toContain('className="cds-agent-access-floating"');
    expect(globalAgentAccessSource).toContain("data-preview-instance={isChildPreviewCdsInstance() ? 'true' : 'false'}");
    expect(styles).toMatch(/\.cds-agent-access-floating\[data-preview-instance='true'\]\s*\{[\s\S]*?bottom:\s*4\.75rem;/);
    expect(agentMapSource).toContain('data-agent-context={context.id}');
    expect(agentMapSource).toContain('当前页面任务');
  });

  it('按项目、分类和横排任务卡选择 Agent 上下文', () => {
    expect(agentDialogSource).toContain('<AgentAccessMap');
    // 5 项：上手助手 / 项目初始化 / 自动接入 / 手动安装 / 海鲜市场。
    // 小屏两列避免挤压，sm 以上五列完整横排。
    expect(agentDialogSource).toContain('grid grid-cols-2 gap-1');
    expect(agentDialogSource).toContain('sm:grid-cols-5');
    expect(agentDialogSource).toContain('min-w-0 items-center justify-center');
    expect(agentDialogSource).toContain('resolveAgentMissionContextForTarget(');
    expect(agentDialogSource).toContain('连接已有项目');
    expect(agentDialogSource).toContain('创建一个新项目');
    expect(agentDialogSource).toContain('<select');
    expect(agentMapSource).toContain('选择任务');
    expect(agentMapSource).toContain('选择 Agent 任务');
    expect(agentMapSource).toContain('选择项目');
    expect(agentMapSource).toContain('aria-label="项目范围"');
    expect(agentMapSource).toContain('aria-label="任务分类"');
    expect(agentMapSource).toContain('getAgentMissionCategoriesForScope');
    expect(agentMapSource).toContain('getAgentMissionsForCategory');
    expect(agentMapSource).toContain('`${SYSTEM_AGENT_CONTEXT_IDS.length} 个任务`');
    expect(agentMapSource).toContain('cds-agent-mission-strip');
    expect(agentMapSource).toContain('gridTemplateColumns');
    expect(agentMapSource).toContain('已有权限时不会重复要求批准');
    expect(agentMapSource).not.toContain('AgentTerritoryGeoMap');
    expect(agentMapSource).not.toContain('开辟新大陆');
    expect(agentMapSource).toContain('branchCount');
    expect(agentMapSource).toContain('aria-live="polite"');
    expect(agentMissionRegistrySource).toContain('CDS Agent 任务与提示词的唯一注册表');
    expect(agentMissionRegistrySource).toContain("'build-diagnostics'");
    expect(agentMissionRegistrySource).toContain("'startup-diagnostics'");
    expect(agentMissionRegistrySource).toContain("'api-diagnostics'");
    expect(agentMissionRegistrySource).toContain("'code-review'");
    expect(agentOnboardingSource).toContain('二、静默检查认证');
    expect(agentOnboardingSource).toContain('全局通行证属于认证提权');
    expect(globalAgentAccessSource).toContain('if (!open) return undefined');
    expect(globalAgentAccessSource).toContain('setProjects(null)');
    expect(globalAgentAccessSource).toContain('if (!nextOpen) setRequestedContextId(undefined)');
    expect(globalAgentAccessSource).toContain('onOpenChange={handleOpenChange}');
    expect(globalAgentAccessSource).toContain('[routerLocation.pathname, routerLocation.search, routerLocation.hash]');
    expect(styles).toContain('.cds-agent-mission-strip');
    expect(styles).toContain('.cds-agent-mission-categories');
    expect(styles).toContain('.cds-agent-mission-card');
    expect(styles).toContain(".cds-agent-mission-card[data-selected='true']");
    expect(styles).not.toContain("url('#agent-land-forest')");
    expect(styles).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.cds-agent-mission-card/);
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
    expect(serverSource).toContain("postLogoutRedirect: ssoIdentity ? '/login' : null");
    expect(shellSource).toContain('user?: ShellUser | null');
    expect(shellSource).toContain('authStatus.postLogoutRedirect || shellLoginHref(authStatus.mode)');
  });

  it('将普通提醒放进信息中心，授权申请同时提供右下角决策入口', () => {
    const floatingAccessIndex = informationCenterSource.indexOf('<AccessRequestInbox placement="floating" onCountChange={handleAccessCount} />');
    const accessIndex = informationCenterSource.indexOf('<AccessRequestInbox />');
    const pendingIndex = informationCenterSource.indexOf('<PendingImportInbox onCountChange={handleImportCount} />');
    const updateIndex = informationCenterSource.indexOf('<GlobalUpdateBadge onCountChange={handleUpdateCount} />');
    const commitIndex = informationCenterSource.indexOf('<CommitInbox onCountChange={handleCommitCount} />');

    expect(floatingAccessIndex).toBeGreaterThan(-1);
    expect(accessIndex).toBeGreaterThan(floatingAccessIndex);
    expect(pendingIndex).toBeGreaterThan(accessIndex);
    expect(updateIndex).toBeGreaterThan(pendingIndex);
    expect(commitIndex).toBeGreaterThan(updateIndex);
    expect(shellSource).toContain('id="cds-information-center-host"');
    expect(shellSource).toContain('<SiteNoticeInbox />');
    expect(informationCenterSource).toContain('信息中心');
    expect(informationCenterSource).toContain('informationCount');
    expect(styles).not.toContain('.cds-bottom-docks');
    expect(updateSource).not.toContain('fixed bottom-4 left-4');
    expect(pendingImportSource).not.toContain('fixed bottom-4 right-4');
    expect(commitInboxSource).not.toMatch(/className[^\n]*fixed bottom-4 left-4/);
    expect(commitInboxSource).not.toContain('updateBadgeVisible');
  });

  it('有授权时直接展示申请详情和明确操作，不再退化成小徽章', () => {
    expect(accessSource).toContain("role={placement === 'floating' ? 'alert' : 'region'}");
    expect(accessSource).toContain("aria-live={placement === 'floating' ? 'assertive' : 'off'}");
    expect(accessSource).toContain('需要你的授权');
    expect(accessSource).toContain('{primary.purpose}');
    expect(accessSource).toContain('void reject(primary.id)');
    expect(accessSource).toContain('void approve(primary.id)');
    expect(accessSource).toContain('批准项目访问');
    expect(accessSource).toContain('data-testid="cds-access-request-floating"');
    expect(accessSource).toContain('fixed bottom-[84px] right-5');
    expect(accessSource).toContain('createPortal');
    expect(accessSource).toContain('className="max-w-3xl overflow-hidden"');
  });

  it('运维授权弹窗使用更醒目的标题和宽版内容区', () => {
    expect(operatorSource).toContain('需要你的明确授权');
    expect(operatorSource).toContain('className="max-w-2xl overflow-hidden"');
    expect(operatorSource).toContain("style={{ maxHeight: 'min(760px, calc(100dvh - 32px))' }}");
  });
});
