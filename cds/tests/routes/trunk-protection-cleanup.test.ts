/**
 * 一键删除类路由的主干保护回归（2026-07-27 P0：CDS 把主分支 main 删掉了）。
 *
 * 上一轮把判定收敛进 `branch-protection.ts`（SSOT），但只接了 janitor / scheduler /
 * GitHub delete webhook —— **用户可一键触发的删分支路径全都没接**，事故根因原样还在。
 * 本套用「事故值」逐条守住这些路径：
 *
 *   项目的 gitDefaultBranch = main，而全局 state.defaultBranch 未配置或指向别的分支
 *   → main 绝不进删除集合；同时普通分支必须照常被清理（保护不能宽到把功能废掉）。
 *
 * 覆盖：POST /api/cleanup、POST /api/cleanup-orphans（含 fetch 异常守卫）、
 * POST /api/branches/cleanup-stopped、POST /api/factory-reset。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { createBranchRouter } from '../../src/routes/branches.js';
import { StateService } from '../../src/services/state.js';
import { WorktreeService } from '../../src/services/worktree.js';
import { ContainerService } from '../../src/services/container.js';
import { BranchOperationCoordinator } from '../../src/services/branch-operation-coordinator.js';
import { DeploymentRunService } from '../../src/services/deployment-run.js';
import { DeploymentVersionService } from '../../src/services/deployment-version.js';
import { ManagedProjectService } from '../../src/services/managed-project.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import type { BranchEntry, CdsConfig, Project } from '../../src/types.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';

type SseEvent = { event: string; data: Record<string, unknown> };

/** 发一个请求，返回原始文本（SSE 路由）与解析后的 JSON（普通路由）。 */
async function request(
  server: http.Server,
  method: string,
  urlPath: string,
  body?: unknown,
): Promise<{ status: number; raw: string; json: unknown }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const data = body ? JSON.stringify(body) : undefined;
    const req = http.request({
      hostname: '127.0.0.1', port: addr.port, path: urlPath, method,
      headers: {
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (chunk: Buffer) => (raw += chunk.toString()));
      res.on('end', () => {
        let json: unknown = null;
        try { json = JSON.parse(raw); } catch { /* SSE 流，不是 JSON */ }
        resolve({ status: res.statusCode!, raw, json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/** 把 SSE 文本拆成事件列表。 */
function parseSse(raw: string): SseEvent[] {
  const events: SseEvent[] = [];
  for (const block of raw.split('\n\n')) {
    const eventLine = block.split('\n').find((l) => l.startsWith('event:'));
    const dataLine = block.split('\n').find((l) => l.startsWith('data:'));
    if (!eventLine || !dataLine) continue;
    try {
      events.push({
        event: eventLine.slice('event:'.length).trim(),
        data: JSON.parse(dataLine.slice('data:'.length).trim()),
      });
    } catch { /* 心跳等非 JSON 事件忽略 */ }
  }
  return events;
}

function completeOf(raw: string): Record<string, unknown> {
  const done = parseSse(raw).find((e) => e.event === 'complete');
  if (!done) throw new Error(`SSE 里没有 complete 事件：${raw.slice(0, 400)}`);
  return done.data;
}

const NOW = '2026-01-01T00:00:00.000Z';

describe('一键清理路径的主干保护（事故回归）', () => {
  let tmpDir: string;
  let server: http.Server;
  let stateService: StateService;
  let mock: MockShellExecutor;

  function makeConfig(root: string): CdsConfig {
    return {
      repoRoot: root,
      worktreeBase: path.join(root, 'worktrees'),
      masterPort: 9900,
      workerPort: 5500,
      dockerNetwork: 'cds-network',
      portStart: 10001,
      rootDomains: ['example.test'],
      previewDomain: 'example.test',
      sharedEnv: {},
      jwt: { secret: 'test-secret', issuer: 'prdagent' },
    };
  }

  function addProject(id: string, over: Partial<Project> = {}): void {
    stateService.addProject({
      id, slug: id, name: id, kind: 'git',
      createdAt: NOW, updatedAt: NOW,
      ...over,
    } as Project);
  }

  /** 造一条分支。默认已停止（services 里有 stopped 服务），以便 cleanup-stopped 命中。 */
  function addBranch(id: string, branch: string, projectId: string, over: Partial<BranchEntry> = {}): BranchEntry {
    const entry: BranchEntry = {
      id,
      projectId,
      branch,
      worktreePath: path.join(tmpDir, 'worktrees', id),
      status: 'idle',
      createdAt: NOW,
      services: {
        api: { profileId: 'api', containerName: `cds-${id}-api`, hostPort: 10001, status: 'stopped' },
      },
      ...over,
    };
    stateService.addBranch(entry);
    return entry;
  }

  function branchIds(): string[] {
    return Object.keys(stateService.getState().branches).sort();
  }

  beforeEach(async () => {
    process.env.CDS_BRANCH_NETWORK_ISOLATION = '0';
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-trunk-guard-'));
    fs.mkdirSync(path.join(tmpDir, 'worktrees'), { recursive: true });
    const config = makeConfig(tmpDir);
    mock = new MockShellExecutor();
    mock.addResponsePattern(/git worktree/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/git fetch/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/test -d/, () => ({ stdout: '', stderr: '', exitCode: 1 }));

    stateService = new StateService(path.join(tmpDir, 'state.json'));
    stateService.load();

    const worktreeService = new WorktreeService(mock, config.repoRoot);
    const containerService = new ContainerService(mock, config);
    const serverEventLogStore = { record() { /* 测试里不关心事件落盘 */ } };
    const app = express();
    app.use(express.json());
    app.use('/api', createBranchRouter({
      stateService,
      worktreeService,
      containerService,
      shell: mock,
      config,
      registry: { getAll: () => [], getOnline: () => [], selectExecutor: () => null } as any,
      branchOperationCoordinator: new BranchOperationCoordinator(serverEventLogStore as any),
      serverEventLogStore: serverEventLogStore as any,
      deploymentRunService: new DeploymentRunService(stateService),
      deploymentVersionService: new DeploymentVersionService(stateService),
      managedProjectService: new ManagedProjectService(stateService),
    }));
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  });

  afterEach(async () => {
    await flushAllJsonStateStores();
    delete process.env.CDS_BRANCH_NETWORK_ISOLATION;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  // ── POST /api/cleanup ──

  describe('POST /api/cleanup', () => {
    it('事故值：项目 gitDefaultBranch=main、全局 defaultBranch 未配置时，选中该项目清理不会删掉 main', async () => {
      addProject('acme', { gitDefaultBranch: 'main' });
      addBranch('acme-main', 'main', 'acme');
      addBranch('acme-feat', 'feat/login', 'acme');
      expect(stateService.getState().defaultBranch ?? null).toBeNull();

      const res = await request(server, 'POST', '/api/cleanup?project=acme');

      expect(res.status).toBe(200);
      expect(branchIds()).toEqual(['acme-main']);
      const done = completeOf(res.raw);
      expect(done.removedCount).toBe(1);
      expect(done.skippedProtected).toEqual([
        expect.objectContaining({ branchId: 'acme-main', branchName: 'main', reason: 'trunk-branch' }),
      ]);
    });

    it('事故值：全局 defaultBranch 指向别的项目的分支时，本项目 main 依然受保护', async () => {
      addProject('proj-a', { gitDefaultBranch: 'main' });
      addProject('proj-b', { gitDefaultBranch: 'main' });
      stateService.setDefaultBranch('proj-b-main');
      addBranch('proj-a-main', 'main', 'proj-a');
      addBranch('proj-b-main', 'main', 'proj-b');
      addBranch('proj-a-feat', 'feat/x', 'proj-a');

      const res = await request(server, 'POST', '/api/cleanup?project=proj-a');

      expect(res.status).toBe(200);
      expect(branchIds()).toEqual(['proj-a-main', 'proj-b-main']);
      const done = completeOf(res.raw);
      expect((done.skippedProtected as Array<{ branchId: string }>).map((n) => n.branchId)).toEqual(['proj-a-main']);
    });

    it('全局清理（无 project 过滤）同样保住各项目主干，普通分支照常清理', async () => {
      addProject('p1', { gitDefaultBranch: 'main' });
      addProject('p2');
      addBranch('p1-main', 'main', 'p1');
      addBranch('p2-master', 'master', 'p2');
      addBranch('p2-feat', 'feature/a', 'p2');
      addBranch('p1-mainline', 'mainline', 'p1'); // 名字像主干但不是

      const res = await request(server, 'POST', '/api/cleanup');

      expect(branchIds()).toEqual(['p1-main', 'p2-master']);
      expect(completeOf(res.raw).removedCount).toBe(2);
    });
  });

  // ── POST /api/branches/cleanup-stopped ──

  describe('POST /api/branches/cleanup-stopped', () => {
    it('事故值：已停止的 main 不进删除集合，其余已停止分支照常清理', async () => {
      addProject('acme', { gitDefaultBranch: 'main' });
      addBranch('acme-main', 'main', 'acme');
      addBranch('acme-feat', 'feat/login', 'acme');

      const res = await request(server, 'POST', '/api/branches/cleanup-stopped?project=acme');

      expect(res.status).toBe(200);
      const body = res.json as { removedCount: number; skippedProtectedCount: number; skippedProtected: Array<{ branchId: string; reason: string }> };
      expect(body.removedCount).toBe(1);
      expect(body.skippedProtectedCount).toBe(1);
      expect(body.skippedProtected[0]).toMatchObject({ branchId: 'acme-main', branchName: 'main', reason: 'trunk-branch' });
      expect(branchIds()).toEqual(['acme-main']);
    });
  });

  // ── POST /api/cleanup-orphans ──

  describe('POST /api/cleanup-orphans', () => {
    /** 让 for-each-ref 返回指定的远端分支列表。 */
    function mockRemoteBranches(names: string[]): void {
      mock.addResponsePattern(/for-each-ref/, () => ({
        stdout: names.join('\n'), stderr: '', exitCode: 0,
      }));
    }

    it('事故值：远端已无 main（改名/删除）时，main 被算成孤儿也不得删除', async () => {
      addProject('acme', { gitDefaultBranch: 'main', cloneStatus: 'ready' } as Partial<Project>);
      addBranch('acme-main', 'main', 'acme');
      addBranch('acme-gone', 'feat/gone', 'acme');
      addBranch('acme-live', 'feat/live', 'acme');
      mockRemoteBranches(['feat/live', 'develop']);

      const res = await request(server, 'POST', '/api/cleanup-orphans?project=acme');

      expect(res.status).toBe(200);
      expect(branchIds()).toEqual(['acme-live', 'acme-main']);
      const done = completeOf(res.raw);
      expect(done.orphanCount).toBe(1);
      expect((done.skippedProtected as Array<{ branchId: string }>).map((n) => n.branchId)).toEqual(['acme-main']);
    });

    it('fetch 异常守卫：远端分支集合为空时中止本项目清理，一个分支都不删', async () => {
      addProject('acme', { gitDefaultBranch: 'main', cloneStatus: 'ready' } as Partial<Project>);
      addBranch('acme-main', 'main', 'acme');
      addBranch('acme-feat', 'feat/a', 'acme');
      mockRemoteBranches([]); // fetch 部分失败 / 远端异常 → 空集合

      const res = await request(server, 'POST', '/api/cleanup-orphans?project=acme');

      expect(branchIds()).toEqual(['acme-feat', 'acme-main']);
      const done = completeOf(res.raw);
      expect(done.orphanCount).toBe(0);
      const aborted = done.abortedProjects as Array<{ projectId: string; reason: string }>;
      expect(aborted.map((a) => a.projectId)).toEqual(['acme']);
      expect(String(aborted[0].reason)).toContain('fetch 异常');
      expect(String(done.message)).toContain('未删除任何分支');
    });
  });

  // ── POST /api/factory-reset ──

  describe('POST /api/factory-reset', () => {
    it('存在主干且不带 confirmTrunk 时整体拒绝：不许留下「分支还在但配置被清空」的僵尸', async () => {
      addProject('acme', { gitDefaultBranch: 'main' });
      addBranch('acme-main', 'main', 'acme');
      addBranch('acme-feat', 'feat/login', 'acme');

      const res = await request(server, 'POST', '/api/factory-reset?project=acme');

      // 一个分支都不许动（拒绝必须发生在任何破坏性动作之前）
      expect(branchIds().sort()).toEqual(['acme-feat', 'acme-main']);
      expect(res.raw).toContain('confirmTrunk=1');
      expect(res.raw).toContain('僵尸');
    });

    it('带 confirmTrunk=1 才连主干一起清空，且响应里列明将删除的主干', async () => {
      addProject('acme', { gitDefaultBranch: 'main' });
      addBranch('acme-main', 'main', 'acme');
      addBranch('acme-feat', 'feat/login', 'acme');

      const res = await request(server, 'POST', '/api/factory-reset?project=acme&confirmTrunk=1');

      expect(branchIds()).toEqual([]);
      const done = completeOf(res.raw);
      expect(done.removedTrunkBranches).toEqual([{ branchId: 'acme-main', branchName: 'main' }]);
      expect(done.keptTrunkBranches).toEqual([]);
    });

    it('全局恢复出厂：存在主干且不带 confirmTrunk 时整体拒绝，状态一律不动', async () => {
      addProject('p1', { gitDefaultBranch: 'main' });
      addProject('p2');
      addBranch('p1-main', 'main', 'p1');
      addBranch('p2-master', 'master', 'p2');
      addBranch('p2-feat', 'feat/a', 'p2');

      const res = await request(server, 'POST', '/api/factory-reset');

      expect(branchIds().sort()).toEqual(['p1-main', 'p2-feat', 'p2-master']);
      expect(res.raw).toContain('confirmTrunk=1');
      // 拒绝发生在清空之前：配置必须原封不动
      expect(stateService.getState().branches['p1-main']).toBeTruthy();
    });

    it('全局恢复出厂带 confirmTrunk=1 时清空一切，包括主干', async () => {
      addProject('p1', { gitDefaultBranch: 'main' });
      addBranch('p1-main', 'main', 'p1');
      addBranch('p1-feat', 'feat/a', 'p1');

      const res = await request(server, 'POST', '/api/factory-reset?confirmTrunk=1');

      expect(branchIds()).toEqual([]);
      expect((completeOf(res.raw).removedTrunkBranches as unknown[]).length).toBe(1);
    });
  });
});

describe('恢复出厂设置不得留下僵尸主干（Codex PR #1273 P1）', () => {
  it('源码守卫：存在主干且未带 confirmTrunk 时必须整体拒绝，而不是保留分支再清空它的配置', () => {
    const src = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../../src/routes/branches.ts'),
      'utf-8',
    );
    // 两条路径（scoped / global）各有一道拒绝守卫
    const guards = src.match(/恢复出厂设置会清空构建配置、路由规则、环境变量与基础设施/g) || [];
    expect(guards.length).toBe(2);
    // 拒绝必须发生在「保留主干」的分支里
    expect(src).toContain('if (!includeTrunk && trunkSplit.trunk.length > 0)');
    expect(src).toContain('if (!globalIncludeTrunk && globalTrunkSplit.trunk.length > 0)');
  });
});
