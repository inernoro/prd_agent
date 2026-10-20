import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AGENT_MISSION_CAPABILITY_BINDINGS,
  AGENT_MISSION_CATEGORY_DEFINITIONS,
  AGENT_MISSION_DEFINITIONS,
  CDS_AGENT_CAPABILITY_DEFINITIONS,
  CDS_AGENT_SKILL_DEFINITIONS,
  buildCdsAgentPrompt,
  chooseAgentProjectId,
  createAgentMissionContext,
  getAgentMissionCategoriesForScope,
  getAgentMissionsForCategory,
  getAgentMissionScope,
  initialAgentConnectSelection,
  PROJECT_SKILL_PATHS,
  resolveAgentConnectTarget,
  resolveAgentPageContext,
  resolveAgentMissionContextForTarget,
} from '../../web/src/lib/agent-onboarding.js';

describe('CDS Agent 接入口令', () => {
  it('默认短接入能从零创建项目，认证页面仍保留系统范围', () => {
    expect(initialAgentConnectSelection([], createAgentMissionContext('projects'))).toEqual({ kind: 'new' });
    expect(initialAgentConnectSelection([{ id: 'cds-self' }], createAgentMissionContext('projects'))).toEqual({ kind: 'new' });
    expect(initialAgentConnectSelection([], createAgentMissionContext('auth'))).toEqual({ kind: 'system' });
  });
  it('已有项目生成不含密钥的短入口，目标可由服务端解析', () => {
    const prompt = buildCdsAgentPrompt({ cdsOrigin: 'https://cds.example', target: { kind: 'existing', projectId: 'proj-a' } });
    const url = new URL(prompt.match(/https:\/\/[^，]+/)![0]);
    expect(url.pathname).toBe('/api/agent/setup.md');
    expect(url.searchParams.get('target')).toBe('existing');
    expect(url.searchParams.get('project')).toBe('proj-a');
    expect(prompt.length).toBeLessThan(600);
    expect(prompt).toContain('自检通过后再执行');
    expect(prompt).not.toContain('AI_ACCESS_KEY');
    expect(prompt).not.toContain('export-skill');
  });

  it('新建与系统任务保持独立目标，不能拿占位项目代替', () => {
    for (const kind of ['new', 'system'] as const) {
      const prompt = buildCdsAgentPrompt({ cdsOrigin: 'https://cds.example', target: { kind } });
      const url = new URL(prompt.match(/https:\/\/[^，]+/)![0]);
      expect(url.searchParams.get('target')).toBe(kind);
      expect(url.searchParams.has('project')).toBe(false);
      if (kind === 'new') expect(url.searchParams.get('skills')).toContain('cds-project-scan');
    }
  });

  it('系统任务即使发现 CDS Self 项目也不能降为项目授权', () => {
    const target = resolveAgentConnectTarget({ tab: 'connect', selection: { kind: 'system' }, effectiveProjectId: 'cds-self' });
    expect(target).toEqual({ kind: 'system' });
    const prompt = buildCdsAgentPrompt({ cdsOrigin: 'https://cds.example', target, context: createAgentMissionContext('auth') });
    expect(prompt).toContain('target=system');
    expect(prompt).not.toContain('project=');
  });

  it('页面指定的项目不在可见列表时保留目标，不改成第一项或新建项目', () => {
    const projects = [{ id: 'other', name: '其他项目', slug: 'other' }];
    for (const context of [
      resolveAgentPageContext({ pathname: '/branches/unavailable' }),
      resolveAgentPageContext({ pathname: '/release-center', search: '?project=unavailable' }),
    ]) {
      expect(chooseAgentProjectId(projects, context)).toBe('');
      expect(initialAgentConnectSelection(projects, context)).toEqual({ kind: 'project', projectId: 'unavailable' });
      expect(initialAgentConnectSelection([], context)).toEqual({ kind: 'project', projectId: 'unavailable' });
    }
  });

  it('每个任务只携带所需技能引用，不再复制全部能力目录与操作手册', () => {
    for (const contextId of Object.keys(AGENT_MISSION_DEFINITIONS) as Array<keyof typeof AGENT_MISSION_DEFINITIONS>) {
      const context = createAgentMissionContext(contextId, 'proj-a');
      const prompt = buildCdsAgentPrompt({ cdsOrigin: 'https://cds.example', target: { kind: 'existing', projectId: 'proj-a' }, context });
      expect(prompt.length, contextId).toBeLessThan(1000);
      expect(prompt).toContain(context.title);
      expect(prompt).not.toContain('已登记能力：');
      expect(prompt).not.toContain('建议执行顺序：');
    }
    const prompt = buildCdsAgentPrompt({ cdsOrigin: 'https://cds.example', target: { kind: 'existing', projectId: 'proj-a' }, context: createAgentMissionContext('log-diagnostics', 'proj-a') });
    const url = new URL(prompt.match(/https:\/\/[^，]+/)![0]);
    expect(url.searchParams.get('skills')).toContain('cds-deploy-pipeline');
    expect(url.searchParams.get('skills')).not.toContain('cds-release');
  });

  it('上手助手保留系统目标，新项目由项目入口明确选择', () => {
    const fromProjectList = resolveAgentConnectTarget({
      tab: 'starter',
      selection: initialAgentConnectSelection([], createAgentMissionContext('projects')),
      effectiveProjectId: '',
    });
    expect(fromProjectList).toEqual({ kind: 'new' });
    expect(
      buildCdsAgentPrompt({ cdsOrigin: 'https://cds.example', target: fromProjectList }),
    ).toContain('target=new');

    // 系统设置任务切换页签不能变成新建项目，也不能借 CDS Self 顶替。
    expect(
      resolveAgentConnectTarget({ tab: 'starter', selection: { kind: 'system' }, effectiveProjectId: 'cds-self' }),
    ).toEqual({ kind: 'system' });

    // 用户在上手助手上主动选「连接已有项目」时仍然尊重选择
    expect(
      resolveAgentConnectTarget({ tab: 'starter', selection: { kind: 'project', projectId: 'proj-a' }, effectiveProjectId: 'proj-a' }),
    ).toEqual({ kind: 'existing', projectId: 'proj-a' });

    // 自动接入页签的语义不变：system 选择仍走系统任务口令
    expect(
      resolveAgentConnectTarget({ tab: 'connect', selection: { kind: 'system' }, effectiveProjectId: '' }),
    ).toEqual({ kind: 'system' });
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
    expect(context.pagePath).toBe('/cds-settings#auth');
    expect(prompt).toContain('登录与 SSO 认证');
    expect(prompt).not.toContain('clientSecret=');
    expect(prompt).not.toContain('CDS_PASSWORD=');
  });

  it('未登录且没有项目时，短入口保留系统范围', () => {
    const prompt = buildCdsAgentPrompt({ cdsOrigin: 'https://cds.example', target: { kind: 'system' }, context: resolveAgentPageContext({ pathname: '/login' }) });
    expect(prompt).toContain('target=system');
    expect(prompt).not.toContain('project=');
    expect(prompt).not.toContain('<project-id>');
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
    expect(createAgentMissionContext('release', 'project/a').pagePath).toContain('project=project%2Fa');
    expect(createAgentMissionContext('tasks', 'project/a').pagePath).toBe('/task-schedule?project=project%2Fa');
    expect(createAgentMissionContext('reports', 'project/a').pagePath).toBe('/reports?project=project%2Fa');
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

  it('把全部 CDS 路由模块登记为带认证与风险的能力，不把内部协议伪装成普通任务', () => {
    const registeredSources = new Set(CDS_AGENT_CAPABILITY_DEFINITIONS.map((item) => item.routeSource));
    const routeSources = fs.readdirSync(path.resolve(process.cwd(), 'src/routes'))
      .filter((name) => name.endsWith('.ts'));

    for (const routeSource of routeSources) {
      expect(registeredSources.has(routeSource), `能力目录缺少 ${routeSource}`).toBe(true);
    }
    expect(registeredSources).toContain('server.ts');
    expect(registeredSources).toContain('scheduler/routes.ts');
    expect(registeredSources).toContain('executor/routes.ts');
    expect(CDS_AGENT_CAPABILITY_DEFINITIONS).toHaveLength(routeSources.length + 3);
    expect(CDS_AGENT_CAPABILITY_DEFINITIONS.every((item) => item.access && item.risk && item.agentUse)).toBe(true);
    expect(CDS_AGENT_CAPABILITY_DEFINITIONS.find((item) => item.id === 'executor-agent')?.agentUse).toBe('internal-only');
    expect(CDS_AGENT_CAPABILITY_DEFINITIONS.find((item) => item.id === 'bridge')?.agentUse).toBe('protocol-only');
  });

  it('每个任务都绑定真实能力，并声明完整五技能包', () => {
    const capabilityIds = new Set(CDS_AGENT_CAPABILITY_DEFINITIONS.map((item) => item.id));
    expect(CDS_AGENT_SKILL_DEFINITIONS.map((item) => item.id)).toEqual([
      'cds',
      'cds-project-scan',
      'cds-deploy-pipeline',
      'cds-release',
      'preview-url',
    ]);
    for (const missionId of Object.keys(AGENT_MISSION_DEFINITIONS)) {
      const bindings = AGENT_MISSION_CAPABILITY_BINDINGS[missionId as keyof typeof AGENT_MISSION_CAPABILITY_BINDINGS];
      expect(bindings.length, `${missionId} 没有能力绑定`).toBeGreaterThan(0);
      expect(bindings.every((id) => capabilityIds.has(id)), `${missionId} 绑定了未知能力`).toBe(true);
    }
  });

  it('为 MCP 适配明确登记候选、审批或禁止暴露状态', () => {
    // 43 = 40 + uptime（自建存活监控只读能力）+ bug-reports（快捷提 bug，2026-07-27）
    //    + bootstrap（项目初始化路由，匿名只读，2026-07-28）
    //    + cds-system-offsite-backup（离机备份配置入口，2026-08-19）
    //    + topology（服务关系图、拓扑体检与引用切换，含 PUT 故按写能力登记，2026-09-02）
    //    + credential-self-check（凭据自检，匿名只读诊断，2026-09-01）
    //    + identity（身份层：主体 / 用户级凭证 / 项目授权，2026-09-01）
    //    + project-db-isolation（项目级数据库隔离原子读写，2026-09-02）
    //    + db-probe（分支数据库实测，只读，2026-09-03）
    //    + db-ledger（数据台账：备份 / 演练 / 丢弃门禁，2026-09-03）
    //    + public-status（公开状态页：匿名只读面板 + 项目侧开关，2026-09-11）
    //    + cds-system-sealed-storage（密封存储初始化，只允许全局人工管理员同源发起，2026-09-06）
    //    + infra-credential-rotation（基础设施凭据轮换，密封存储就绪 + 作业排空后才可执行，2026-09-06）
    //    + alarm-channels（通知通道：哪些出问题通知谁，2026-09-15）
    //    + user-project-access（人类账号项目授权，仅系统所有者，2026-10-03）
    //    + cds-system-diagnostics（主线程诊断与按需 CPU 采样，只读观测，2026-10-08）
    expect(CDS_AGENT_CAPABILITY_DEFINITIONS).toHaveLength(57);
    expect(CDS_AGENT_CAPABILITY_DEFINITIONS.find(capability => capability.id === 'user-project-access'))
      .toMatchObject({ access: 'human-only', agentUse: 'guided', risk: 'write' });
    expect(CDS_AGENT_CAPABILITY_DEFINITIONS.every((capability) => capability.mcpExposure)).toBe(true);
    expect(
      CDS_AGENT_CAPABILITY_DEFINITIONS
        .filter((capability) => capability.agentUse === 'protocol-only' || capability.agentUse === 'internal-only')
        .every((capability) => capability.mcpExposure === 'not-exposed'),
    ).toBe(true);
    expect(
      CDS_AGENT_CAPABILITY_DEFINITIONS
        .filter((capability) => capability.mcpExposure === 'read-only-candidate')
        .every((capability) => capability.risk === 'read-only' && capability.agentUse === 'direct'),
    ).toBe(true);
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

  it('认证任务保留页面批准与权限复用要求', () => {
    const prompt = buildCdsAgentPrompt({ cdsOrigin: 'https://cds.example', target: { kind: 'existing', projectId: 'proj-a' }, context: createAgentMissionContext('agent-access') });
    expect(prompt).toContain('复用现有授权');
    expect(prompt).toContain('CDS 页面批准');
    expect(prompt).toContain('不输出密钥');
  });

  it('专项排障保留目标，具体执行步骤按需加载', () => {
    const context = createAgentMissionContext('startup-diagnostics', 'proj-a');
    const prompt = buildCdsAgentPrompt({ cdsOrigin: 'https://cds.example', target: { kind: 'existing', projectId: 'proj-a' }, context });
    expect(prompt).toContain('服务无法启动排查');
    expect(prompt).toContain(context.goal);
    expect(prompt).not.toContain(context.steps.join('\n'));
  });

  it('系统级页面优先连接 CDS Self，项目页面按 URL 选择当前项目', () => {
    const projects = [
      { id: 'prd-agent', name: 'MAP平台', slug: 'prd-agent' },
      { id: 'cds-self', name: 'CDS Self', slug: 'cds-self' },
      { id: 'other', name: '其他项目', slug: 'other' },
    ];
    const authContext = resolveAgentPageContext({ pathname: '/cds-settings', hash: '#auth' });
    const branchContext = resolveAgentPageContext({ pathname: '/branches/other' });
    const reportContext = resolveAgentPageContext({ pathname: '/reports', search: '?project=other' });
    const requestsContext = resolveAgentPageContext({ pathname: '/agent-requests/other' });
    const legacyBranchContext = resolveAgentPageContext({
      pathname: '/branch-list',
      search: '?project=other',
    });

    expect(chooseAgentProjectId(projects, authContext)).toBe('cds-self');
    expect(chooseAgentProjectId(projects, branchContext)).toBe('other');
    expect(chooseAgentProjectId(projects, reportContext)).toBe('other');
    expect(chooseAgentProjectId(projects, requestsContext)).toBe('other');
    expect(chooseAgentProjectId(projects, legacyBranchContext)).toBe('other');
    expect(chooseAgentProjectId(projects)).toBe('prd-agent');
    expect(chooseAgentProjectId(
      projects.filter((project) => project.id !== 'cds-self'),
      authContext,
    )).toBe('');
  });

  it('切换项目地图后重新生成当前任务上下文', () => {
    const projects = [
      { id: 'proj-a', name: '项目 A', slug: 'proj-a' },
      { id: 'proj-b', name: '项目 B', slug: 'proj-b' },
    ];
    const sourceContext = resolveAgentPageContext({ pathname: '/branches/proj-a' });

    const selectedContext = resolveAgentMissionContextForTarget(
      sourceContext.id,
      sourceContext,
      projects,
      'proj-b',
    );

    expect(selectedContext.id).toBe('branches');
    expect(selectedContext.pagePath).toBe('/branches/proj-b');
    expect(selectedContext.pagePath).not.toBe(sourceContext.pagePath);
  });

  it('列出三个 Agent 的项目级技能目录', () => {
    expect(PROJECT_SKILL_PATHS).toEqual([
      { agent: 'Codex / 通用 Agent Skills', path: '.agents/skills' },
      { agent: 'Claude Code', path: '.claude/skills' },
    ]);
  });
});
