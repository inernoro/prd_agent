import { describe, expect, it } from 'vitest';
import {
  buildCdsAgentPrompt,
  chooseAgentProjectId,
  createAgentMissionContext,
  getAgentMissionScope,
  PROJECT_SKILL_PATHS,
  resolveAgentPageContext,
} from '../../web/src/lib/agent-onboarding.js';
import {
  createAgentTerritoryLayout,
  createAgentTerritoryWeights,
} from '../../web/src/lib/agent-territory.js';

describe('CDS Agent 接入口令', () => {
  it('已有项目口令不含密钥，不修改全局环境，并使用页面批准', () => {
    const prompt = buildCdsAgentPrompt({
      cdsOrigin: 'https://cds.example',
      target: { kind: 'existing', projectId: 'proj-a' },
    });

    expect(prompt).toContain('connect --host https://cds.example --project proj-a');
    expect(prompt).toContain('不要向我索要或展示任何密钥');
    expect(prompt).toContain('不要修改系统环境变量、shell profile 或全局 PATH');
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
    expect(prompt).toContain('缺 preview-url 视为接入未完成');
    expect(prompt).toContain('必须调用 preview-url 技能');
    expect(prompt).toContain('previewUrl / previewUrls');
    expect(prompt).toContain('主应用、模型网关等独立命名服务都属于实际入口');
    expect(prompt).toContain('CDS 返回几条就全部列出');
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
    expect(prompt).toContain('创建权限使用一次后会自动切换为项目级权限');
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

  it('地图任务切换会生成真实功能路径并区分系统与项目范围', () => {
    expect(createAgentMissionContext('auth').pagePath).toBe('/cds-settings#auth');
    expect(createAgentMissionContext('github').pagePath).toBe('/cds-settings#github');
    expect(createAgentMissionContext('branches', 'project/a').pagePath).toBe('/branches/project%2Fa');
    expect(createAgentMissionContext('project-settings', 'project/a').pagePath).toBe('/settings/project%2Fa');
    expect(getAgentMissionScope('auth')).toBe('system');
    expect(getAgentMissionScope('branches')).toBe('project');
  });

  it('按项目规模预测连续地图面积，并限制最大最小地块比例', () => {
    const projects = [
      { id: 'small', name: '小项目', slug: 'small', branchCount: 0 },
      { id: 'medium', name: '中项目', slug: 'medium', branchCount: 8, runningBranchCount: 2 },
      { id: 'large', name: '大项目', slug: 'large', branchCount: 120, runningBranchCount: 18 },
    ];
    const weights = createAgentTerritoryWeights(projects);
    const small = weights.find((item) => item.key === 'project:small')?.weight || 0;
    const medium = weights.find((item) => item.key === 'project:medium')?.weight || 0;
    const large = weights.find((item) => item.key === 'project:large')?.weight || 0;

    expect(medium).toBeGreaterThan(small);
    expect(large).toBeGreaterThan(medium);
    expect(large / small).toBeLessThanOrEqual(1.65 / 0.72);
  });

  it('领土地块完整覆盖地图且不会越界', () => {
    const layout = createAgentTerritoryLayout([
      { id: 'a', name: 'A', slug: 'a', branchCount: 2 },
      { id: 'b', name: 'B', slug: 'b', branchCount: 12 },
      { id: 'c', name: 'C', slug: 'c', branchCount: 5 },
      { id: 'd', name: 'D', slug: 'd', branchCount: 1 },
    ]);

    expect(layout).toHaveLength(6);
    expect(layout.reduce((sum, item) => sum + item.areaPercent, 0)).toBeCloseTo(100, 8);
    for (const territory of layout) {
      expect(territory.x).toBeGreaterThanOrEqual(0);
      expect(territory.y).toBeGreaterThanOrEqual(0);
      expect(territory.x + territory.width).toBeLessThanOrEqual(100.0000001);
      expect(territory.y + territory.height).toBeLessThanOrEqual(100.0000001);
      expect(territory.areaPercent).toBeGreaterThan(0);
    }
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
