/**
 * 一个仓库喂多个项目时，接口要把「和谁关联」端给界面。
 *
 * 这条线特别容易断得无声无息：判据函数（repo-sharing.ts）单测全绿，路由里
 * 只要少写一行赋值，界面就什么都收不到，而后端测试照样全绿。所以这里从
 * HTTP 出口断言，而不是断言那个函数。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createProjectsRouter } from '../../src/routes/projects.js';
import { StateService } from '../../src/services/state.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import type { GitHubAppClient } from '../../src/services/github-app-client.js';
import type { BuildProfile } from '../../src/types.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';

const REPO = 'octocat/monorepo';

async function call(
  server: http.Server,
  method: string,
  urlPath: string,
  headers?: Record<string, string>,
) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const addr = server.address() as { port: number };
    const req = http.request(
      { hostname: '127.0.0.1', port: addr.port, path: urlPath, method, headers },
      (res) => {
        let raw = '';
        res.on('data', (c: Buffer) => (raw += c.toString()));
        res.on('end', () => resolve({ status: res.statusCode!, body: raw ? JSON.parse(raw) : null }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function get(server: http.Server, urlPath: string, headers?: Record<string, string>) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const addr = server.address() as { port: number };
    const req = http.request(
      { hostname: '127.0.0.1', port: addr.port, path: urlPath, method: 'GET', headers },
      (res) => {
        let raw = '';
        res.on('data', (c: Buffer) => (raw += c.toString()));
        res.on('end', () => resolve({ status: res.statusCode!, body: raw ? JSON.parse(raw) : null }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('项目接口透出同仓关系', () => {
  let tmpDir: string;
  let stateService: StateService;
  let server: http.Server;

  function addProject(id: string, name: string, repo?: string, env?: Record<string, string>) {
    const now = new Date().toISOString();
    stateService.addProject({
      id, slug: id, name, kind: 'git',
      dockerNetwork: `cds-${id}`, legacyFlag: false, createdAt: now, updatedAt: now,
      githubRepoFullName: repo,
      customEnv: env,
    });
  }

  function addProfileWithCommand(projectId: string, id: string, name: string, command: string) {
    stateService.addBuildProfile({
      id, projectId, name,
      dockerImage: 'node:22', workDir: '.', containerPort: 3000,
      hostPortPreference: 0, buildCommand: 'echo build', command,
    } as BuildProfile);
  }

  function addScope(projectId: string, buildScope: string[]) {
    stateService.addBuildProfile({
      id: `${projectId}-p`, projectId, name: 'app',
      dockerImage: 'node:22', workDir: '/app', containerPort: 3000,
      hostPortPreference: 0, buildCommand: 'echo build', buildScope,
    } as BuildProfile);
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-reposharing-'));
    stateService = new StateService(path.join(tmpDir, 'state.json'), tmpDir);
    stateService.load();
    const app = express();
    app.use(express.json());
    // 模拟 server.ts 的鉴权标记：带 cds-cookie 头的当人类 cookie 会话，其余不标记
    // —— 后者同时覆盖「CDS_AUTH_MODE=disabled 的实例根本不签会话」这一档。
    app.use((req, _res, next) => {
      if (req.headers['cds-cookie'] === '1') (req as any)._cdsCookieAuth = true;
      next();
    });
    app.use('/api', createProjectsRouter({
      stateService,
      shell: new MockShellExecutor(),
      githubApp: { getInstallationToken: async () => 't' } as GitHubAppClient,
    }));
    server = app.listen(0);
  });

  afterEach(async () => {
    await flushAllJsonStateStores();
    await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('详情接口给出兄弟项目和一句结论', async () => {
    addProject('p-main', 'MAP', REPO);
    addProject('p-self', 'CDS Self', REPO);

    const res = await get(server, '/api/projects/p-main');
    expect(res.status).toBe(200);
    const sharing = res.body.repoSharing;
    // 界面要能点进兄弟项目，所以必须给 id + 名字，不是一个计数
    expect(sharing.siblings.map((s: any) => s.id).sort()).toEqual(['p-main', 'p-self']);
    expect(sharing.total).toBe(2);
    // 两个项目都没划范围 —— 这正是最该被看见的一档
    expect(sharing.level).toBe('warn');
    expect(sharing.headline).toContain('全部重建');
  });

  it('各自划了范围就不再报警', async () => {
    addProject('p-main', 'MAP', REPO);
    addProject('p-self', 'CDS Self', REPO);
    addScope('p-main', ['prd-api/**']);
    addScope('p-self', ['cds/**']);

    const res = await get(server, '/api/projects/p-main');
    expect(res.body.repoSharing.level).toBe('ok');
    expect(res.body.repoSharing.unscoped).toBe(0);
  });

  it('撞在同一个库上时点名是哪个变量撞的', async () => {
    addProject('p-main', 'MAP', REPO, { MONGO_URL: 'mongodb://box:27017/shared' });
    addProject('p-self', 'CDS Self', REPO, { MONGO_URL: 'mongodb://box:27017/shared' });

    const hits = (await get(server, "/api/projects/p-main")).body.repoSharing.sharedInfra;
    expect(hits).toHaveLength(1);
    expect(hits[0].key).toBe('MONGO_URL');
    expect(hits[0].kind).toBe('database');
  });

  it('列表接口每个项目都带上同仓关系', async () => {
    addProject('p-main', 'MAP', REPO);
    addProject('p-self', 'CDS Self', REPO);

    const res = await get(server, '/api/projects');
    const byId = new Map(res.body.projects.map((p: any) => [p.id, p]));
    expect((byId.get('p-main') as any).repoSharing.total).toBe(2);
    expect((byId.get('p-self') as any).repoSharing.total).toBe(2);
  });

  it('单项目仓库什么都不显示，不给人凭空加一个概念', async () => {
    addProject('p-only', '独苗', REPO);

    const res = await get(server, '/api/projects/p-only');
    expect(res.body.repoSharing).toBeNull();
  });

  it('机器凭据拿不到同仓关系：它可能只被授权了本项目', async () => {
    addProject('p-main', 'MAP', REPO, { MONGO_URL: 'mongodb://box:27017/shared' });
    addProject('p-self', 'CDS Self', REPO, { MONGO_URL: 'mongodb://box:27017/shared' });

    for (const headers of [
      { 'x-ai-access-key': 'cdsp_someprojectkey' },
      { 'ai-access-key': 'cdsg_someglobalkey' },
      { authorization: 'Bearer cdsu_someusercredential' },
    ]) {
      const res = await get(server, '/api/projects/p-main', headers);
      expect(res.body.repoSharing, JSON.stringify(headers)).toBeNull();
    }
  });

  it('不签会话的实例（CDS_AUTH_MODE=disabled）里，真人照样看得见', async () => {
    // 判据若写成「是不是 cookie 会话」，这一档永远为假 —— 真人用浏览器打开
    // 什么都看不到，而且不会有任何报错。
    addProject('p-main', 'MAP', REPO);
    addProject('p-self', 'CDS Self', REPO);

    const res = await get(server, '/api/projects/p-main');
    expect(res.body.repoSharing?.total).toBe(2);
  });

  it('横幅拿得到「本项目看起来只关心哪儿」，用户不必从空白开始', async () => {
    addProject('p-main', 'MAP', REPO);
    addProject('p-self', 'CDS Self', REPO);
    addProfileWithCommand('p-self', 'cds', 'cds', 'cd cds && ./exec_cds.sh start');

    const res = await get(server, '/api/projects/p-self');
    expect(res.body.repoSharing.scopeSuggestion.scope).toEqual(['cds/**']);
    expect(res.body.repoSharing.scopeSuggestion.why).toContain('cd cds');
  });

  it('自己已经划过范围的项目不再被劝', async () => {
    addProject('p-main', 'MAP', REPO);
    addProject('p-self', 'CDS Self', REPO);
    addScope('p-self', ['cds/**']);

    const res = await get(server, '/api/projects/p-self');
    expect(res.body.repoSharing.scopeSuggestion).toBeNull();
  });
});

describe('划范围的候选与一键采纳', () => {
  let tmpDir: string;
  let stateService: StateService;
  let server: http.Server;

  function addProject(id: string, name: string) {
    const now = new Date().toISOString();
    stateService.addProject({
      id, slug: id, name, kind: 'git',
      dockerNetwork: `cds-${id}`, legacyFlag: false, createdAt: now, updatedAt: now,
      githubRepoFullName: REPO, repoPath: tmpDir,
    });
  }

  function addProfile(projectId: string, id: string, extra: Partial<BuildProfile>) {
    stateService.addBuildProfile({
      id, projectId, name: id,
      dockerImage: 'node:22', workDir: '.', containerPort: 3000,
      hostPortPreference: 0, buildCommand: 'echo build',
      ...extra,
    } as BuildProfile);
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-scopeopt-'));
    stateService = new StateService(path.join(tmpDir, 'state.json'), tmpDir);
    stateService.load();
    // 仓库里真实存在的一级目录 —— 候选清单读的是磁盘，不是编的
    for (const d of ['cds', 'prd-api', 'prd-admin', '.git', 'node_modules']) {
      fs.mkdirSync(path.join(tmpDir, d), { recursive: true });
    }
    const app = express();
    app.use(express.json());
    app.use('/api', createProjectsRouter({
      stateService,
      shell: new MockShellExecutor(),
      githubApp: { getInstallationToken: async () => 't' } as GitHubAppClient,
    }));
    server = app.listen(0);
  });

  afterEach(async () => {
    await flushAllJsonStateStores();
    await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('候选目录来自仓库实际内容，且不含点目录与 node_modules', async () => {
    addProject('p-self', 'CDS Self');
    const res = await get(server, '/api/projects/p-self/scope-options');
    expect(res.body.repoDirs).toEqual(['cds', 'prd-admin', 'prd-api']);
  });

  it('每个服务分开给「你定过的」和「我猜的」，让用户判断该不该信', async () => {
    addProject('p-self', 'CDS Self');
    addProfile('p-self', 'cds', { command: 'cd cds && ./exec_cds.sh start' });
    addProfile('p-self', 'api', { deployModes: { express: { buildScope: ['prd-api/**'] } } as any });

    const res = await get(server, '/api/projects/p-self/scope-options');
    const byId = Object.fromEntries(res.body.profiles.map((p: any) => [p.id, p]));
    expect(byId.cds).toMatchObject({ declared: [], suggested: ['cds/**'] });
    expect(byId.cds.why).toContain('cd cds');
    expect(byId.api).toMatchObject({ declared: ['prd-api/**'], suggested: [] });
  });

  it('一键采纳只写没声明过的那些，人做过的决定不被一次猜覆盖', async () => {
    addProject('p-self', 'CDS Self');
    addProfile('p-self', 'cds', { command: 'cd cds && ./exec_cds.sh start' });
    addProfile('p-self', 'api', { buildScope: ['prd-api/**'], command: 'cd 别处 && x' });

    const res = await call(server, 'POST', '/api/projects/p-self/scope-options/apply');
    expect(res.status).toBe(200);
    expect(res.body.applied).toEqual([{ profileId: 'cds', scope: ['cds/**'] }]);
    expect(stateService.getBuildProfile('cds')?.buildScope).toEqual(['cds/**']);
    // 已声明的那条原样不动
    expect(stateService.getBuildProfile('api')?.buildScope).toEqual(['prd-api/**']);
  });

  it('有服务看不出待在哪时整个项目不给建议 —— 按已知的收窄会让它静默不重建', async () => {
    addProject('p-self', 'CDS Self');
    addProfile('p-self', 'cds', { command: 'cd cds && ./exec_cds.sh start' });
    addProfile('p-self', 'mystery', { command: 'dotnet run' });

    const options = await get(server, '/api/projects/p-self/scope-options');
    expect(options.body.suggestion).toBeNull();

    const applied = await call(server, 'POST', '/api/projects/p-self/scope-options/apply');
    expect(applied.status).toBe(409);
    expect(applied.body.error).toBe('no_suggestion');
  });

  it('全都已经声明过时没有可采纳的东西', async () => {
    addProject('p-self', 'CDS Self');
    addProfile('p-self', 'cds', { buildScope: ['cds/**'] });
    const applied = await call(server, 'POST', '/api/projects/p-self/scope-options/apply');
    expect(applied.status).toBe(409);
  });
});
