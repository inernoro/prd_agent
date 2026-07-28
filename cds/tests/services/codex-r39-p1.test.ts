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

import { describe, it, expect, vi } from 'vitest';
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
    // 显式超时：本例要 import 整个 server.js（重模块），默认 5s 不够。
  }, 30_000);
});

describe('临时文件不落库', () => {
  it('tests/services 下没有 __tmp 前缀的残留脚本', () => {
    const dir = path.join(REPO, 'tests/services');
    const stray = fs.readdirSync(dir).filter((n) => n.startsWith('__tmp'));
    expect(stray).toEqual([]);
    expect(os.type()).toBeTruthy();
  });
});

describe('第四十轮 P1：主实例身份也必须核对', () => {
  it('主实例被摘除、请求落到未被选中的 rs-a，不许当成通过', () => {
    // 事故分布：primary 落点实际由 rs-a 服务（forwarder 主路由打的是
    // replicaMemberId:'primary'，所以观测到 rs-a 只可能是钉选没生效）。
    // 旧判据豁免 primary，两个落点身份不同、组也对 → routingVerified: true，
    // 于是「primary 那一行」其实是 rs-a，A/B 结论的标签是错的。
    const result = buildComparison([
      metrics({ memberId: 'primary', label: '主实例', servedBy: { 'rs-a': 100 }, servedGroups: { grp: 100 } }),
      metrics({ memberId: 'rs-b', label: '副本 B', servedBy: { 'rs-b': 100 }, servedGroups: { grp: 100 } }),
    ]);
    expect(result?.routingVerified).toBe(false);
    expect(result?.routingIssue).toMatch(/主实例/);
    expect(result?.rows).toEqual([]);
  });

  it('主实例自报 primary 且对得上 → 照常出结论', () => {
    const result = buildComparison([
      metrics({ memberId: 'primary', label: '主实例', servedBy: { primary: 100 }, servedGroups: { grp: 100 } }),
      metrics({ memberId: 'rs-b', label: '副本 B', servedBy: { 'rs-b': 100 }, servedGroups: { grp: 100 } }),
    ]);
    expect(result?.routingVerified).toBe(true);
  });
});

describe('第四十轮 P2：截图没存下来必须说出来', () => {
  it('附件写盘失败时 degradeReason 点名丢了哪张，不再只回「已记录」', async () => {
    const express = (await import('express')).default;
    const { createBugReportsRouter } = await import('../../src/routes/bug-reports.js');
    const http = await import('node:http');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-bugreport-attfail-'));
    // 事故形态：目录建得出来、账本也写得进去，唯独附件那一次 writeFileSync 失败
    // （典型成因是数据卷在中途写满）。只打这一枪，才测得到「部分失败」这条路径。
    const realWrite = fs.writeFileSync;
    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation(((file: never, ...rest: never[]) => {
      if (String(file).includes(`${path.sep}attachments${path.sep}`)) throw new Error('ENOSPC: no space left on device');
      return (realWrite as never as (...a: never[]) => unknown)(file, ...rest);
    }) as never);

    const app = express();
    app.use('/api', createBugReportsRouter({
      getDataDir: () => dir,
      readForwardConfig: () => null,
      resolveReporter: () => 'tester',
    }));

    const body = await new Promise<{ status: number; json: Record<string, unknown> }>((resolve, reject) => {
      const server = http.createServer(app).listen(0, () => {
        const port = (server.address() as { port: number }).port;
        const payload = JSON.stringify({
          description: '写盘失败也要如实说',
          severity: 'trivial',
          attachments: [{ name: '关键截图.png', mimeType: 'image/png', dataBase64: Buffer.alloc(64, 1).toString('base64') }],
        });
        const req = http.request({
          port, method: 'POST', path: '/api/bug-reports',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        }, (res) => {
          let text = '';
          res.on('data', (c) => { text += c; });
          res.on('end', () => { server.close(); resolve({ status: res.statusCode || 0, json: JSON.parse(text) }); });
        });
        req.on('error', (e) => { server.close(); reject(e); });
        req.end(payload);
      });
    });
    spy.mockRestore();

    expect(body.status).toBe(201);
    expect(String(body.json.degradeReason || '')).toContain('关键截图.png');
    expect(String(body.json.degradeReason || '')).toMatch(/未能保存/);
  });
});

