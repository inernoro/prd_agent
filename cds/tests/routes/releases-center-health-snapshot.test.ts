/**
 * GET /api/releases/center 的健康列必须**读快照**，不许打生产。
 *
 * 事故值：这个 handler 曾对每个发布目标同步 `probeHealthcheckStatus(url, 2_500)`。
 * 于是「打开发布中心」这个纯读动作，会按目标数放大成一串对生产站点的外呼——
 * 页面刷得越勤、目标配得越多，生产被打得越狠；而这些探测的结果谁也不记账，
 * 关掉页面就什么都不剩。存活监控本来就在按固定间隔探同一批目标并留全量采样。
 *
 * 本用例用一个**真的 HTTP 服务器**当生产健康端点并数请求次数：读一次发布中心，
 * 计数必须是 0。红检方式：把 handler 改回 `await probeHealthcheckStatus(...)`，
 * 计数变成目标数，用例立刻红。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createReleasesRouter } from '../../src/routes/releases.js';
import { StateService } from '../../src/services/state.js';
import { setReleaseHealthSource } from '../../src/services/release-health-snapshot.js';
import { releaseProbeTargetId } from '../../src/services/release-probe-target.js';
import type { ReleaseTarget } from '../../src/types.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';

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

describe('发布中心健康列读监控快照', () => {
  let tmpDir: string;
  let stateService: StateService;
  let server: http.Server;
  /** 冒充生产站点的健康端点，只为数请求次数 */
  let prodServer: http.Server;
  let prodHits: number;
  let prodUrl: string;

  function releaseTarget(id: string, healthcheckUrl: string): ReleaseTarget {
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
        healthcheckUrl,
      },
    };
  }

  beforeEach(async () => {
    prodHits = 0;
    prodServer = http.createServer((_req, res) => { prodHits += 1; res.statusCode = 200; res.end('ok'); });
    await new Promise<void>((resolve) => { prodServer.listen(0, '127.0.0.1', resolve); });
    prodUrl = `http://127.0.0.1:${(prodServer.address() as { port: number }).port}/health`;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-release-health-'));
    stateService = new StateService(path.join(tmpDir, 'state.json'), tmpDir);
    stateService.load();
    const now = new Date().toISOString();
    stateService.addProject({ id: 'proj-a', slug: 'a', name: 'A', kind: 'git', createdAt: now, updatedAt: now });
    stateService.upsertReleaseTarget(releaseTarget('target-a', prodUrl));
    stateService.upsertReleaseTarget(releaseTarget('target-b', prodUrl));

    const app = express();
    app.use(express.json());
    app.use('/api', createReleasesRouter({ stateService, config: { worktreeBase: path.join(tmpDir, 'wt') } }));
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  });

  afterEach(async () => {
    setReleaseHealthSource(null);
    await flushAllJsonStateStores();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => prodServer.close(() => resolve()));
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('读一次发布中心，对生产的实时探测次数为 0', async () => {
    setReleaseHealthSource((probeTargetId) => ({
      status: 'up',
      probeUrl: prodUrl,
      lastSample: { t: Date.parse('2026-07-28T10:00:00.000Z'), up: true, ms: 42 },
      intervalSeconds: 60,
      // 用 id 参与返回值，顺带证明查的是「这个目标」的快照而不是随便一条
      pausedReason: probeTargetId,
    }));

    const res = await getJson(server, '/api/releases/center');
    expect(res.status).toBe(200);
    expect(prodHits).toBe(0);

    const rowA = res.body.rows.find((row: any) => row.target.id === 'target-a');
    expect(rowA.healthStatus).toBe('healthy');
    expect(rowA.health.responseTimeMs).toBe(42);
    // checkedAt 必须是采样时刻，不是「渲染这一页的时刻」——否则页面会假装刚探过。
    expect(rowA.health.checkedAt).toBe('2026-07-28T10:00:00.000Z');
  });

  it('监控未接上时诚实报 unknown，不偷偷回退到实时探测', async () => {
    setReleaseHealthSource(null);

    const res = await getJson(server, '/api/releases/center');
    expect(prodHits).toBe(0);
    for (const row of res.body.rows) {
      expect(row.healthStatus).toBe('unknown');
      expect(String(row.health.message)).toContain('存活监控未启用');
    }
  });

  it('监控判定 down 时发布中心显示 failed 并带上原因', async () => {
    setReleaseHealthSource(() => ({
      status: 'down',
      probeUrl: prodUrl,
      lastSample: { t: Date.now(), up: false, ms: 2_500, code: 502, err: 'HTTP 502' },
      intervalSeconds: 60,
    }));

    const res = await getJson(server, '/api/releases/center');
    expect(prodHits).toBe(0);
    const rowA = res.body.rows.find((row: any) => row.target.id === 'target-a');
    expect(rowA.healthStatus).toBe('failed');
    expect(rowA.health.message).toBe('HTTP 502');
  });

  it('还没出首个采样时说「等待首次探测」，不是假绿也不是假红', async () => {
    setReleaseHealthSource((probeTargetId) => {
      // 只有 target-a 已被纳入监控台账，target-b 连记录都还没建。
      if (probeTargetId !== releaseProbeTargetId({ id: 'target-a' })) return undefined;
      return { status: 'unknown', probeUrl: prodUrl, lastSample: null, intervalSeconds: 30 };
    });

    const res = await getJson(server, '/api/releases/center');
    expect(prodHits).toBe(0);
    const rowA = res.body.rows.find((row: any) => row.target.id === 'target-a');
    expect(rowA.healthStatus).toBe('unknown');
    expect(rowA.health.message).toContain('等待首次探测');
    expect(rowA.health.message).toContain('30');

    const rowB = res.body.rows.find((row: any) => row.target.id === 'target-b');
    expect(rowB.healthStatus).toBe('unknown');
    expect(rowB.health.message).toContain('尚未纳入');
  });
});
