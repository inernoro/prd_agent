import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { createBootstrapRouter } from '../../src/routes/bootstrap.js';
import { createGithubAuthMiddleware } from '../../src/middleware/github-auth.js';
import type { AuthService } from '../../src/services/auth-service.js';
import type { SkillProxy } from '../../src/services/skill-proxy.js';
import { buildCdsAgentPrompt, createAgentMissionContext } from '../../web/src/lib/agent-onboarding.js';
import { isPublicAgentSetupRoute } from '../../src/shared/agent-setup.js';

describe('Agent public bootstrap through the real auth gate', () => {
  let server: http.Server;
  let origin: string;
  const validateSession = vi.fn().mockResolvedValue(null);

  beforeEach(async () => {
    const app = express();
    app.use(createGithubAuthMiddleware({ authService: { validateSession } as unknown as AuthService }));
    app.use('/api', createBootstrapRouter({
      repoRoot: path.resolve(process.cwd(), '..'), cdsUpstream: '', skillProxy: {} as SkillProxy,
    }));
    app.get('/api/private', (_req, res) => res.json({ secret: 'must-stay-private' }));
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    origin = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('follows the copied short prompt anonymously and loads only the task skills', async () => {
    const prompt = buildCdsAgentPrompt({ cdsOrigin: origin, target: { kind: 'existing', projectId: 'proj-a' }, context: createAgentMissionContext('log-diagnostics', 'proj-a') });
    const url = prompt.match(/https?:\/\/[^，]+/)![0];
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/markdown');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const guide = await response.text();
    expect(guide).toContain('setup-check');
    expect(guide).toContain("--project 'proj-a'");
    expect(guide).toContain('本次只加载这些技能的 SKILL.md：cds-deploy-pipeline');
    expect(guide).not.toContain('本次只加载这些技能的 SKILL.md：cds-release');
    expect(guide.length).toBeLessThan(5000);
    expect(guide).toContain('/api/bootstrap/cds-only');
    expect(guide).toContain('不批量读取五份 SKILL.md');
    expect(guide).toContain('成功时直接复用权限');
    expect(guide).toContain('主机、项目或凭据来源冲突时停止');
    expect(guide).toContain('prebuiltCoverage=all');
    expect(guide).toContain('previewUrl / previewUrls');
    expect(guide).not.toContain('sk-ak-');
  });

  it('exposes version and selection, never resolves project data or mints credentials', async () => {
    const response = await fetch(`${origin}/api/agent/setup.json?target=existing&project=does-not-exist&skills=preview-url`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ version: 'cds-agent-setup.v1', target: { kind: 'existing', projectId: 'does-not-exist' }, skills: ['preview-url'], cliVersion: '0.17.0', authentication: 'existing-page-approval' });
    expect(body.installedSkills).toHaveLength(5);
    expect(body.project).toBeUndefined();
    expect(body.authorizationKey).toBeUndefined();
    expect((await fetch(`${origin}/api/private`)).status).toBe(401);
  });

  it('keeps new-project creation and credential adoption in the existing single command', async () => {
    const guide = await (await fetch(`${origin}/api/agent/setup.md?target=new&skills=cds-project-scan`)).text();
    expect(guide).toContain('connect --host');
    expect(guide).toContain('--new-project --create-project');
    expect(guide).toContain('返回的 projectId 再次执行自检');
  });

  it('system setup never invents a project or instructs project connect', async () => {
    const guide = await (await fetch(`${origin}/api/agent/setup.md?target=system`)).text();
    expect(guide).toContain('--system');
    expect(guide).not.toContain('connect --host');
    expect(guide).toContain('不执行项目 connect');
  });

  it('loads a single mission after connection without losing its registered safety and acceptance rules', async () => {
    const initial = await (await fetch(`${origin}/api/agent/setup.md?target=existing&project=proj-a&mission=startup-diagnostics`)).text();
    expect(initial).toContain('stage=task');
    expect(initial).not.toContain('容器退出码、停止原因和启动日志');
    const task = await (await fetch(`${origin}/api/agent/setup.md?target=existing&project=proj-a&mission=startup-diagnostics&stage=task`)).text();
    const context = createAgentMissionContext('startup-diagnostics', 'proj-a');
    for (const item of [...context.steps, ...context.checks, ...context.completion]) expect(task).toContain(item);
    expect(task).toContain('setup-check');
    const authTask = await (await fetch(`${origin}/api/agent/setup.md?mission=auth&stage=task`)).text();
    expect(authTask).toContain('客户端密钥和登录密码只允许在受保护的页面输入框或运行环境中处理');
  });

  it.each([
    'target=invalid', 'target=existing', 'target=existing&project=x%0Aecho_bad',
    'target=system&project=proj-a', 'skills=../../secret', 'skills=cds&skills=preview-url',
    'target[]=existing&project=proj-a', 'project[]=proj-a&target=existing',
    'stage=unknown', 'mission=unknown', 'mission=__proto__',
    'target[toString]=bad',
  ])('rejects malformed selections rather than reflecting instructions: %s', async (query) => {
    expect((await fetch(`${origin}/api/agent/setup.md?${query}`)).status).toBe(400);
  });

  it('public discovery is GET-only and does not open sibling routes', async () => {
    expect((await fetch(`${origin}/api/agent/setup.md`, { method: 'POST' })).status).toBe(401);
    expect(isPublicAgentSetupRoute('GET', '/api/agent/setup.md/other')).toBe(false);
    expect(isPublicAgentSetupRoute('DELETE', '/api/agent/setup.json')).toBe(false);
  });
});