describe('第四十一轮 P1：文本字段必须有界', () => {
  it('超长 description / title / content 一律截断并留下标记', async () => {
    const { normalizeBugReport } = await import('../../src/routes/bug-reports.js');
    // 事故值：不带附件时 description 可以吃满接近 24MB 的 body，原样写进
    // records.jsonl；按项目保留 200 条 → 单个项目 Key 就能把台账推向 GB 级，
    // 而每次回收还要整文件读回来解析。
    const huge = 'x'.repeat(500_000);
    const out = normalizeBugReport({ description: huge, severity: 'trivial', title: huge, content: huge });
    expect('report' in out).toBe(true);
    const report = (out as { report: { title: string; description: string; content: string } }).report;
    expect(report.title.length).toBeLessThanOrEqual(200);
    expect(report.description.length).toBeLessThan(huge.length);
    expect(report.description).toMatch(/已截断/);
    expect(report.content.length).toBeLessThan(huge.length);
    // 单条序列化后必须是 KB 量级，不是 MB 量级
    expect(JSON.stringify(report).length).toBeLessThan(200_000);
  });

  it('正常长度的文本一字不动', async () => {
    const { normalizeBugReport } = await import('../../src/routes/bug-reports.js');
    const out = normalizeBugReport({ description: '点了保存没反应', severity: 'major' });
    const report = (out as { report: { description: string } }).report;
    expect(report.description).toBe('点了保存没反应');
    expect(report.description).not.toMatch(/已截断/);
  });
});

describe('第四十一轮 P2：降级说明必须落进账本', () => {
  it('附件写盘失败时，后续 GET 读回来的记录也带着说明', async () => {
    const express = (await import('express')).default;
    const { createBugReportsRouter } = await import('../../src/routes/bug-reports.js');
    const http = await import('node:http');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-bugreport-degrade-'));
    const realWrite = fs.writeFileSync;
    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation(((file: never, ...rest: never[]) => {
      if (String(file).includes(`${path.sep}attachments${path.sep}`)) throw new Error('ENOSPC');
      return (realWrite as never as (...a: never[]) => unknown)(file, ...rest);
    }) as never);

    const app = express();
    app.use('/api', createBugReportsRouter({
      getDataDir: () => dir, readForwardConfig: () => null, resolveReporter: () => 'tester',
    }));

    const call = (method: string, pathname: string, payload?: unknown) =>
      new Promise<{ status: number; json: Record<string, unknown> }>((resolve, reject) => {
        const server = http.createServer(app).listen(0, () => {
          const port = (server.address() as { port: number }).port;
          const bodyText = payload === undefined ? undefined : JSON.stringify(payload);
          const req = http.request({
            port, method, path: pathname,
            headers: bodyText
              ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyText) }
              : {},
          }, (res) => {
            let text = '';
            res.on('data', (c) => { text += c; });
            res.on('end', () => { server.close(); resolve({ status: res.statusCode || 0, json: JSON.parse(text) }); });
          });
          req.on('error', (e) => { server.close(); reject(e); });
          req.end(bodyText);
        });
      });

    const posted = await call('POST', '/api/bug-reports', {
      description: '账本也要带说明',
      severity: 'trivial',
      attachments: [{ name: '证据.png', mimeType: 'image/png', dataBase64: Buffer.alloc(64, 1).toString('base64') }],
    });
    spy.mockRestore();
    expect(posted.status).toBe(201);
    expect(String(posted.json.degradeReason || '')).toContain('证据.png');

    // 事故值：degradeReason 是在 persist() append 之后才补上的，账本里存的仍是旧值，
    // 于是列表接口读回来是「附件文件名为空且没有任何解释」。
    const listed = await call('GET', '/api/bug-reports?limit=10');
    const items = listed.json.items as Array<{ degradeReason?: string }>;
    expect(items.length).toBeGreaterThan(0);
    expect(String(items[0]!.degradeReason || '')).toContain('证据.png');
  });
});

