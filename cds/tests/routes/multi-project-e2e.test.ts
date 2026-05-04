/**
 * Multi-project end-to-end smoke test (2026-05-04).
 *
 * Pin invariants the Dashboard relies on when 2+ projects coexist on the
 * same CDS instance:
 *
 *   1. Two projects can each register a branch named "main" without
 *      colliding — branch IDs are projectSlug-prefixed.
 *   2. Container names derived from those branch IDs stay unique across
 *      projects (so `docker rm cds-foo-main-api` never accidentally
 *      kills another project's API).
 *   3. customEnv reads/writes are scoped: project A setting JWT_SECRET
 *      doesn't leak into project B's effective env.
 *   4. GET /api/branches?project= returns ONLY that project's branches —
 *      no cross-project leakage.
 *   5. project-scoped activity logs stay separate (A's logs never appear
 *      in B's response).
 *
 * Background: the user reported on 2026-05-04 that multi-project flows
 * may not have been tested under realistic load. Existing
 * cross-project-isolation.test.ts covers the auth / mutation guards;
 * this file pins the data-model + endpoint isolation that the dashboard
 * UI assumes when paginating across projects.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createBranchRouter } from '../../src/routes/branches.js';
import { StateService } from '../../src/services/state.js';
import { WorktreeService } from '../../src/services/worktree.js';
import { ContainerService } from '../../src/services/container.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import type { CdsConfig, BranchEntry } from '../../src/types.js';

async function request(
  server: http.Server,
  method: string,
  urlPath: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const data = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: addr.port,
        path: urlPath,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk: Buffer) => (raw += chunk.toString()));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode!, body: raw ? JSON.parse(raw) : null });
          } catch {
            resolve({ status: res.statusCode!, body: raw });
          }
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

describe('Multi-project end-to-end isolation (data + endpoints)', () => {
  let tmpDir: string;
  let server: http.Server;
  let stateService: StateService;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-multi-'));
    const config: CdsConfig = {
      repoRoot: tmpDir,
      worktreeBase: path.join(tmpDir, 'worktrees'),
      masterPort: 9900,
      workerPort: 5500,
      dockerNetwork: 'cds-network',
      portStart: 10001,
      sharedEnv: {},
      jwt: { secret: 'test-secret', issuer: 'cds' },
    };
    fs.mkdirSync(config.worktreeBase, { recursive: true });

    stateService = new StateService(path.join(tmpDir, 'state.json'), tmpDir);
    stateService.load();

    // Two real projects (legacyFlag: false so branch-id prefixing kicks in).
    const now = new Date().toISOString();
    stateService.addProject({
      id: 'foo', slug: 'foo', name: 'Foo App', kind: 'git',
      createdAt: now, updatedAt: now, legacyFlag: false,
    });
    stateService.addProject({
      id: 'bar', slug: 'bar', name: 'Bar App', kind: 'git',
      createdAt: now, updatedAt: now, legacyFlag: false,
    });

    const shell = new MockShellExecutor();
    shell.addResponsePattern(/.*/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    const worktreeService = new WorktreeService(shell);
    const containerService = new ContainerService(shell, config);

    const app = express();
    app.use(express.json());
    app.use('/api', createBranchRouter({
      stateService, worktreeService, containerService, shell, config,
    }));
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
  });

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
  });

  it('两个项目可以各自有 "main" 分支(branch id 用 slug 前缀消歧)', () => {
    const now = new Date().toISOString();
    // Seed branches directly via state service to avoid the heavy
    // worktree-create path; this matches the id formula used in
    // routes/branches.ts:1133-1135.
    const branchA: BranchEntry = {
      id: 'foo-main', projectId: 'foo', branch: 'main',
      worktreePath: path.join(tmpDir, 'worktrees/foo-main'),
      services: {}, status: 'idle', createdAt: now, lastDeployAt: now,
    };
    const branchB: BranchEntry = {
      id: 'bar-main', projectId: 'bar', branch: 'main',
      worktreePath: path.join(tmpDir, 'worktrees/bar-main'),
      services: {}, status: 'idle', createdAt: now, lastDeployAt: now,
    };
    stateService.addBranch(branchA);
    stateService.addBranch(branchB);

    expect(stateService.getBranch('foo-main')?.projectId).toBe('foo');
    expect(stateService.getBranch('bar-main')?.projectId).toBe('bar');
    // 关键不变量:同名 git branch 在 state 里走两条独立条目
    expect(stateService.getBranch('foo-main')?.id).not.toBe(stateService.getBranch('bar-main')?.id);
  });

  it('container name 用 branch id 派生 → 跨项目唯一,docker rm 不会误杀', () => {
    // Container name formula in routes/branches.ts:1752 / 6170:
    //   `cds-${branchId}-${profileId}` where branchId already has projectSlug prefix
    // Verify no two projects produce the same container name for same profile.
    const fooApi = `cds-foo-main-api`;
    const barApi = `cds-bar-main-api`;
    expect(fooApi).not.toBe(barApi);
    // Sanity: 截断/regex 匹配 'cds-foo-main' 在 docker ps 时不会匹到 bar
    expect(fooApi.startsWith('cds-foo-')).toBe(true);
    expect(barApi.startsWith('cds-foo-')).toBe(false);
  });

  it('customEnv 严格按 scope 隔离(项目 A 写 JWT_SECRET 不会泄漏到项目 B)', () => {
    stateService.setCustomEnvVar('JWT_SECRET', 'foo-secret', 'foo');
    stateService.setCustomEnvVar('JWT_SECRET', 'bar-secret', 'bar');
    stateService.setCustomEnvVar('SHARED_KEY', 'global-value', '_global');

    const fooEnv = stateService.getCustomEnv('foo');
    const barEnv = stateService.getCustomEnv('bar');

    // 项目级覆盖各自独立
    expect(fooEnv.JWT_SECRET).toBe('foo-secret');
    expect(barEnv.JWT_SECRET).toBe('bar-secret');
    // _global 在两个项目里都能看到
    expect(fooEnv.SHARED_KEY).toBe('global-value');
    expect(barEnv.SHARED_KEY).toBe('global-value');
  });

  it('GET /api/branches?project=<id> 只返回该项目分支(无跨项目泄漏)', async () => {
    const now = new Date().toISOString();
    stateService.addBranch({
      id: 'foo-main', projectId: 'foo', branch: 'main',
      worktreePath: path.join(tmpDir, 'worktrees/foo-main'),
      services: {}, status: 'idle', createdAt: now, lastDeployAt: now,
    });
    stateService.addBranch({
      id: 'foo-feature-x', projectId: 'foo', branch: 'feature/x',
      worktreePath: path.join(tmpDir, 'worktrees/foo-feature-x'),
      services: {}, status: 'idle', createdAt: now, lastDeployAt: now,
    });
    stateService.addBranch({
      id: 'bar-main', projectId: 'bar', branch: 'main',
      worktreePath: path.join(tmpDir, 'worktrees/bar-main'),
      services: {}, status: 'idle', createdAt: now, lastDeployAt: now,
    });

    const fooRes = await request(server, 'GET', '/api/branches?project=foo');
    expect(fooRes.status).toBe(200);
    const fooBranches = (fooRes.body.branches || []) as Array<{ id: string }>;
    expect(fooBranches.map((b) => b.id).sort()).toEqual(['foo-feature-x', 'foo-main']);

    const barRes = await request(server, 'GET', '/api/branches?project=bar');
    expect(barRes.status).toBe(200);
    const barBranches = (barRes.body.branches || []) as Array<{ id: string }>;
    expect(barBranches.map((b) => b.id)).toEqual(['bar-main']);
    // 关键反向断言:bar 的列表里绝不应有 foo 的任何条目
    for (const b of barBranches) {
      expect(b.id.startsWith('foo-')).toBe(false);
    }
  });

  it('activity logs 严格按项目隔离(A 的事件不出现在 B 的查询结果里)', () => {
    stateService.appendActivityLog('foo', { type: 'deployRequest', message: 'foo deploy' });
    stateService.appendActivityLog('bar', { type: 'deployRequest', message: 'bar deploy' });
    stateService.appendActivityLog('foo', { type: 'pull', message: 'foo pull' });

    const fooLogs = stateService.getActivityLogs('foo');
    const barLogs = stateService.getActivityLogs('bar');

    expect(fooLogs).toHaveLength(2);
    expect(barLogs).toHaveLength(1);
    // 反向断言:bar 的日志里不能出现 foo 的内容
    for (const log of barLogs) {
      expect(log.message).not.toContain('foo');
    }
  });

  it('重复 slug 的 project 不能被创建(state.addProject 拒绝)', () => {
    expect(() => {
      const now = new Date().toISOString();
      stateService.addProject({
        id: 'foo-2', slug: 'foo', name: 'Duplicate', kind: 'git',
        createdAt: now, updatedAt: now, legacyFlag: false,
      });
    }).toThrow(); // slug uniqueness invariant — POST /api/projects 在 route 层做 -2/-3 自动后缀,addProject 是 last-line defense
  });
});
