/**
 * GET /api/releases/center 的 ETA 传输面。
 *
 * 事故值：耗时台账（recordReleaseDuration / getReleaseEstimate）与前端文案
 * （web/src/lib/releaseEta.ts）两头都建好了，中间这一行 `releaseEstimate` 却没接，
 * 于是 CenterRow.releaseEstimate 恒为 undefined，发布中心在**任何**情况下都只显示
 * 「正在积累历史耗时数据，暂无预计」。整条 ETA 功能建好却不可见，且因为前端有
 * 优雅退化，页面既不报错也不白屏——没有这条用例就没人会发现。
 *
 * 第二条用例钉的是「无样本时不许编造」：medianMs 必须是 null 而不是 0，
 * 否则前端会渲染出「预计还需 00:00」这种必然落空的承诺。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createReleasesRouter } from '../../src/routes/releases.js';
import { StateService } from '../../src/services/state.js';
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

describe('发布中心下发 ETA 估算', () => {
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
        // 刻意不配 healthcheckUrl：本用例只验 ETA 字段，不让路由去打任何网络。
      },
    };
  }

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-release-eta-'));
    stateService = new StateService(path.join(tmpDir, 'state.json'), tmpDir);
    stateService.load();
    const now = new Date().toISOString();
    stateService.addProject({ id: 'proj-a', slug: 'a', name: 'A', kind: 'git', createdAt: now, updatedAt: now });
    stateService.upsertReleaseTarget(releaseTarget('target-a'));
    stateService.upsertReleaseTarget(releaseTarget('target-b'));

    const app = express();
    app.use(express.json());
    app.use('/api', createReleasesRouter({ stateService, config: { worktreeBase: path.join(tmpDir, 'wt') } }));
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  });

  afterEach(async () => {
    await flushAllJsonStateStores();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('每一行都带 releaseEstimate，样本落在自己那个目标的桶里', async () => {
    // 三个样本 → 中位取中间那个；另一个目标不许被这批样本染上估算。
    for (const ms of [60_000, 120_000, 180_000]) {
      stateService.recordReleaseDuration('target-a', ms, 3_600_000);
    }

    const res = await getJson(server, '/api/releases/center');
    expect(res.status).toBe(200);

    const rowA = res.body.rows.find((row: any) => row.target.id === 'target-a');
    expect(rowA.releaseEstimate).toBeDefined();
    expect(rowA.releaseEstimate.sampleCount).toBe(3);
    expect(rowA.releaseEstimate.medianMs).toBe(120_000);

    // 桶键是 targetId：同项目的另一个站点可能在另一台机器跑另一条脚本，
    // 借用它的耗时会给出一个与实际无关的预计。
    const rowB = res.body.rows.find((row: any) => row.target.id === 'target-b');
    expect(rowB.releaseEstimate).toBeDefined();
    expect(rowB.releaseEstimate.sampleCount).toBe(0);
    expect(rowB.releaseEstimate.medianMs).toBeNull();
  });

  it('无样本时 medianMs 为 null 而不是 0（不编造预计）', async () => {
    const res = await getJson(server, '/api/releases/center');
    for (const row of res.body.rows) {
      expect(row.releaseEstimate.medianMs).toBeNull();
      expect(row.releaseEstimate.medianMs).not.toBe(0);
    }
  });
});