describe('第四十一轮 P2：存活监控保留时长必须跟着探测间隔走', () => {
  it('10s 间隔要留满 24 小时的采样，而不是只留 1440 条（4 小时）', async () => {
    const { samplesForDayAtInterval, MAX_SAMPLES_HARD_CEILING } =
      await import('../../src/services/uptime-metrics.js');
    // 事故值：写死 1440 条 → 10s 间隔只覆盖 4 小时，可 summary 仍按 24 小时口径
    // 计算并标注 availability24h，前面 20 小时被当成「没有数据」。
    expect(samplesForDayAtInterval(10_000)).toBe(8640);
    expect(samplesForDayAtInterval(60_000)).toBe(1440);
    // 上限仍然封死，不允许无限增长
    expect(samplesForDayAtInterval(1)).toBe(MAX_SAMPLES_HARD_CEILING);
    // 极慢间隔也保底若干条，不至于一条都留不下
    expect(samplesForDayAtInterval(3_600_000)).toBeGreaterThanOrEqual(60);
  });

  it('配置解析真的按间隔给容量（默认 60s 与今天完全一致，零回归）', async () => {
    const { uptimeConfigFromEnv } = await import('../../src/services/uptime-monitor.js');
    const prev = process.env.CDS_UPTIME_INTERVAL_SECONDS;
    try {
      delete process.env.CDS_UPTIME_INTERVAL_SECONDS;
      expect(uptimeConfigFromEnv('/tmp').maxSamples).toBe(1440);
      process.env.CDS_UPTIME_INTERVAL_SECONDS = '10';
      expect(uptimeConfigFromEnv('/tmp').maxSamples).toBe(8640);
    } finally {
      if (prev === undefined) delete process.env.CDS_UPTIME_INTERVAL_SECONDS;
      else process.env.CDS_UPTIME_INTERVAL_SECONDS = prev;
    }
  });
});

