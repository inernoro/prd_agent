import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createBootstrapRouter, upstreamSkillPackCache, UpstreamSkillPackCache } from '../../src/routes/bootstrap.js';
import { createGithubAuthMiddleware } from '../../src/middleware/github-auth.js';
import type { AuthService } from '../../src/services/auth-service.js';
import type { SkillProxy } from '../../src/services/skill-proxy.js';
import { buildCdsAgentPrompt, createAgentMissionContext } from '../../web/src/lib/agent-onboarding.js';
import { isPublicAgentSetupRoute } from '../../src/shared/agent-setup.js';
import { AGENT_MISSION_DEFINITIONS, getAgentCapabilitiesForMission } from '../../src/shared/agent-mission-registry.js';

describe('Agent public bootstrap through the real auth gate', () => {
  let server: http.Server;
  let origin: string;
  let bootstrapDeps: Parameters<typeof createBootstrapRouter>[0];
  const validateSession = vi.fn().mockResolvedValue(null);

  beforeEach(async () => {
    const app = express();
    app.use(createGithubAuthMiddleware({ authService: { validateSession } as unknown as AuthService }));
    bootstrapDeps = { repoRoot: path.resolve(process.cwd(), '..'), cdsUpstream: '', skillProxy: {} as SkillProxy };
    app.use('/api', createBootstrapRouter(bootstrapDeps));
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
    expect(body).toMatchObject({ version: 'cds-agent-setup.v1', target: { kind: 'existing', projectId: 'does-not-exist' }, skills: ['preview-url'], minCliVersion: '0.17.5', cliVersion: '0.17.6', authentication: 'existing-page-approval' });
    expect(body.installedSkills).toHaveLength(5);
    expect(body.project).toBeUndefined();
    expect(body.authorizationKey).toBeUndefined();
    expect((await fetch(`${origin}/api/private`)).status).toBe(401);
  });

  it('TLS 在反代前终止时，安装和接入说明均使用已配置的公网 HTTPS 地址', async () => {
    bootstrapDeps.publicBaseUrl = 'https://cds.example.test/';
    for (const endpoint of ['/api/agent/setup.md?target=new&mission=projects', '/api/bootstrap/cds-only']) {
      const response = await fetch(origin + endpoint, { headers: { 'x-forwarded-proto': 'http', 'x-forwarded-host': 'internal.example.test' } });
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain('https://cds.example.test');
      expect(text).not.toContain('http://internal.example.test');
    }
  });

  it('公网配置缺失或不合法时保留原有反代地址解析，不输出配置中的凭据', async () => {
    bootstrapDeps.publicBaseUrl = 'https://user:secret@invalid.test';
    const response = await fetch(origin + '/api/bootstrap/cds-only', { headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'public.example.test' } });
    const text = await response.text();
    expect(text).toContain("CDS_ORIGIN='https://public.example.test'");
    expect(text).not.toContain('user:secret');
  });

  it('anonymous installation includes current hashes for all companion skills and their references', async () => {
    const response = await fetch(`${origin}/api/skills/cds-pack/download`);
    expect(response.status).toBe(200);
    const archive = Buffer.from(await response.arrayBuffer());
    const manifest = JSON.parse(execFileSync('tar', ['-xzOf', '-', 'skills/cds/cli/cds-skill-manifest.json'], { input: archive, encoding: 'utf8' }));
    expect(manifest).toMatchObject({ format: 'agent-skills', version: '0.17.6' });
    for (const skill of manifest.skills) {
      const content = fs.readFileSync(path.resolve(process.cwd(), '../.claude/skills', skill, 'SKILL.md'));
      expect(manifest.files[`${skill}/SKILL.md`]).toBe(createHash('sha256').update(content).digest('hex'));
    }
    expect(manifest.files['cds/cli/cdscli.py']).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.files['cds/reference/api.md']).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.files['cds/cli/cds-skill-manifest.json']).toBeUndefined();
  });

  it.each(Object.values(AGENT_MISSION_DEFINITIONS))('retains every required skill for mission $id', async mission => {
    const target = mission.scope === 'system' ? 'target=system' : 'target=existing&project=proj-a';
    const response = await fetch(`${origin}/api/agent/setup.json?${target}&mission=${mission.id}`);
    expect(response.status).toBe(200);
    const body = await response.json();
    const required = [...new Set([
      ...getAgentCapabilitiesForMission(mission.id).map(item => item.preferredSkill),
      ...(mission.requiredSkills || []),
    ])];
    expect(body.skills).toEqual(required);
  });

  it.each(['project-settings', 'release'])('includes core and specialized instructions for %s', async mission => {
    const guide = await (await fetch(`${origin}/api/agent/setup.md?target=existing&project=proj-a&mission=${mission}`)).text();
    const skills = guide.match(/本次只加载这些技能的 SKILL.md：([^。]+)/)![1].split('、');
    expect(skills).toContain('cds');
    expect(skills).toContain(mission === 'release' ? 'cds-release' : 'cds-project-scan');
  });

  it.each(['projects', 'project-onboarding', 'branches', 'preview-diagnostics', 'rollback'])('loads the preview URL reader for %s', async mission => {
    const query = `target=existing&project=proj-a&mission=${mission}&skills=cds`;
    const manifest = await (await fetch(`${origin}/api/agent/setup.json?${query}`)).json();
    expect(manifest.skills).toContain('preview-url');
    if (mission === 'projects' || mission === 'project-onboarding') expect(manifest.skills).toContain('cds-deploy-pipeline');
    for (const stage of ['connect', 'task']) {
      const guide = await (await fetch(`${origin}/api/agent/setup.md?${query}&stage=${stage}`)).text();
      expect(guide.match(/本次只加载这些技能的 SKILL.md：([^。]+)/)?.[1].split('、')).toContain('preview-url');
    }
  });

  it.each([
    ['CDS.Example:443', 'https', 'https://cds.example'],
    ['CDS.Example:80', 'http', 'http://cds.example'],
    ['CDS.Example:8443', 'https', 'https://cds.example:8443'],
  ])('normalizes a valid proxy origin %s with %s', async (host, proto, canonical) => {
    const headers = { 'x-forwarded-host': host, 'x-forwarded-proto': proto };
    const manifest = await fetch(`${origin}/api/agent/setup.json?target=existing&project=proj-a`, { headers });
    expect(manifest.status).toBe(200);
    const response = await fetch(`${origin}/api/agent/setup.md?target=existing&project=proj-a`, { headers });
    expect(response.status).toBe(200);
    const guide = await response.text();
    expect(guide).toContain(`--host '${canonical}'`);
    expect(guide).toContain(`${canonical}/api/agent/setup.md`);
    expect(guide).not.toContain(host);
  });

  it.each(['owner:password@cds.example', 'cds.example/injected-path', 'cds.example?query=bad', 'cds.example#fragment', 'cds.example/path?query=bad'])('rejects non-origin proxy hosts: %s', async host => {
    for (const suffix of ['md', 'json']) {
      const response = await fetch(`${origin}/api/agent/setup.${suffix}`, {
        headers: { 'x-forwarded-host': host, 'x-forwarded-proto': 'https' },
      });
      expect(response.status).toBe(400);
    }
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

  it.each([
    'target=new&mission=auth',
    'target=existing&project=proj-a&mission=auth',
    'target=system&mission=branches',
  ])('rejects contradictory mission scopes in both stages: %s', async query => {
    for (const stage of ['connect', 'task']) {
      for (const format of ['md', 'json']) {
        expect((await fetch(`${origin}/api/agent/setup.${format}?${query}&stage=${stage}`)).status).toBe(400);
      }
    }
  });

  it.each(['projects', 'project-onboarding'])('preserves the explicit first-project workflow: %s', async mission => {
    const response = await fetch(`${origin}/api/agent/setup.md?target=new&mission=${mission}`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('--new-project --create-project');
    expect((await fetch(`${origin}/api/agent/setup.md?target=new&mission=${mission}&stage=task`)).status).toBe(200);
  });

  it('public discovery is GET-only and does not open sibling routes', async () => {
    expect((await fetch(`${origin}/api/agent/setup.md`, { method: 'POST' })).status).toBe(401);
    expect(isPublicAgentSetupRoute('GET', '/api/agent/setup.md/other')).toBe(false);
    expect(isPublicAgentSetupRoute('DELETE', '/api/agent/setup.json')).toBe(false);
  });
});


describe('setup version follows the actual distributed skill bundle', () => {
  const servers: http.Server[] = [];
  const roots: string[] = [];
  beforeEach(() => {
    const cache = new UpstreamSkillPackCache();
    vi.spyOn(upstreamSkillPackCache, 'get').mockImplementation(url => cache.get(url));
  });
  const listen = async (app: express.Express) => {
    const server = app.listen(0, '127.0.0.1');
    servers.push(server);
    await new Promise<void>(resolve => server.once('listening', resolve));
    return `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  };
  const appFor = (repoRoot: string, cdsUpstream = '') => {
    const app = express();
    app.use('/api', createBootstrapRouter({ repoRoot, cdsUpstream, skillProxy: {} as SkillProxy }));
    return app;
  };
  const tempRoot = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-setup-source-'));
    roots.push(root);
    return root;
  };
  const bundleVersion = (body: Buffer) => JSON.parse(execFileSync('tar', [
    '-xzOf', '-', 'skills/cds/cli/cds-skill-manifest.json',
  ], { input: body, encoding: 'utf8' })).version;

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => {
      server.closeAllConnections();
      return new Promise<void>(resolve => server.close(() => resolve()));
    }));
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('reports the version installed from the supported parent-directory layout', async () => {
    const root = tempRoot();
    const parentSkills = path.join(root, '.claude/skills');
    fs.mkdirSync(parentSkills, { recursive: true });
    for (const skill of ['cds', 'cds-project-scan', 'cds-deploy-pipeline', 'cds-release', 'preview-url']) {
      fs.cpSync(path.resolve(process.cwd(), '../.claude/skills', skill), path.join(parentSkills, skill), { recursive: true });
    }
    const child = path.join(root, 'cds');
    fs.mkdirSync(child);
    const origin = await listen(appFor(child));
    const downloaded = await fetch(`${origin}/api/skills/cds-pack/download`);
    expect(downloaded.status).toBe(200);
    const version = bundleVersion(Buffer.from(await downloaded.arrayBuffer()));
    const metadata = await (await fetch(`${origin}/api/agent/setup.json`)).json();
    expect(metadata.cliVersion).toBe(version);
    expect(metadata.cliVersion).toBe('0.17.6');
  });

  it('reports the cached upstream bundle version instead of an incomplete local CLI', async () => {
    const upstreamApp = express();
    let available = true;
    let downloads = 0;
    upstreamApp.use((req, res, next) => {
      if (req.path === '/api/skills/cds-pack/download') {
        downloads++;
        if (!available) { res.sendStatus(503); return; }
      }
      next();
    });
    upstreamApp.use(appFor(path.resolve(process.cwd(), '..')));
    const upstream = await listen(upstreamApp);
    const root = tempRoot();
    fs.mkdirSync(path.join(root, '.claude/skills/cds/cli'), { recursive: true });
    fs.writeFileSync(path.join(root, '.claude/skills/cds/cli/cdscli.py'), 'VERSION = "0.0.1"\n');
    const origin = await listen(appFor(root, upstream));
    const downloaded = await fetch(`${origin}/api/skills/cds-pack/download`);
    expect(downloaded.status).toBe(200);
    const version = bundleVersion(Buffer.from(await downloaded.arrayBuffer()));
    available = false;
    const metadata = await (await fetch(`${origin}/api/agent/setup.json`)).json();
    expect(metadata.cliVersion).toBe(version);
    expect(metadata.cliVersion).toBe('0.17.6');
    expect(downloads).toBe(1);
  });

  it('fails discovery when the actual upstream bundle is below the server minimum', async () => {
    const upstreamRoot = tempRoot();
    const skills = path.join(upstreamRoot, '.claude/skills');
    fs.mkdirSync(skills, { recursive: true });
    for (const skill of ['cds', 'cds-project-scan', 'cds-deploy-pipeline', 'cds-release', 'preview-url']) {
      fs.cpSync(path.resolve(process.cwd(), '../.claude/skills', skill), path.join(skills, skill), { recursive: true });
    }
    const cli = path.join(skills, 'cds/cli/cdscli.py');
    fs.writeFileSync(path.join(skills, 'cds/upstream-fixture.txt'), 'Distinct upstream fixture content signature');
    fs.writeFileSync(cli, fs.readFileSync(cli, 'utf8').replace(/^VERSION = ".*"/m, 'VERSION = "0.17.4"'));
    const upstream = await listen(appFor(upstreamRoot));
    const origin = await listen(appFor(tempRoot(), upstream));
    const downloaded = await fetch(`${origin}/api/skills/cds-pack/download`);
    expect(bundleVersion(Buffer.from(await downloaded.arrayBuffer()))).toBe('0.17.4');
    const discovery = await fetch(`${origin}/api/agent/setup.json`);
    expect(discovery.status).toBe(503);
    expect(await discovery.json()).toMatchObject({ cliVersion: '0.17.4', minCliVersion: '0.17.5' });
  });
});
