import { describe, expect, it } from 'vitest';
import {
  AGENT_MISSION_CATEGORY_DEFINITIONS,
  AGENT_MISSION_DEFINITIONS,
  buildCdsAgentPrompt,
  chooseAgentProjectId,
  createAgentMissionContext,
  getAgentMissionCategoriesForScope,
  getAgentMissionsForCategory,
  getAgentMissionScope,
  PROJECT_SKILL_PATHS,
  resolveAgentPageContext,
} from '../../web/src/lib/agent-onboarding.js';

describe('CDS Agent 接入口令', () => {
  it('已有项目口令不含密钥，不修改全局环境，并使用页面批准', () => {
    const prompt = buildCdsAgentPrompt({
      cdsOrigin: 'https://cds.example',
      target: { kind: 'existing', projectId: 'proj-a' },
    });

    expect(prompt).toContain('connect --host https://cds.example --project proj-a');
    expect(prompt).toContain('不要向我索要、展示或复述任何密钥');
    expect(prompt).toContain('不要修改系统环境变量、shell profile、用户主目录或全局 PATH');
    expect(prompt).toContain('先在当前仓库运行 cds 技能内的 cli/cdscli.py auth check');
    expect(prompt).toContain('cdscli project show proj-a');
    expect(prompt.indexOf('auth check')).toBeLessThan(prompt.indexOf('connect --host'));
    expect(prompt).not.toContain('AI_ACCESS_KEY=');
    expect(prompt).not.toContain('CDS_PROJECT_KEY=');
    expect(prompt).not.toContain('~/.claude');
  });

  it('强制安装 preview-url 并从 CDS API 验证真实多入口', () => {
    const prompt = buildCdsAgentPrompt({
      cdsOrigin: 'https://cds.example',
      target: { kind: 'existing', projectId: 'proj-a' },
    });

    expect(prompt).toContain('cds-project-scan、preview-url');
    expect(prompt).toContain('如果 cds、cds-deploy-pipeline、cds-project-scan、preview-url 四个技能已经存在且能读取，直接复用');
    expect(prompt).toContain('涉及部署或预览时必须调用 preview-url 技能');
    expect(prompt).toContain('previewUrl / previewUrls');
    expect(prompt).toContain('返回几条就验证并列出几条');
    expect(prompt).toContain('所有入口只使用公开 previewDomain');
    expect(prompt).toContain('rootDomains 可能包含隐藏、备用或内部域名，禁止向用户暴露');
    expect(prompt).toContain('禁止把 rootDomains 数量当成入口数量');
    expect(prompt).toContain('禁止根据分支名、项目名、profileId、CDS host 或旧公式自行拼接');
  });

  it('首次接入口令申请一次性新项目权限', () => {
    const prompt = buildCdsAgentPrompt({
      cdsOrigin: 'https://cds.example',
      target: { kind: 'new' },
    });
    expect(prompt).toContain('--new-project');
    expect(prompt).toContain('一次性创建权限会自动吊销并换成该项目的长期项目级凭据');
  });

  it('从登录与认证页面生成 SSO 专属上下文，并禁止密钥进入对话', () => {
    const context = resolveAgentPageContext({
      pathname: '/cds-settings',
      hash: '#auth',
    });
    const prompt = buildCdsAgentPrompt({
      cdsOrigin: 'https://cds.example',
      target: { kind: 'existing', projectId: 'proj-a' },
      context,
    });

    expect(context.id).toBe('auth');
    expect(prompt).toContain('登录与 SSO 认证');
    expect(prompt).toContain('https://cds.example/cds-settings#auth');
    expect(prompt).toContain('/api/auth/status');
    expect(prompt).toContain('/api/auth/sso/config');
    expect(prompt).toContain('客户端密钥和登录密码只允许在受保护的页面输入框或运行环境中处理');
    expect(prompt).toContain('SSO 登录后默认返回 /project-list');
    expect(prompt).not.toContain('clientSecret=');
    expect(prompt).not.toContain('CDS_PASSWORD=');
  });

  it('为常用页面解析稳定的 Agent 任务上下文', () => {
    expect(resolveAgentPageContext({ pathname: '/project-list' }).id).toBe('projects');
    expect(resolveAgentPageContext({ pathname: '/branches/project-a' }).id).toBe('branches');
    expect(resolveAgentPageContext({ pathname: '/settings/project-a' }).id).toBe('project-settings');
    expect(resolveAgentPageContext({ pathname: '/release-center' }).id).toBe('release');
    expect(resolveAgentPageContext({ pathname: '/cds-settings', hash: '#maintenance' }).id).toBe('maintenance');
    expect(resolveAgentPageContext({ pathname: '/login' }).id).toBe('auth');
  });

  it('任务切换会生成真实功能路径并区分系统与项目范围', () => {
    expect(createAgentMissionContext('auth').pagePath).toBe('/cds-settings#auth');
    expect(createAgentMissionContext('github').pagePath).toBe('/cds-settings#github');
    expect(createAgentMissionContext('branches', 'project/a').pagePath).toBe('/branches/project%2Fa');
    expect(createAgentMissionContext('project-settings', 'project/a').pagePath).toBe('/settings/project%2Fa');
    expect(getAgentMissionScope('auth')).toBe('system');
    expect(getAgentMissionScope('branches')).toBe('project');
  });

  it('把全部 Agent 任务集中到七类注册表并覆盖常见 CDS 操作', () => {
    expect(AGENT_MISSION_CATEGORY_DEFINITIONS.map((category) => category.id)).toEqual([
      'access',
      'inspect',
      'deploy',
      'integrate',
      'code',
      'operate',
      'deliver',
    ]);
    expect(Object.keys(AGENT_MISSION_DEFINITIONS).length).toBeGreaterThanOrEqual(24);
    expect(AGENT_MISSION_DEFINITIONS).toHaveProperty('code-review');
    expect(AGENT_MISSION_DEFINITIONS).toHaveProperty('build-diagnostics');
    expect(AGENT_MISSION_DEFINITIONS).toHaveProperty('startup-diagnostics');
    expect(AGENT_MISSION_DEFINITIONS).toHaveProperty('api-diagnostics');
    expect(AGENT_MISSION_DEFINITIONS).toHaveProperty('agent-access');
    for (const definition of Object.values(AGENT_MISSION_DEFINITIONS)) {
      expect(definition.steps.length).toBeGreaterThanOrEqual(3);
      expect(definition.checks.length).toBeGreaterThanOrEqual(3);
      expect(definition.completion.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('分类只返回当前作用域中的任务', () => {
    const systemCategories = getAgentMissionCategoriesForScope('system');
    const projectDeploy = getAgentMissionsForCategory('project', 'deploy');

    expect(systemCategories.some((category) => category.id === 'access')).toBe(true);
    expect(projectDeploy.map((mission) => mission.id)).toEqual([
      'branches',
      'build-diagnostics',
      'startup-diagnostics',
      'preview-diagnostics',
    ]);
    expect(projectDeploy.every((mission) => mission.scope === 'project')).toBe(true);
  });

  it('认证提示词静默复用项目权限，并对跨项目永久授权要求明确提权', () => {
    const context = createAgentMissionContext('agent-access');
    const prompt = buildCdsAgentPrompt({
      cdsOrigin: 'https://cds.example',
      target: { kind: 'existing', projectId: 'proj-a' },
      context,
    });

    expect(prompt).toContain('成功时不要让用户重新登录或批准');
    expect(prompt).toContain('项目级凭据是长期授权');
    expect(prompt).toContain('.cds/credentials.json');
    expect(prompt).toContain('/cds-settings#access-keys');
    expect(prompt).toContain('全局通行证属于认证提权');
    expect(prompt).toContain('Agent 不得自行签发、扩大或批准自己的权限');
    expect(prompt).toContain('不支持多个指定项目的组合');
  });

  it('专项排障任务把真实 CDS 操作步骤写入提示词', () => {
    const context = createAgentMissionContext('startup-diagnostics', 'proj-a');
    const prompt = buildCdsAgentPrompt({
      cdsOrigin: 'https://cds.example',
      target: { kind: 'existing', projectId: 'proj-a' },
      context,
    });

    expect(prompt).toContain('服务无法启动排查');
    expect(prompt).toContain('cdscli diagnose 或 help-me-check');
    expect(prompt).toContain('容器退出码、停止原因和启动日志');
    expect(prompt).toContain('容器持续运行');
  });

  it('系统级页面优先连接 CDS Self，项目页面按 URL 选择当前项目', () => {
    const projects = [
      { id: 'prd-agent', name: 'MAP平台', slug: 'prd-agent' },
      { id: 'cds-self', name: 'CDS Self', slug: 'cds-self' },
      { id: 'other', name: '其他项目', slug: 'other' },
    ];
    const authContext = resolveAgentPageContext({ pathname: '/cds-settings', hash: '#auth' });
    const branchContext = resolveAgentPageContext({ pathname: '/branches/other' });

    expect(chooseAgentProjectId(projects, authContext)).toBe('cds-self');
    expect(chooseAgentProjectId(projects, branchContext)).toBe('other');
    expect(chooseAgentProjectId(projects)).toBe('prd-agent');
  });

  it('列出三个 Agent 的项目级技能目录', () => {
    expect(PROJECT_SKILL_PATHS).toEqual([
      { agent: 'Codex / 通用 Agent Skills', path: '.agents/skills' },
      { agent: 'Cursor', path: '.cursor/skills' },
      { agent: 'Claude Code', path: '.claude/skills' },
    ]);
  });
});
