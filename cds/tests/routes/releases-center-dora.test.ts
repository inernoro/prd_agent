/**
 * GET /api/releases/center 的 DORA 传输面。
 *
 * 事故值（与 releases-center-eta.test.ts 同族）：聚合函数写好了、前端面板画好了，
 * 中间这一行 `dora` 却没接，于是 CenterResponse.dora 恒为 undefined，
 * 发布中心在**任何**情况下都显示「样本不足」。因为前端做了优雅退化，
 * 页面既不报错也不白屏——没有这条用例就没人会发现。
 *
 * 第二条用例钉的是「样本不足时不许编造」：零发布时 changeFailure.ratio 必须是
 * null 而不是 0，否则前端会渲染出「变更失败率 0%」，把「压根没发过」
 * 说成「发布很健康」。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createReleasesRouter } from '../../src/routes/releases.js';
import { StateService } from '../../src/services/state.js';
import type { ReleaseRun, ReleaseTarget } from '../../src/types.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';

const DAY = 24 * 3600 * 1000;

async function getJson(server: http.Server, urlPath: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const req = http.request({ hostname: '127.0.0.1', port: addr.port, path: urlPath, method: 'GET' }, (res) => {
      let raw = '';
      res.on('data', (chunk: Buffer) => (raw += chunk.toString()));
      res.on('end', () => {
        try { resolve({ status: res.statusCode!, body: raw ? JSON.parse(raw) : null }); }
        catch { resolve({ status: res.statusCode!, body: raw }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('发布中心下发 DORA 指标', () => {
  let tmpDir: string;
  let stateService: StateService;
  let server: http.Server;

  function releaseTarget(id: string): ReleaseTarget {
    const now = new Date().toISOString();
    return {
      id,
      projectId: 'proj-a',
      name: `${id} 站点`,
      type: 'ssh',
      createdAt: now,
      updatedAt: now,
      isEnabled: true,
      ssh: {
        host: 'prod.example.test',
        port: 22,
        user: 'deploy',
        privateKeyRef: 'host-key',
        appPath: '/srv/app',
        deployCommand: './deploy.sh',
        // 刻意不配 healthcheckUrl：本用例只验 DORA 字段，不让路由去打任何网络。
      },
    } as ReleaseTarget;
  }

  function addRun(overrides: Partial<ReleaseRun> & { releaseId: string; startedAt: string }): void {
    stateService.addReleaseRun({
      projectId: 'proj-a',
      branchId: 'proj-a-main',
      commitSha: 'abcdef1',
      artifact: {} as ReleaseRun['artifact'],
      targetId: 'target-a',
      planId: 'plan-1',
      status: 'success',
      logs: [],
      seq: 0,
      ...overrides,
    } as ReleaseRun);
  }

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-release-dora-'));
    stateService = new StateService(path.join(tmpDir, 'state.json'), tmpDir);
    stateService.load();
    const now = new Date().toISOString();
    stateService.addProject({ id: 'proj-a', slug: 'a', name: 'A', kind: 'git', createdAt: now, updatedAt: now });
    stateService.upsertReleaseTarget(releaseTarget('target-a'));

    const app = express();
    app.use(express.json());
    app.use('/api', createReleasesRouter({
      stateService,
      config: { worktreeBase: path.join(tmpDir, 'wt'), repoRoot: tmpDir },
    }));
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  });

  afterEach(async () => {
    await flushAllJsonStateStores();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('center 响应带 dora，四项齐全且按真实 run 聚合', async () => {
    const now = Date.now();
    addRun({
      releaseId: 'rel-1',
      startedAt: new Date(now - 10 * DAY).toISOString(),
      finishedAt: new Date(now - 10 * DAY + 60_000).toISOString(),
    });
    addRun({
      releaseId: 'rel-2',
      status: 'failed',
      startedAt: new Date(now - 5 * DAY).toISOString(),
      finishedAt: new Date(now - 5 * DAY + 60_000).toISOString(),
    });
    addRun({
      releaseId: 'rel-3',
      startedAt: new Date(now - 4 * DAY).toISOString(),
      finishedAt: new Date(now - 4 * DAY + 60_000).toISOString(),
    });

    const res = await getJson(server, '/api/releases/center');
    expect(res.status).toBe(200);
    expect(res.body.dora).toBeDefined();
    expect(res.body.dora.windowDays).toBe(30);
    expect(res.body.dora.frequency.successCount).toBe(2);
    expect(res.body.dora.changeFailure).toMatchObject({ total: 3, failed: 1 });
    expect(res.body.dora.changeFailure.ratio).toBeCloseTo(1 / 3, 5);
    // 失败后隔一天有一次成功 → 恢复时长 1 天。
    expect(res.body.dora.recovery.sampleCount).toBe(1);
    expect(res.body.dora.recovery.p50Ms).toBe(DAY);
    // 没有任何 commit 提交时间记录 → 前置时间覆盖率为 0，如实暴露而不是编数字。
    expect(res.body.dora.leadTime.sampleCount).toBe(0);
    expect(res.body.dora.leadTime.eligibleCount).toBe(2);
    expect(res.body.dora.leadTime.p50Ms).toBeNull();
  });

  it('零发布时 ratio 为 null 而不是 0（不编造「发布很健康」）', async () => {
    const res = await getJson(server, '/api/releases/center');
    expect(res.body.dora.changeFailure.ratio).toBeNull();
    expect(res.body.dora.changeFailure.ratio).not.toBe(0);
    expect(res.body.dora.frequency.successCount).toBe(0);
    expect(res.body.dora.recovery.p50Ms).toBeNull();
  });

  it('doraDays 可调且夹在 [7, 90]', async () => {
    const short = await getJson(server, '/api/releases/center?doraDays=7');
    expect(short.body.dora.windowDays).toBe(7);
    const absurd = await getJson(server, '/api/releases/center?doraDays=9999');
    expect(absurd.body.dora.windowDays).toBe(90);
  });
});
