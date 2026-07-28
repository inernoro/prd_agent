/**
 * Codex PR #1273 第三十九轮 4 条 P1 的回归。
 *
 * 四条都是「机制建好了但有个口子」，且四条都能被同一句话概括：
 * **判据的作用域比它保护的东西小**——
 *   1. 落点核对只看拿到过标签的样本，无标签的成功样本从视野里蒸发；
 *   2. 启动收敛沿用周期收割的心跳阈值，可启动时根本不存在活着的执行体；
 *   3. 附件回收按项目分了桶，字节配额却还是全局公共池；
 *   4. 排空支持了发布口径，唯一调用点却只喂部署 run。
 * 每个 it 都先写清「事故值」，改回旧行为必须红。
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { buildComparison, type LoadTestTargetMetrics } from '../../src/services/replica-loadtest.js';
import { collectDrainableRuns, isRunInFlight } from '../../src/services/deploy-drain.js';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');

function metrics(over: Partial<LoadTestTargetMetrics> & { memberId: string; label: string }): LoadTestTargetMetrics {
  return {
    requests: 100,
    success: 100,
    failed: 0,
    successRate: 1,
    qps: 10,
    avg: 10,
    min: 5,
    max: 20,
    p50: 10,
    p90: 15,
    p95: 18,
    p99: 20,
    errors: { timeout: 0, refused: 0, reset: 0, http4xx: 0, http5xx: 0, other: 0 },
    servedBy: {},
    servedGroups: {},
    untaggedSuccess: 0,
    untaggedGroupSuccess: 0,
    expectedGroup: 'grp',
    series: [],
    ...over,
  } as LoadTestTargetMetrics;
}

describe('P1-1 无标签成功样本必须拦在出结论之前', () => {
  it('事故值：90 条带标签 + 10 条无标签，旧判据只看 servedBy 会当成纯净落点放行', () => {
    const result = buildComparison([
      metrics({
        memberId: 'primary',
        label: '主实例',
        servedBy: { primary: 90 },
        servedGroups: { grp: 90 },
        untaggedSuccess: 10,
        untaggedGroupSuccess: 10,
      }),
      metrics({
        memberId: 'rs-a',
        label: '副本 A',
        servedBy: { 'rs-a': 100 },
        servedGroups: { grp: 100 },
      }),
    ]);
    expect(result?.routingVerified).toBe(false);
    expect(result?.routingIssue).toMatch(/没带副本/);
    // 拒绝出结论时不许留下任何对比行——否则 UI 仍会渲染「谁更快」。
    expect(result?.rows).toEqual([]);
  });

  it('一条标签都没拿到的落点走既有「无证据」软档，不被本规则升级成硬拒绝', () => {
    // 主实例与部分部署形态本就不带 X-CDS-Replica，全无标签是合法形态：
    // 数据照给 + 标注未核实（软档），不能因为新规则就变成一条结论都不给。
    const result = buildComparison([
      metrics({ memberId: 'primary', label: '主实例', untaggedSuccess: 100, untaggedGroupSuccess: 100 }),
      metrics({ memberId: 'rs-a', label: '副本 A', untaggedSuccess: 100, untaggedGroupSuccess: 100 }),
    ]);
    expect(result?.routingVerified).toBe(false);
    expect(result?.routingIssue).toMatch(/未观测到任何副本标识/);
    expect(result?.routingIssue).not.toMatch(/没带副本/);
    // 软档的关键区别：对比行仍然给出。
    expect(result?.rows.length).toBe(1);
  });

  it('全部成功响应都带标签且对得上 → 正常出结论', () => {
    const result = buildComparison([
      metrics({ memberId: 'primary', label: '主实例', servedBy: { primary: 100 }, servedGroups: { grp: 100 } }),
      metrics({ memberId: 'rs-a', label: '副本 A', servedBy: { 'rs-a': 100 }, servedGroups: { grp: 100 } }),
    ]);
    expect(result?.routingVerified).toBe(true);
    expect(result?.rows.length).toBe(1);
  });
});

describe('P1-4 自更新排空必须把生产发布也算进去', () => {
  it('collectDrainableRuns 合并两条生命周期，发布的 running 判为在途', () => {
    const runs = collectDrainableRuns({
      deploymentRuns: [{ id: 'dep-1', status: 'running' }],
      releaseRuns: [{ releaseId: 'rel-1', status: 'running', heartbeatAt: new Date().toISOString() }],
    });
    expect(runs.map((r) => r.id).sort()).toEqual(['dep-1', 'rel-1']);
    const release = runs.find((r) => r.id === 'rel-1')!;
    // 语义相反：部署侧 running 是成功终态，发布侧 running 是在途。
    expect(release.kind).toBe('release');
    expect(isRunInFlight(release)).toBe(true);
    expect(isRunInFlight(runs.find((r) => r.id === 'dep-1')!)).toBe(false);
  });

  it('唯一调用点确实喂了发布 run —— 事故值：只传 getDeploymentRuns()', () => {
    const source = fs.readFileSync(path.join(REPO, 'src/routes/branches.ts'), 'utf-8');
    // 排空调用块里必须同时出现两个数据源，否则 collectDrainableRuns 就是死代码。
    const drainCall = source.slice(source.indexOf('drainInFlightDeploys({'));
    expect(drainCall).toContain('collectDrainableRuns({');
    expect(drainCall).toContain('getReleaseRuns()');
    expect(drainCall.slice(0, 600)).not.toMatch(/listRuns: \(\) => stateService\.getDeploymentRuns\(\) as unknown as DrainableRun\[\],/);
  });
});

describe('P1-3 附件回收必须按项目隔离', () => {
  it('每项目上限必须严格小于全局硬顶，否则等于没有隔离', async () => {
    const mod = await import('../../src/routes/bug-reports.js');
    expect(mod.BUG_REPORT_MAX_ATTACHMENT_BYTES_PER_PROJECT).toBeGreaterThan(0);
    expect(mod.BUG_REPORT_MAX_ATTACHMENT_BYTES_PER_PROJECT)
      .toBeLessThan(mod.BUG_REPORT_MAX_ATTACHMENT_BYTES);
  });

  it('吵闹项目撑爆配额时，安静项目的截图必须一张不少地活着', async () => {
    const express = (await import('express')).default;
    const { createBugReportsRouter } = await import('../../src/routes/bug-reports.js');
    const http = await import('node:http');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-bugreport-attbucket-'));
    // 把配额调到 KB 量级，用真实文件跑完整回收路径（默认 64/256 MiB 没法在单测里跑）。
    const appFor = (projectId: string) => {
      const a = express();
      a.use((req: never, _res: never, next: () => void) => {
        (req as unknown as { cdsProjectKey?: unknown }).cdsProjectKey = { projectId, keyId: 'k' };
        next();
      });
      a.use('/api', createBugReportsRouter({
        getDataDir: () => dir,
        readForwardConfig: () => null,
        resolveReporter: () => 'tester',
        maxAttachmentBytes: 40 * 1024,
        maxAttachmentBytesPerProject: 16 * 1024,
      }));
      return a;
    };

    const post = (app: unknown, description: string): Promise<number> => new Promise((resolve, reject) => {
      const server = http.createServer(app as never).listen(0, () => {
        const port = (server.address() as { port: number }).port;
        const body = JSON.stringify({
          description,
          severity: 'trivial',
          // 每条带一张 ~6KB 的截图
          attachments: [{
            name: `${description}.png`,
            mimeType: 'image/png',
            dataBase64: Buffer.alloc(6 * 1024, 7).toString('base64'),
          }],
        });
        const req = http.request({
          port, method: 'POST', path: '/api/bug-reports',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        }, (res) => {
          res.resume();
          res.on('end', () => { server.close(); resolve(res.statusCode || 0); });
        });
        req.on('error', (e) => { server.close(); reject(e); });
        req.end(body);
      });
    });

    // 安静项目先各提 1 条（共 ~6KB，远低于自己的 16KB 配额）
    expect(await post(appFor('quiet'), 'quiet-0')).toBe(201);
    const quietFiles = fs.readdirSync(path.join(dir, 'bug-reports', 'attachments'));
    expect(quietFiles.length).toBe(1);

    // 吵闹项目猛提，足够同时撑爆自己的 16KB 与全局 40KB
    for (let i = 0; i < 12; i += 1) {
      expect(await post(appFor('noisy'), `noisy-${i}`)).toBe(201);
    }

    const remaining = fs.readdirSync(path.join(dir, 'bug-reports', 'attachments'));
    // 事故值：全局按时间正序删起，quiet 是最旧的，它的截图第一个被删。
    expect(remaining).toContain(quietFiles[0]);
    // 吵闹项目自己确实被削到配额内了（证明回收真的跑了，不是没触发）
    const noisyRemaining = remaining.filter((n) => n !== quietFiles[0]);
    expect(noisyRemaining.length).toBeLessThan(12);
  });
});

describe('P1-2 启动收敛不看心跳新鲜度', () => {
  it('刚打过心跳、但执行体已随进程消失的 run，启动时立刻收敛', async () => {
    const { ReleaseService } = await import('../../src/services/release-service.js');
    const fresh = new Date().toISOString();
    const runs = [{
      releaseId: 'rel-fresh',
      projectId: 'p1',
      branchId: 'b1',
      targetId: 't1',
      planId: 'plan1',
      status: 'running',
      startedAt: fresh,
      heartbeatAt: fresh,
      logs: [],
      seq: 1,
    }];
    const patched: Array<{ id: string; status: string }> = [];
    const stateService = {
      getReleaseRuns: () => runs,
      appendReleaseRunLog: () => {},
      getReleaseRun: (id: string) => runs.find((r) => r.releaseId === id),
      patchReleaseRun: (id: string, patch: Record<string, unknown>) => {
        patched.push({ id, status: String(patch.status) });
        const run = runs.find((r) => r.releaseId === id)!;
        Object.assign(run, patch);
        return run;
      },
      getState: () => ({ projects: [] }),
    } as never;

    const service = new ReleaseService(stateService);
    // 周期收割：心跳新鲜 → 放过（否则会误杀正在正常执行的发布）
    expect(service.reconcileInterruptedReleases(new Date()).reconciled).toBe(0);
    expect(runs[0]!.status).toBe('running');

    // 启动收敛：本进程不可能持有执行体，心跳是上一个已死进程打的 → 立刻收敛。
    // 事故值：沿用 15 分钟阈值，这个发布目标至少再被堵 15 分钟。
    const out = service.reconcileInterruptedReleases(new Date(), { assumeAllOrphaned: true });
    expect(out.reconciled).toBe(1);
    expect(runs[0]!.status).toBe('failed');
    expect(patched.some((p) => p.status === 'failed')).toBe(true);
  });

  it('写日志失败也要照常解锁：日志是装饰，解锁才是收割器存在的理由', async () => {
    const { ReleaseService } = await import('../../src/services/release-service.js');
    const old = new Date(Date.now() - 60 * 60_000).toISOString();
    const runs = [{
      releaseId: 'rel-logfail',
      projectId: 'p1',
      branchId: 'b1',
      targetId: 't1',
      planId: 'plan1',
      status: 'running',
      startedAt: old,
      heartbeatAt: old,
      logs: [],
      seq: 1,
    }];
    const stateService = {
      getReleaseRuns: () => runs,
      // 事故形态：日志写入炸了。旧实现会被 catch 吞掉整条收敛，目标继续锁死。
      appendReleaseRunLog: () => { throw new Error('日志盘满'); },
      getReleaseRun: (id: string) => runs.find((r) => r.releaseId === id),
      patchReleaseRun: (id: string, patch: Record<string, unknown>) => {
        Object.assign(runs[0]!, patch);
        return runs[0];
      },
      getState: () => ({ projects: [] }),
    } as never;
    const service = new ReleaseService(stateService);
    expect(service.reconcileInterruptedReleases(new Date()).reconciled).toBe(1);
    expect(runs[0]!.status).toBe('failed');
  });

  it('收割器第一轮走启动语义，之后的轮次退回心跳阈值', async () => {
    const { startReleaseRunReaper } = await import('../../src/server.js');
    const calls: Array<boolean | undefined> = [];
    let tick: (() => void) | null = null;
    const handle = startReleaseRunReaper({
      service: {
        reconcileInterruptedReleases: (_now, options) => {
          calls.push(options?.assumeAllOrphaned);
          return { reconciled: 0 };
        },
      },
      setTimer: (fn) => { tick = fn; return {}; },
      clearTimer: () => {},
      log: () => {},
    });
    expect(calls).toEqual([true]);
    tick!();
    tick!();
    expect(calls).toEqual([true, false, false]);
    handle.stop();
  });
});

describe('临时文件不落库', () => {
  it('tests/services 下没有 __tmp 前缀的残留脚本', () => {
    const dir = path.join(REPO, 'tests/services');
    const stray = fs.readdirSync(dir).filter((n) => n.startsWith('__tmp'));
    expect(stray).toEqual([]);
    expect(os.type()).toBeTruthy();
  });
});
