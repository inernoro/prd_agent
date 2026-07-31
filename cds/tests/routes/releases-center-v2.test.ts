/**
 * GET /api/releases/center 的 v2 传输面（提交说明 / 流水轴 / 环境分组 / per-target DORA）。
 *
 * 事故形状与 releaseEstimate、dora 那两次完全同构：判定模块建好了、前端画好了，
 * 中间少一行接线，字段恒为 undefined，前端优雅退化成「无数据」——页面既不报错
 * 也不白屏，全量测试照常全绿。所以这些字段必须有行为用例把「响应里真的有」钉住。
 *
 * 另一半是向后兼容棘轮：本次只许做加法。既有的 rows / plans / runs / dora 与
 * CenterRow 的既有键一个都不许少——跑旧构建的前端读新响应必须无感。
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
import type { ReleaseRun, ReleaseTarget } from '../../src/types.js';
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

const PROD_SHA = 'a'.repeat(40);
const STAGE_SHA = 'b'.repeat(40);

describe('发布中心 v2 传输面', () => {
  let tmpDir: string;
  let stateService: StateService;
  let server: http.Server;

  function releaseTarget(id: string, overrides: Partial<ReleaseTarget> = {}): ReleaseTarget {
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
        // 配了地址才会去读快照。读的是存活监控留下的记录，本身不发任何网络请求
        // （release-health-snapshot 的全部存在理由就是不让打开发布中心变成打生产）。
        healthcheckUrl: 'https://prod.example.test/health',
      },
      ...overrides,
    } as ReleaseTarget;
  }

  function addRun(overrides: Partial<ReleaseRun> & { releaseId: string; targetId: string }): void {
    stateService.addReleaseRun({
      projectId: 'proj-a',
      branchId: 'proj-a-main',
      commitSha: PROD_SHA,
      artifact: {} as ReleaseRun['artifact'],
      planId: 'plan-1',
      status: 'success',
      startedAt: new Date(Date.now() - 3_600_000).toISOString(),
      finishedAt: new Date(Date.now() - 3_500_000).toISOString(),
      logs: [],
      seq: 0,
      ...overrides,
    } as ReleaseRun);
  }

  beforeEach(async () => {
    // 监控源是模块级晚绑定状态，别的用例可能注册过；本文件要的是「监控没开」这个基线。
    setReleaseHealthSource(null, '存活监控已关闭（测试基线）');
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-release-center-v2-'));
    stateService = new StateService(path.join(tmpDir, 'state.json'), tmpDir);
    stateService.load();
    const now = new Date().toISOString();
    stateService.addProject({
      id: 'proj-a',
      slug: 'a',
      name: 'A',
      kind: 'git',
      createdAt: now,
      updatedAt: now,
      // 有主干分支名、但没有 repoPath：流水轴应当如实说「读不到本地仓库」。
      gitDefaultBranch: 'main',
    } as any);
    stateService.upsertReleaseTarget(releaseTarget('target-prod', { environment: 'production' }));
    stateService.upsertReleaseTarget(releaseTarget('target-stage', {
      environment: 'staging',
      name: '预发站点',
      isCanonical: false,
    }));
    addRun({ releaseId: 'rel-prod-1', targetId: 'target-prod', commitSha: PROD_SHA });
    addRun({ releaseId: 'rel-stage-1', targetId: 'target-stage', commitSha: STAGE_SHA });

    const app = express();
    app.use(express.json());
    app.use('/api', createReleasesRouter({ stateService, config: { worktreeBase: path.join(tmpDir, 'wt') } }));
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  });

  afterEach(async () => {
    setReleaseHealthSource(null, '');
    await flushAllJsonStateStores();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('响应同时下发 commitMeta / commitRail / environments', async () => {
    const res = await getJson(server, '/api/releases/center?project=proj-a');

    expect(res.status).toBe(200);
    // 三个字段各自对应前端 v2 布局的一块：提交说明、顶部流水轴、左栏环境列表。
    // 少任何一行都不会报错，只会让那一块永远空着。
    expect(res.body.commitMeta).toBeDefined();
    expect(res.body.commitRail).toBeDefined();
    expect(Array.isArray(res.body.environments)).toBe(true);
  });

  it('每一行都带 commitPosition 与本目标的 DORA', async () => {
    const res = await getJson(server, '/api/releases/center?project=proj-a');
    const row = res.body.rows.find((r: any) => r.target.id === 'target-prod');

    expect(row.commitPosition).toBeDefined();
    expect(row.commitPosition.commitSha).toBe(PROD_SHA);
    expect(row.dora).toBeDefined();
    // per-target 聚合只数自己那个目标的 run，不许把兄弟环境的发布算进来。
    expect(row.dora.frequency.successCount).toBe(1);
  });

  it('台账为空时 commitMeta 是空对象，响应仍然 200', async () => {
    const res = await getJson(server, '/api/releases/center?project=proj-a');

    // 存量 run 全都没记过提交说明，这是事实。如实空着，前端退化成只显示 short sha，
    // 绝不为了「看起来有东西」拿分支名 / 操作人顶替。
    expect(res.status).toBe(200);
    expect(res.body.commitMeta).toEqual({});
  });

  it('项目没有本地仓库路径时，流水轴给人话原因且不编造节点', async () => {
    const res = await getJson(server, '/api/releases/center?project=proj-a');

    expect(res.body.commitRail.nodes).toEqual([]);
    expect(res.body.commitRail.unavailableReason).toBeTruthy();
    // 算不出就是 null，不是 0：0 的含义是「与主干齐平」，是个编造出来的强结论。
    const row = res.body.rows.find((r: any) => r.target.id === 'target-prod');
    expect(row.commitPosition.behindCount).toBeNull();
    expect(row.commitPosition.aheadCount).toBeNull();
    expect(row.commitPosition.reason).toBeTruthy();
  });

  it('环境分组按 生产 → 预发 排好序，canonical 已标出', async () => {
    const res = await getJson(server, '/api/releases/center?project=proj-a');

    expect(res.body.environments.map((g: any) => g.environment)).toEqual(['production', 'staging']);
    expect(res.body.environments[0].label).toBe('生产');
    expect(res.body.environments[0].canonicalTargetId).toBe('target-prod');
    expect(res.body.environments[1].targetIds).toEqual(['target-stage']);
  });

  it('监控关闭时健康的 24h 那组字段缺省，而不是 0', async () => {
    const res = await getJson(server, '/api/releases/center?project=proj-a');
    const row = res.body.rows[0];

    expect(row.health.status).toBe('unknown');
    // 事故值：把「没数据」写成 availability24h = 0，页面会报一次假故障。
    expect(row.health.availability24h).toBeUndefined();
    expect(row.health.sampleCount24h).toBeUndefined();
  });

  it('健康快照有 24h 数据时原样透传', async () => {
    setReleaseHealthSource(() => ({
      status: 'up',
      probeUrl: 'https://prod.example.test/health',
      lastSample: { t: Date.now(), up: true, ms: 42 },
      intervalSeconds: 60,
      availability24h: 0.995,
      sampleCount24h: 200,
      upCount24h: 199,
      avgLatencyMs24h: 43,
    }));

    const res = await getJson(server, '/api/releases/center?project=proj-a');
    const row = res.body.rows[0];

    expect(row.health.status).toBe('healthy');
    expect(row.health.availability24h).toBeCloseTo(0.995);
    expect(row.health.sampleCount24h).toBe(200);
    expect(row.health.upCount24h).toBe(199);
  });

  it('窗口内无采样时 availability24h 是 null 而不是 0', async () => {
    setReleaseHealthSource(() => ({
      status: 'unknown',
      probeUrl: 'https://prod.example.test/health',
      lastSample: { t: Date.now(), up: true, ms: 42 },
      intervalSeconds: 60,
      availability24h: null,
      sampleCount24h: 0,
      upCount24h: 0,
      avgLatencyMs24h: null,
    }));

    const res = await getJson(server, '/api/releases/center?project=proj-a');
    const row = res.body.rows[0];

    expect(row.health.availability24h).toBeNull();
    expect(row.health.availability24h).not.toBe(0);
    expect(row.health.sampleCount24h).toBe(0);
  });

  it('向后兼容棘轮：既有顶层字段与 CenterRow 既有键一个都不许少', async () => {
    const res = await getJson(server, '/api/releases/center?project=proj-a');

    for (const key of ['rows', 'plans', 'runs', 'dora']) {
      expect(res.body[key], `顶层字段 ${key} 不许消失`).toBeDefined();
    }
    const row = res.body.rows[0];
    for (const key of [
      'target',
      'currentVersion',
      'currentCommit',
      'latestRun',
      'lastReleasedAt',
      'health',
      'healthStatus',
      'lastOperator',
      'canRollback',
      'successfulRuns',
      'rollbackDefaultReleaseId',
      'releaseEstimate',
    ]) {
      expect(Object.prototype.hasOwnProperty.call(row, key), `CenterRow.${key} 不许消失`).toBe(true);
    }
  });

  it('无法确定更新的一版时不下发 promotion（不硬造一个提升按钮）', async () => {
    // 没有本地仓库就算不出 ahead，此时宁可不给提升入口，也不给一个方向未知的按钮。
    const res = await getJson(server, '/api/releases/center?project=proj-a');
    const row = res.body.rows.find((r: any) => r.target.id === 'target-prod');

    expect(row.promotion).toBeUndefined();
  });
});
