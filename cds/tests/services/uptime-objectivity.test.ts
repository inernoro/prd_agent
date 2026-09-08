/**
 * 监控中心「客观性」回归（2026-09-08 第二轮反馈：全站监测是否客观、手段是否客观）。
 *
 * 守四件事：
 *   1. 按容器状态判定的目标不算「正常」——它读的是 CDS 自己的记录，不是观测，单列未实测；
 *   2. 分支目标的用户视角：经预览域名整条链路探；5xx / 超时折进主采样判故障，
 *      探测器自己够不着预览域名只标 unreachable、不折（否则一屏假红）；
 *   3. 覆盖面：谁没被盯、为什么、能怎么办，从同一份目标推导；
 *   4. 探测器自身健康 + 原始采样能被前端拿到；代理侧对探测头豁免 touch（源码守卫）。
 */

import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { BranchEntry, ReleaseTarget } from '../../src/types.js';
import {
  UptimeMonitorService,
  defaultUserViewProbe,
  selectProbeTargets,
  type ProbeFn,
  type UptimeMonitorConfig,
  type UserViewProbeFn,
} from '../../src/services/uptime-monitor.js';
import { MAX_SAMPLES_PER_TARGET } from '../../src/services/uptime-metrics.js';

const MIN = 60_000;
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../');

function branch(overrides: Partial<BranchEntry> = {}): BranchEntry {
  return {
    id: 'proj-main',
    projectId: 'proj',
    branch: 'main',
    worktreePath: '/tmp/wt',
    status: 'running',
    createdAt: '2026-07-27T00:00:00.000Z',
    lastAccessedAt: '2026-09-08T09:00:00.000Z',
    services: {
      api: { profileId: 'api', containerName: 'c-api', hostPort: 10001, status: 'running' },
    },
    ...overrides,
  } as BranchEntry;
}

function releaseTarget(overrides: Partial<ReleaseTarget> = {}): ReleaseTarget {
  return {
    id: 'tgt-prod', projectId: 'proj', name: '官网', type: 'ssh', createdAt: '2026-07-28T00:00:00.000Z', isEnabled: true,
    ssh: { host: '10.0.0.1', port: 22, user: 'deploy', privateKeyRef: 'k', appPath: '/opt/app', deployCommand: './d.sh', healthcheckUrl: 'https://prod.example.test/health' },
    ...overrides,
  } as ReleaseTarget;
}

function testConfig(overrides: Partial<UptimeMonitorConfig> = {}): UptimeMonitorConfig {
  return {
    enabled: true, intervalMs: MIN, timeoutMs: 5_000, failureThreshold: 3, recoveryThreshold: 1,
    maxSamples: MAX_SAMPLES_PER_TARGET, excludePatterns: [], scope: 'all', storePath: '', userViewEnabled: true, ...overrides,
  };
}

function makeMonitor(opts: {
  branches?: BranchEntry[];
  releaseTargets?: ReleaseTarget[];
  probe?: ProbeFn;
  userViewProbe?: UserViewProbeFn;
  now: () => number;
  config?: Partial<UptimeMonitorConfig>;
  previewUrl?: (b: BranchEntry) => string;
}): UptimeMonitorService {
  return new UptimeMonitorService({
    state: {
      getAllBranches: () => opts.branches || [],
      getReleaseTargets: () => opts.releaseTargets || [],
      getProject: () => ({ id: 'proj', name: 'MAP 平台' } as never),
      getPreviewUrl: opts.previewUrl || ((b) => `https://${b.id}.preview.test`),
    },
    config: testConfig(opts.config),
    probe: opts.probe || (async () => ({ up: true, ms: 10, code: 200 })),
    userViewProbe: opts.userViewProbe,
    now: opts.now,
  });
}

describe('未实测：按容器状态判定不算正常', () => {
  it('没有宿主端口的服务只按容器状态判，摘要里 measured=false、计入 unmeasured 而不是 up', async () => {
    const svc = makeMonitor({
      branches: [branch({ services: {
        api: { profileId: 'api', containerName: 'c', hostPort: 10001, status: 'running' },
        worker: { profileId: 'worker', containerName: 'w', hostPort: 0, status: 'running' },
      } as never })],
      userViewProbe: async () => ({ up: true, ms: 5, code: 200 }),
      now: () => MIN,
    });
    await svc.runCycle();
    const summary = svc.getSummary(10);
    const worker = summary.targets.find((t) => t.profileId === 'worker')!;
    const api = summary.targets.find((t) => t.profileId === 'api')!;
    expect(worker.measured).toBe(false);
    expect(worker.status).toBe('up');
    expect(api.measured).toBe(true);
    expect(summary.overall).toMatchObject({ up: 1, unmeasured: 1, down: 0 });
  });
});