describe('第四十二轮 P1：回滚必须过与发布同一道并发闸', () => {
  it('目标上有未退出的执行体时，回滚也要被挡住（不只是发布）', async () => {
    const { ReleaseService } = await import('../../src/services/release-service.js');
    // 事故形态：取消一次发布后 run 立刻终态，但执行体（不接 abort 的探测/已发出的 SSH）
    // 还在飞。此前 startRollback 一道闸都没有 —— 回滚会和老执行体并发往同一台机器写，
    // 线上最终留下的是「谁后跑完」的那个版本。
    const runs: Array<Record<string, unknown>> = [{
      releaseId: 'rel_cancelled',
      projectId: 'p1',
      branchId: 'b1',
      targetId: 'target-prod',
      planId: 'plan1',
      commitSha: 'a'.repeat(40),
      artifact: { type: 'branch-preview', commitSha: 'a'.repeat(40), branchId: 'b1', branchName: 'main' },
      status: 'failed',
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      executionSnapshot: { mode: 'generated-compose', scriptSha256: 'x'.repeat(64), summary: 's', strategy: 'compose' },
      logs: [],
      seq: 1,
    }, {
      releaseId: 'rel_prev_ok',
      projectId: 'p1',
      branchId: 'b1',
      targetId: 'target-prod',
      planId: 'plan1',
      commitSha: 'b'.repeat(40),
      artifact: { type: 'branch-preview', commitSha: 'b'.repeat(40), branchId: 'b1', branchName: 'main' },
      status: 'success',
      startedAt: new Date(Date.now() - 3_600_000).toISOString(),
      executionSnapshot: { mode: 'generated-compose', scriptSha256: 'y'.repeat(64), summary: 'prev', strategy: 'compose' },
      logs: [],
      seq: 1,
    }];
    const stateService = {
      getReleaseRuns: () => runs,
      getReleaseRun: (id: string) => runs.find((r) => r.releaseId === id),
      getReleaseTarget: () => ({
        id: 'target-prod', projectId: 'p1', name: '生产站点', type: 'ssh', isEnabled: true,
        ssh: { host: '127.0.0.1', port: 22, user: 'd', privateKeyRef: 'h', appPath: '/opt/a', deployCommand: 'x', healthcheckUrl: 'http://127.0.0.1:1/h' },
      }),
      getLatestSuccessfulReleaseRun: () => runs[1],
      appendReleaseRunLog: () => {},
      patchReleaseRun: () => runs[0],
      addReleaseRun: (r: unknown) => r,
      getState: () => ({ projects: [] }),
    } as never;

    const service = new ReleaseService(stateService, { sshExecutor: async () => 'ok' });
    // 把「执行体未退出」这个状态直接摆进去（等价于取消后尚未 settle）
    (service as unknown as { inFlight: Map<string, unknown> }).inFlight
      .set('rel_cancelled', { controller: new AbortController() });

    await expect(service.startRollback('rel_cancelled', 'tester'))
      .rejects.toThrow(/执行体尚未退出/);
  });

  it('并发闸是唯一判定源，发布与回滚都走它（防再次只补一边）', () => {
    const source = fs.readFileSync(path.join(REPO, 'src/services/release-service.ts'), 'utf-8');
    expect(source).toContain('private assertTargetFree(');
    // 两个入口都必须调，且不许任何一边再内联一份判定
    expect(source).toMatch(/assertTargetFree\(preflight\.target\.id, '发布'\)/);
    expect(source).toMatch(/assertTargetFree\(current\.targetId, '回滚'\)/);
    expect((source.match(/findSettlingExecution\(/g) || []).length).toBe(2); // 定义 + 闸内唯一一次调用
  });
});

describe('第四十二轮 P2：跨天可用率的天数必须对得上标签', () => {
  it('7d 恰好覆盖 7 个自然日，不是 8 个', async () => {
    const { availabilityOverRange } = await import('../../src/services/uptime-metrics.js');
    // 2026-07-28T12:00Z 查 7d。事故值：起点取 dayKey(now-7d)=07-21，
    // 于是 07-21..07-28 共 8 个自然日，窗口外那半天的故障也被算进去。
    const now = Date.parse('2026-07-28T12:00:00.000Z');
    const daily = [
      { day: '2026-07-21', up: 0, down: 100 },   // 窗口外的那天：全挂
      { day: '2026-07-22', up: 100, down: 0 },
      { day: '2026-07-23', up: 100, down: 0 },
      { day: '2026-07-24', up: 100, down: 0 },
      { day: '2026-07-25', up: 100, down: 0 },
      { day: '2026-07-26', up: 100, down: 0 },
      { day: '2026-07-27', up: 100, down: 0 },
      { day: '2026-07-28', up: 100, down: 0 },
    ] as never;
    const out = availabilityOverRange({ samples: [], daily }, 7 * 86_400_000, now);
    // 07-22..07-28 全绿 → 100%；把 07-21 算进来会掉到 87.5%
    expect(out.ratio).toBe(1);
  });

  it('30d 同理：恰好 30 个自然日', async () => {
    const { availabilityOverRange } = await import('../../src/services/uptime-metrics.js');
    const now = Date.parse('2026-07-28T12:00:00.000Z');
    const daily = [{ day: '2026-06-28', up: 0, down: 10 }, { day: '2026-06-29', up: 10, down: 0 }] as never;
    const out = availabilityOverRange({ samples: [], daily }, 30 * 86_400_000, now);
    // 30 个自然日的起点是 06-29，06-28 必须被排除在外
    expect(out.ratio).toBe(1);
  });
});

describe('第四十三轮 P1：排空闸必须罩住所有写入口，不能只罩一个路由器', () => {
  it('分支部署与生产发布三个入口都在闸内', async () => {
    const { isDrainBlockedPath } = await import('../../src/services/deploy-drain.js');
    // 分支侧（原本就罩着的）
    expect(isDrainBlockedPath('POST', '/branches/b1/deploy')).toBe(true);
    expect(isDrainBlockedPath('POST', '/branches/b1/deploy/api')).toBe(true);
    expect(isDrainBlockedPath('POST', '/branches/b1/force-rebuild/api')).toBe(true);
    // 事故值：这三条在另一个路由器里，从来不经过 branches 的中间件
    expect(isDrainBlockedPath('POST', '/releases/branches/b1/runs')).toBe(true);
    expect(isDrainBlockedPath('POST', '/releases/runs/rel_1/rollback')).toBe(true);
    expect(isDrainBlockedPath('POST', '/releases/runs/rel_1/retry')).toBe(true);
  });

  it('只读与自救动作不许被闸住（磁盘满/排空时还得能停能查）', async () => {
    const { isDrainBlockedPath } = await import('../../src/services/deploy-drain.js');
    expect(isDrainBlockedPath('GET', '/releases/runs')).toBe(false);
    expect(isDrainBlockedPath('POST', '/branches/b1/stop')).toBe(false);
    expect(isDrainBlockedPath('POST', '/releases/runs/rel_1/cancel')).toBe(false);
    expect(isDrainBlockedPath('POST', '/releases/targets')).toBe(false);
  });

  it('闸挂在 app 级且在两个路由器之前（源码守卫）', () => {
    const server = fs.readFileSync(path.join(REPO, 'src/server.ts'), 'utf-8');
    const gateAt = server.indexOf('isDrainBlockedPath(req.method, req.path)');
    const releasesAt = server.indexOf('createReleasesRouter({');
    const branchesAt = server.indexOf('createBranchRouter({');
    expect(gateAt).toBeGreaterThan(-1);
    expect(gateAt).toBeLessThan(releasesAt);
    expect(gateAt).toBeLessThan(branchesAt);
    // 路由器级那份必须撤掉，避免两处判定漂移
    const branches = fs.readFileSync(path.join(REPO, 'src/routes/branches.ts'), 'utf-8');
    expect(branches).not.toContain('selfUpdateDrainBlockReason(Date.now())');
  });
});

describe('第四十三轮 P2：历史曲线与可用率必须共用同一个自然日边界', () => {
  it('7d 曲线恰好 7 个桶，起点与返回的 from 一致', async () => {
    const { calendarDayWindow } = await import('../../src/services/uptime-metrics.js');
    const now = Date.parse('2026-07-28T12:00:00.000Z');
    const DAY = 86_400_000;
    const w = calendarDayWindow(7 * DAY, now);
    expect(w.days).toBe(7);
    // 事故值：now-7d = 07-21T12:00 → floor 到 07-21，于是 07-21..07-28 共 8 个桶
    expect(new Date(w.fromMs).toISOString().slice(0, 10)).toBe('2026-07-22');
    const buckets = Math.floor(now / DAY) - Math.floor(w.fromMs / DAY) + 1;
    expect(buckets).toBe(7);
  });

  it('可用率与曲线走同一个判定源（防再次只修一边）', () => {
    const metrics = fs.readFileSync(path.join(REPO, 'src/services/uptime-metrics.ts'), 'utf-8');
    const monitor = fs.readFileSync(path.join(REPO, 'src/services/uptime-monitor.ts'), 'utf-8');
    expect(metrics).toContain('export function calendarDayWindow(');
    // 可用率侧
    expect(metrics).toMatch(/const \{ fromMs \} = calendarDayWindow\(rangeMs, nowMs\);/);
    // 曲线侧
    expect(monitor).toMatch(/calendarDayWindow\(rangeMs, now\)\.fromMs/);
    // 两边都不许再自己算边界
    expect(metrics).not.toMatch(/dayKey\(nowMs - rangeMs\)/);
    expect(monitor).not.toMatch(/const from = now - rangeMs;/);
  });
});
