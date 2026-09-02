/**
 * 一仓多项目：清理类副作用必须在**路由层**对每个项目都真的发出去。
 *
 * 这条线断过一次，而且断得很安静（2026-09-02 Codex P1）：dispatcher 已经把每个项目的
 * stopRequest / branchDeleteRequest 都算出来放进 fanout 了，路由却只消费主结果那一条。
 * 于是第二个项目的容器一直挂着、分支条目一直留着，没有任何报错。
 *
 * 分发器的单测断不到这一层——它只看得到返回的载荷，看不到「有没有人把载荷用掉」。
 * 所以这里从 HTTP 入口打真实 webhook，拦 fetch 数真正发出去的清理请求。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHmac } from 'node:crypto';
import { StateService } from '../../src/services/state.js';
import { WorktreeService } from '../../src/services/worktree.js';
import type { IShellExecutor, CdsConfig } from '../../src/types.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';
import {
  createGithubWebhookRouter,
  __resetWebhookDedupForTests,
} from '../../src/routes/github-webhook.js';

const REPO = 'octocat/monorepo';
const SHA = 'abc123def456789012345678901234567890aaaa';
const SECRET = 'whsec-test';

class MockShell implements IShellExecutor {
  async exec() { return { stdout: '', stderr: '', exitCode: 0 }; }
}
class MockWorktree extends WorktreeService {
  override async create() { /* no-op */ }
}

function post(server: http.Server, event: string, payload: unknown): Promise<number> {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const req = http.request(
      {
        hostname: '127.0.0.1', port: addr.port, path: '/api/github/webhook', method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'X-GitHub-Event': event,
          'X-GitHub-Delivery': `d-${Math.random().toString(36).slice(2)}`,
          'X-Hub-Signature-256': `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`,
        },
      },
      (res) => { res.resume(); res.on('end', () => resolve(res.statusCode!)); },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

describe('一仓多项目：清理请求要对每个项目都发出去', () => {
  let tmp: string;
  let stateService: StateService;
  let server: http.Server;
  /** 拦下来的内部清理调用：[method, branchId] */
  let calls: Array<{ method: string; branchId: string }>;
  let realFetch: typeof globalThis.fetch;

  function addProject(id: string, slug: string, name: string): void {
    const now = new Date().toISOString();
    stateService.addProject({
      id, slug, name, kind: 'git', createdAt: now, updatedAt: now,
      githubRepoFullName: REPO, githubInstallationId: 42,
    });
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-wh-fanout-'));
    stateService = new StateService(path.join(tmp, 'state.json'), tmp);
    stateService.load();
    __resetWebhookDedupForTests();
    calls = [];

    realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const m = /\/api\/branches\/([^/?]+)(\/stop)?/.exec(url);
      if (m) {
        calls.push({ method: (init?.method || 'GET').toUpperCase(), branchId: decodeURIComponent(m[1]) });
        return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('{}', { status: 200 });
    }) as typeof globalThis.fetch;

    const shell = new MockShell();
    const config: CdsConfig = {
      repoRoot: '/tmp/repo', worktreeBase: '/tmp/wt', masterPort: 9900, workerPort: 5500,
      dockerNetwork: 'cds', portStart: 10001, sharedEnv: {},
      jwt: { secret: 'x'.repeat(32), issuer: 'cds' }, mode: 'standalone', executorPort: 9901,
      githubApp: { appId: '1', privateKey: 'unused', webhookSecret: SECRET },
    };
    const app = express();
    app.use(express.json({ verify: (req, _res, buf) => { (req as { rawBody?: Buffer }).rawBody = buf; } }));
    app.use('/api', createGithubWebhookRouter({
      stateService,
      worktreeService: new MockWorktree(shell),
      shell,
      config,
      githubApp: null,
      dispatchDeploy: async () => { /* 部署那条早就分发了，这里不是本用例的判据 */ },
    }));
    server = app.listen(0);
  });

  afterEach(async () => {
    globalThis.fetch = realFetch;
    vi.useRealTimers();
    await flushAllJsonStateStores();
    if (server) await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  async function seedTwoBranches(): Promise<void> {
    addProject('p-main', 'mainp', 'MAP');
    addProject('p-self', 'selfp', 'CDS Self');
    await post(server, 'push', {
      ref: 'refs/heads/feature/x',
      after: SHA,
      repository: { id: 1, full_name: REPO },
      commits: [{ added: [], modified: ['src/app.ts'], removed: [] }],
    });
    expect(stateService.findBranchByProjectAndName('p-main', 'feature/x')).toBeDefined();
    expect(stateService.findBranchByProjectAndName('p-self', 'feature/x')).toBeDefined();
    calls.length = 0;
  }

  it('关 PR：两个项目的预览都收到停止请求，不是只停第一个', async () => {
    await seedTwoBranches();

    await post(server, 'pull_request', {
      action: 'closed',
      repository: { id: 1, full_name: REPO },
      pull_request: { number: 7, head: { ref: 'feature/x' }, base: { ref: 'main' }, merged: false },
    });
    // stop 是 fire-and-forget，给它一个 tick 落地
    await new Promise((r) => setTimeout(r, 200));

    const stopped = calls.filter((c) => c.method === 'POST').map((c) => c.branchId);
    expect(new Set(stopped).size).toBe(2);
  });

  it('删分支：两个项目都收到停止 + 删除，不是只清第一个', async () => {
    await seedTwoBranches();

    await post(server, 'delete', {
      ref: 'feature/x',
      ref_type: 'branch',
      repository: { id: 1, full_name: REPO },
    });
    // 删分支排在 stop 之后 3s（给容器停干净的时间），所以这里要等过那道延迟
    await new Promise((r) => setTimeout(r, 3400));

    const stopped = new Set(calls.filter((c) => c.method === 'POST').map((c) => c.branchId));
    const deleted = new Set(calls.filter((c) => c.method === 'DELETE').map((c) => c.branchId));
    expect(stopped.size).toBe(2);
    expect(deleted.size).toBe(2);
    // 两边指的必须是不同项目下的两条分支，不是同一条被发了两遍
    expect([...deleted].sort()).toEqual([...stopped].sort());
  }, 10_000);
});