describe('用户视角：经预览域名的第二判定', () => {
  it('分支目标带 branchName / projectName / userViewUrl；每条分支只探一次预览域名', async () => {
    const uv = vi.fn(async () => ({ up: true, ms: 30, code: 200 }));
    const svc = makeMonitor({
      branches: [branch({ services: {
        api: { profileId: 'api', containerName: 'c', hostPort: 10001, status: 'running' },
        web: { profileId: 'web', containerName: 'w', hostPort: 10002, status: 'running' },
      } as never })],
      userViewProbe: uv,
      now: () => MIN,
    });
    await svc.runCycle();
    expect(uv).toHaveBeenCalledTimes(1);
    expect(uv).toHaveBeenCalledWith('https://proj-main.preview.test', 5_000);
    const t = svc.getSummary(10).targets[0];
    expect(t).toMatchObject({ branchName: 'main', projectName: 'MAP 平台', branchStatus: 'running' });
    expect(t.userView).toMatchObject({ url: 'https://proj-main.preview.test', status: 'up' });
    expect(t.userView?.lastSample?.ms).toBe(30);
  });

  it('进程在答但用户视角 5xx：折进主采样，连续三次判故障，原因写明是用户视角', async () => {
    let now = 0;
    const svc = makeMonitor({
      branches: [branch()],
      userViewProbe: async () => ({ up: false, ms: 40, code: 502, err: '用户视角 HTTP 502' }),
      now: () => now,
    });
    for (let i = 0; i < 3; i += 1) { now += MIN; await svc.runCycle(); }
    const t = svc.getSummary(10).targets[0];
    expect(t.status).toBe('down');
    expect(t.lastSample?.err).toContain('用户视角');
    expect(t.userView?.status).toBe('down');
    expect(svc.getIncidents()[0].cause).toContain('用户视角');
  });

  it('探测器够不着预览域名（unreachable）：只标在 userView 上，主采样不折、不判故障', async () => {
    let now = 0;
    const svc = makeMonitor({
      branches: [branch()],
      userViewProbe: async () => ({ up: false, ms: 0, err: '探测器够不着预览域名：ENOTFOUND', unreachable: true }),
      now: () => now,
    });
    for (let i = 0; i < 3; i += 1) { now += MIN; await svc.runCycle(); }
    const t = svc.getSummary(10).targets[0];
    expect(t.status).toBe('up');
    expect(t.userView).toMatchObject({ status: 'unknown', unreachable: true });
  });

  it('关闭用户视角（CDS_UPTIME_USER_VIEW=0）或没有预览地址：不探，也不带 userView', async () => {
    const uv = vi.fn(async () => ({ up: true, ms: 1 }));
    const off = makeMonitor({ branches: [branch()], userViewProbe: uv, now: () => MIN, config: { userViewEnabled: false } });
    await off.runCycle();
    const noUrl = makeMonitor({ branches: [branch()], userViewProbe: uv, now: () => MIN, previewUrl: () => '' });
    await noUrl.runCycle();
    expect(uv).not.toHaveBeenCalled();
    expect(off.getSummary(10).targets[0].userView).toBeUndefined();
    expect(off.getSummary(10).prober.userViewEnabled).toBe(false);
  });

  it('生产 / 自定义目标不做用户视角（它们探的本来就是对外地址）', async () => {
    const uv = vi.fn(async () => ({ up: true, ms: 1 }));
    const svc = makeMonitor({ releaseTargets: [releaseTarget()], userViewProbe: uv, now: () => MIN });
    await svc.runCycle();
    expect(uv).not.toHaveBeenCalled();
  });

  it('defaultUserViewProbe：真请求，带探测头；< 500 可达、5xx 失败、连不上标 unreachable', async () => {
    let seenPoll = '';
    const server = http.createServer((req, res) => {
      seenPoll = String(req.headers['x-cds-poll']);
      res.statusCode = req.url === '/ok' ? 401 : 503;
      res.end('x');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const ok = await defaultUserViewProbe(`http://127.0.0.1:${port}/ok`, 2000);
      expect(ok).toMatchObject({ up: true, code: 401 });
      expect(seenPoll).toBe('true');
      const bad = await defaultUserViewProbe(`http://127.0.0.1:${port}/bad`, 2000);
      expect(bad).toMatchObject({ up: false, code: 503 });
      expect(bad.unreachable).toBeFalsy();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    const dead = await defaultUserViewProbe(`http://127.0.0.1:${port}/`, 2000);
    expect(dead.up).toBe(false);
    expect(dead.unreachable).toBe(true);
  });
});

describe('覆盖面与探测器健康', () => {
  it('coverage：排除名单 / 远端执行器 / 发布目标缺上线地址 逐条列原因与动作；降温分支算已纳入', async () => {
    const svc = makeMonitor({
      branches: [
        branch(),
        branch({ id: 'proj-idle', branch: 'feat/idle', status: 'idle' }),
        branch({ id: 'proj-remote', branch: 'feat/remote', executorId: 'exec-remote-1' } as never),
        branch({ id: 'proj-grpc', branch: 'feat/grpc', services: { grpc: { profileId: 'grpc', containerName: 'g', hostPort: 10009, status: 'running' } } as never }),
      ],
      releaseTargets: [releaseTarget(), releaseTarget({ id: 'tgt-admin', name: '后台', ssh: { ...releaseTarget().ssh!, healthcheckUrl: '' } })],
      userViewProbe: async () => ({ up: true, ms: 1 }),
      now: () => MIN,
      config: { excludePatterns: ['*/grpc'] },
    });
    await svc.runCycle();
    const { coverage } = svc.getSummary(10);
    expect(coverage.total).toBe(6);
    expect(coverage.covered).toBe(3);
    expect(coverage.scope).toBe('all');
    expect(coverage.uncovered.map((u) => [u.kind, u.name])).toEqual([
      ['远端执行器探不到', 'feat/remote / api'],
      ['命中排除名单', 'feat/grpc / grpc'],
      ['发布目标缺上线地址', '生产 / 后台'],
    ]);
    expect(coverage.uncovered.every((u) => u.reason && u.action)).toBe(true);
    expect(coverage.byReason).toEqual([
      { kind: '远端执行器探不到', count: 1 }, { kind: '命中排除名单', count: 1 }, { kind: '发布目标缺上线地址', count: 1 },
    ]);
  });

  it('prober：记录上一轮时刻 / 耗时 / 探了几个；超过两个间隔没跑判 stalled', async () => {
    let now = MIN;
    const svc = makeMonitor({ branches: [branch()], userViewProbe: async () => ({ up: true, ms: 1 }), now: () => now });
    await svc.runCycle();
    let p = svc.getSummary(10).prober;
    expect(p).toMatchObject({ lastCycleAt: MIN, lastCycleProbed: 1, lastCycleTargets: 1, stalled: false });
    now = MIN * 4;
    p = svc.getSummary(10).prober;
    expect(p.stalled).toBe(true);
  });

  it('history 附最近原始采样，最新在前', async () => {
    let now = 0;
    const svc = makeMonitor({ branches: [branch()], userViewProbe: async () => ({ up: true, ms: 1 }), now: () => now });
    for (let i = 1; i <= 25; i += 1) { now = i * MIN; await svc.runCycle(); }
    const h = svc.getHistory('proj-main::api', 24 * 3600 * 1000, 90)!;
    expect(h.recentSamples).toHaveLength(20);
    expect(h.recentSamples[0].t).toBe(25 * MIN);
    expect(h.recentSamples[19].t).toBe(6 * MIN);
  });
});

describe('接线守卫', () => {
  it('index.ts 给探测器接上 getPreviewUrl（少了它分支永远没有用户视角）', () => {
    const src = fs.readFileSync(path.join(REPO, 'src/index.ts'), 'utf8');
    const window = src.slice(src.indexOf('new UptimeMonitorService({'), src.indexOf('uptimeMonitor.start()'));
    expect(window).toContain('getPreviewUrl: (branch) =>');
    expect(window).toContain('buildPreviewUrlForProject(previewHost, branch.branch');
  });

  it('proxy.ts 对可信探测请求不 touch 调度器、不记访问（否则用户视角探测让分支永不降温）', () => {
    const src = fs.readFileSync(path.join(REPO, 'src/services/proxy.ts'), 'utf8');
    expect(src).toContain('const isProbeRequest = isTrustedProbeRequest(req.headers);');
    expect(src).toMatch(/if \(this\.scheduler && !isProbeRequest\)/);
    expect(src).toContain('trackAccess: !isProbeRequest');
  });

  it('selectProbeTargets 把预览地址挂到每个分支目标上', () => {
    const targets = selectProbeTargets([branch()], [], { getPreviewUrl: (b) => `https://${b.id}.x` });
    expect(targets[0].userViewUrl).toBe('https://proj-main.x');
    expect(targets[0].branchName).toBe('main');
  });
});
