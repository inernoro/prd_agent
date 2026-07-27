import { describe, it, expect, vi } from 'vitest';
import type { BranchEntry } from '../../src/types.js';
import {
  UptimeMonitorService,
  classifyProbeFailure,
  parseExcludePatterns,
  pausedReasonOf,
  selectProbeTargets,
  uptimeConfigFromEnv,
  type ProbeFn,
  type UptimeMonitorConfig,
} from '../../src/services/uptime-monitor.js';
import { MAX_SAMPLES_PER_TARGET } from '../../src/services/uptime-metrics.js';

/**
 * 探测器编排回归。最要紧的一条是「探测不刷新 scheduler 的 lastAccessedAt」——
 * 若探测走预览域名/代理，ProxyService 每次转发都会 scheduler.touch()，分支
 * 就永远不会被 idleTTL 降温，等于把 warm-pool 调度废掉。本服务因此直连
 * 127.0.0.1:hostPort 且不持有 StateService 写入面。
 */

const MIN = 60_000;

function branch(overrides: Partial<BranchEntry> = {}): BranchEntry {
  return {
    id: 'proj-feat-a',
    projectId: 'proj',
    branch: 'feat/a',
    worktreePath: '/tmp/wt',
    status: 'running',
    createdAt: '2026-07-27T00:00:00.000Z',
    lastAccessedAt: '2026-07-27T09:00:00.000Z',
    services: {
      api: { profileId: 'api', containerName: 'cds-proj-feat-a-api', hostPort: 10001, status: 'running' },
    },
    ...overrides,
  } as BranchEntry;
}

function testConfig(overrides: Partial<UptimeMonitorConfig> = {}): UptimeMonitorConfig {
  return {
    enabled: true,
    intervalMs: 60_000,
    timeoutMs: 5_000,
    failureThreshold: 3,
    recoveryThreshold: 1,
    maxSamples: MAX_SAMPLES_PER_TARGET,
    excludePatterns: [],
    storePath: '', // 空串 = 只在内存跑，测试不落盘
    ...overrides,
  };
}

function makeMonitor(opts: {
  branches: BranchEntry[];
  probe: ProbeFn;
  now: () => number;
  config?: Partial<UptimeMonitorConfig>;
}): UptimeMonitorService {
  return new UptimeMonitorService({
    state: { getAllBranches: () => opts.branches },
    config: testConfig(opts.config),
    probe: opts.probe,
    now: opts.now,
  });
}

describe('selectProbeTargets 目标推导', () => {
  it('running 分支的 running 服务 → active 的 HTTP 探测目标', () => {
    const targets = selectProbeTargets([branch()]);
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      id: 'proj-feat-a::api',
      probeKind: 'http',
      active: true,
      hostPort: 10001,
      name: 'feat/a / api',
    });
  });

  it('降温 / 构建中的分支 → active=false（不是故障，只是暂停）', () => {
    const cold = selectProbeTargets([branch({ status: 'idle' })]);
    expect(cold[0].active).toBe(false);
    expect(pausedReasonOf(cold[0])).toContain('降温');

    const building = selectProbeTargets([branch({ status: 'building' })]);
    expect(building[0].active).toBe(false);
  });

  it('没有 hostPort 时退化为 container 探测', () => {
    const targets = selectProbeTargets([branch({
      services: { api: { profileId: 'api', containerName: 'c', hostPort: 0, status: 'running' } },
    } as Partial<BranchEntry>)]);
    expect(targets[0].probeKind).toBe('container');
  });

  it('删除中的分支整个跳过', () => {
    expect(selectProbeTargets([branch({ deleting: true })])).toHaveLength(0);
  });
});

describe('UptimeMonitorService 探测轮次', () => {
  it('探测不刷新 lastAccessedAt，也不写分支台账（否则 idleTTL 降温被废）', async () => {
    const b = branch();
    const before = b.lastAccessedAt;
    const beforeSnapshot = JSON.stringify(b);
    let clock = Date.UTC(2026, 6, 27, 12, 0, 0);
    const getAllBranches = vi.fn(() => [b]);
    const monitor = new UptimeMonitorService({
      state: { getAllBranches },
      config: testConfig(),
      probe: async () => ({ up: true, ms: 12, code: 200 }),
      now: () => clock,
    });

    for (let i = 0; i < 5; i++) {
      clock += MIN;
      await monitor.runCycle();
    }

    expect(b.lastAccessedAt).toBe(before);
    expect(JSON.stringify(b)).toBe(beforeSnapshot);
    // 监控只拿到只读的 getAllBranches，拿不到 scheduler.touch / state.save 的口子。
    expect(getAllBranches).toHaveBeenCalled();
    expect(monitor.getRecord('proj-feat-a::api')?.samples).toHaveLength(5);
  });

  it('连续 3 次失败才判 down 并开一条故障事件，恢复后关闭', async () => {
    const b = branch();
    let clock = Date.UTC(2026, 6, 27, 12, 0, 0);
    let up = false;
    const monitor = makeMonitor({
      branches: [b],
      probe: async () => (up ? { up: true, ms: 10, code: 200 } : { up: false, ms: 0, err: 'ECONNREFUSED' }),
      now: () => clock,
    });

    await monitor.runCycle();
    expect(monitor.getSummary().targets[0].status).not.toBe('down');
    clock += MIN;
    await monitor.runCycle();
    expect(monitor.getSummary().targets[0].status).not.toBe('down');
    clock += MIN;
    await monitor.runCycle();

    const downSummary = monitor.getSummary();
    expect(downSummary.targets[0].status).toBe('down');
    expect(downSummary.overall.ok).toBe(false);
    expect(monitor.getIncidents()).toHaveLength(1);
    expect(monitor.getIncidents()[0]).toMatchObject({ ongoing: true, cause: 'ECONNREFUSED' });

    up = true;
    clock += MIN;
    await monitor.runCycle();
    expect(monitor.getSummary().targets[0].status).toBe('up');
    expect(monitor.getIncidents()[0].ongoing).toBe(false);
    // 第 3 轮（T0+2min）判 down，第 4 轮（T0+3min）恢复 → 时长 1 分钟
    expect(monitor.getIncidents()[0].durationMs).toBe(MIN);
  });

  it('分支降温后不产采样、不判故障，并把在跑的故障事件就地收尾', async () => {
    const b = branch();
    let clock = Date.UTC(2026, 6, 27, 12, 0, 0);
    const probe = vi.fn<Parameters<ProbeFn>, ReturnType<ProbeFn>>(async () => ({ up: false, ms: 0, err: 'down' }));
    const monitor = makeMonitor({ branches: [b], probe, now: () => clock, config: { failureThreshold: 1 } });

    await monitor.runCycle();
    expect(monitor.getIncidents()[0].ongoing).toBe(true);
    const callsAfterFirst = probe.mock.calls.length;

    b.status = 'idle';
    clock += MIN;
    await monitor.runCycle();

    expect(probe.mock.calls.length).toBe(callsAfterFirst); // 降温后不再探测
    const summary = monitor.getSummary();
    expect(summary.targets[0].status).toBe('paused');
    expect(summary.targets[0].pausedReason).toContain('降温');
    expect(summary.overall.paused).toBe(1);
    expect(summary.overall.ok).toBe(true); // 暂停不算故障
    expect(monitor.getIncidents()[0].ongoing).toBe(false);
  });

  it('环形缓冲上限：跑满 2000 轮后采样条数仍等于上限，不溢出', async () => {
    const b = branch();
    let clock = Date.UTC(2026, 6, 20, 0, 0, 0);
    const monitor = makeMonitor({
      branches: [b],
      probe: async () => ({ up: true, ms: 5, code: 200 }),
      now: () => clock,
      config: { maxSamples: 120 },
    });
    for (let i = 0; i < 2000; i++) {
      clock += MIN;
      await monitor.runCycle();
    }
    const record = monitor.getRecord('proj-feat-a::api');
    expect(record?.samples).toHaveLength(120);
    // 按天聚合承接更长历史，同样有上限
    expect((record?.daily.length ?? 0)).toBeLessThanOrEqual(30);
  });

  it('分支被删除后台账清理，records 不会无限增长', async () => {
    const branches = [branch(), branch({ id: 'proj-feat-b', branch: 'feat/b' })];
    let clock = Date.UTC(2026, 6, 27, 12, 0, 0);
    const monitor = makeMonitor({
      branches,
      probe: async () => ({ up: true, ms: 5, code: 200 }),
      now: () => clock,
    });
    await monitor.runCycle();
    expect(monitor.getSummary().targets).toHaveLength(2);

    branches.pop();
    clock += MIN;
    await monitor.runCycle();
    expect(monitor.getSummary().targets).toHaveLength(1);
    expect(monitor.getRecord('proj-feat-b::api')).toBeUndefined();
  });

  it('summary 的柱条恒为请求段数，history 的点数被降采样闸收敛', async () => {
    const b = branch();
    let clock = Date.UTC(2026, 6, 27, 12, 0, 0);
    const monitor = makeMonitor({
      branches: [b],
      probe: async () => ({ up: true, ms: 5, code: 200 }),
      now: () => clock,
    });
    await monitor.runCycle();

    expect(monitor.getSummary().targets[0].buckets).toHaveLength(90);
    expect(monitor.getSummary(30).targets[0].buckets).toHaveLength(30);

    const history = monitor.getHistory('proj-feat-a::api', 24 * 3600_000, 100_000);
    expect(history?.points.length).toBe(500);
    expect(monitor.getHistory('missing::api', 3600_000, 10)).toBeNull();
  });

  it('探测抛异常时算一次失败采样，不让整轮炸掉', async () => {
    const b = branch();
    let clock = Date.UTC(2026, 6, 27, 12, 0, 0);
    const monitor = makeMonitor({
      branches: [b],
      probe: async () => { throw new Error('socket hang up'); },
      now: () => clock,
      config: { failureThreshold: 1 },
    });
    await expect(monitor.runCycle()).resolves.toBeUndefined();
    expect(monitor.getSummary().targets[0].status).toBe('down');
    expect(monitor.getSummary().targets[0].lastSample?.err).toBe('socket hang up');
  });

  it('可关闭：enabled=false 时 start() 不建计时器、不发探测', async () => {
    const probe = vi.fn<Parameters<ProbeFn>, ReturnType<ProbeFn>>(async () => ({ up: true, ms: 1 }));
    const monitor = makeMonitor({
      branches: [branch()],
      probe,
      now: () => Date.now(),
      config: { enabled: false },
    });
    monitor.start();
    await new Promise((r) => setTimeout(r, 10));
    expect(probe).not.toHaveBeenCalled();
    expect(monitor.getSummary().enabled).toBe(false);
    monitor.stop();
  });
});

describe('uptimeConfigFromEnv 配置解析', () => {
  it('默认开启，间隔 60s、超时 5s、失败阈值 3', () => {
    delete process.env.CDS_UPTIME_ENABLED;
    delete process.env.CDS_UPTIME_INTERVAL_SECONDS;
    delete process.env.CDS_UPTIME_TIMEOUT_MS;
    delete process.env.CDS_UPTIME_FAILURE_THRESHOLD;
    const config = uptimeConfigFromEnv('/srv/cds');
    expect(config).toMatchObject({ enabled: true, intervalMs: 60_000, timeoutMs: 5_000, failureThreshold: 3 });
    expect(config.storePath).toBe('/srv/cds/.cds/uptime-monitor.json');
  });

  it('CDS_UPTIME_ENABLED=0 关停；数值项越界被收敛到合法区间', () => {
    process.env.CDS_UPTIME_ENABLED = '0';
    process.env.CDS_UPTIME_INTERVAL_SECONDS = '1';
    process.env.CDS_UPTIME_TIMEOUT_MS = '999999';
    try {
      const config = uptimeConfigFromEnv('/srv/cds');
      expect(config.enabled).toBe(false);
      expect(config.intervalMs).toBe(10_000);
      expect(config.timeoutMs).toBe(30_000);
    } finally {
      delete process.env.CDS_UPTIME_ENABLED;
      delete process.env.CDS_UPTIME_INTERVAL_SECONDS;
      delete process.env.CDS_UPTIME_TIMEOUT_MS;
    }
  });

  it('CDS_UPTIME_EXCLUDE 解析成排除名单（逗号/分号/换行/空格都算分隔）', () => {
    process.env.CDS_UPTIME_EXCLUDE = ' proj-feat-a::worker , grpc-*;\n api-legacy ';
    try {
      expect(uptimeConfigFromEnv('/srv/cds').excludePatterns).toEqual([
        'proj-feat-a::worker',
        'grpc-*',
        'api-legacy',
      ]);
    } finally {
      delete process.env.CDS_UPTIME_EXCLUDE;
    }
    delete process.env.CDS_UPTIME_EXCLUDE;
    expect(uptimeConfigFromEnv('/srv/cds').excludePatterns).toEqual([]);
  });
});

/**
 * 逃生阀：非 HTTP 服务（gRPC / 纯 worker / 只发布 TCP 端口）不该被永久标成故障。
 * 运维必须能单独关掉某个目标，而不是只能把整个监控关停。
 */
describe('排除名单（逃生阀）', () => {
  it('parseExcludePatterns 去空白、丢空项', () => {
    expect(parseExcludePatterns('a, b ;;\n c')).toEqual(['a', 'b', 'c']);
    expect(parseExcludePatterns(undefined)).toEqual([]);
    expect(parseExcludePatterns('   ')).toEqual([]);
  });

  it('命中排除名单的目标不探测、不计故障，标为「未纳入监控」', async () => {
    const b = branch({
      services: {
        api: { profileId: 'api', containerName: 'c-api', hostPort: 10001, status: 'running' },
        grpc: { profileId: 'grpc', containerName: 'c-grpc', hostPort: 10002, status: 'running' },
      },
    } as Partial<BranchEntry>);
    const targets = selectProbeTargets([b], ['grpc']);
    const grpc = targets.find((t) => t.profileId === 'grpc')!;
    expect(grpc.excluded).toBe(true);
    expect(grpc.active).toBe(false);
    expect(pausedReasonOf(grpc)).toContain('未纳入监控');
    expect(targets.find((t) => t.profileId === 'api')!.excluded).toBe(false);

    let clock = Date.UTC(2026, 6, 27, 12, 0, 0);
    const probe = vi.fn<Parameters<ProbeFn>, ReturnType<ProbeFn>>(async () => ({ up: true, ms: 3, code: 200 }));
    const monitor = makeMonitor({
      branches: [b],
      probe,
      now: () => clock,
      config: { excludePatterns: ['grpc'] },
    });
    await monitor.runCycle();

    expect(probe.mock.calls.map((c) => c[0].profileId)).toEqual(['api']);
    const summary = monitor.getSummary();
    expect(summary.excludePatterns).toEqual(['grpc']);
    expect(summary.overall.excluded).toBe(1);
    expect(summary.overall.down).toBe(0);
    expect(summary.overall.ok).toBe(true);
    const grpcRow = summary.targets.find((t) => t.profileId === 'grpc')!;
    expect(grpcRow.excluded).toBe(true);
    expect(grpcRow.pausedReason).toContain('未纳入监控');
  });

  it('通配符可按分支/项目维度排除，且能把已开的故障事件就地收尾', async () => {
    const b = branch();
    let clock = Date.UTC(2026, 6, 27, 12, 0, 0);
    const patterns: string[] = [];
    const monitor = makeMonitor({
      branches: [b],
      // patterns 是同一个数组引用，后面 push 即可模拟运维中途加排除规则
      config: { failureThreshold: 1, excludePatterns: patterns },
      probe: async () => ({ up: false, ms: 0, err: 'ECONNREFUSED' }),
      now: () => clock,
    });

    await monitor.runCycle();
    expect(monitor.getSummary().overall.down).toBe(1);
    expect(monitor.getIncidents()[0].ongoing).toBe(true);

    patterns.push('proj/*');
    clock += MIN;
    await monitor.runCycle();

    const summary = monitor.getSummary();
    expect(summary.overall.down).toBe(0);
    expect(summary.overall.excluded).toBe(1);
    expect(summary.overall.ok).toBe(true);
    expect(monitor.getIncidents()[0].ongoing).toBe(false);
  });
});

/**
 * 自动降级：端口开着但不说 HTTP（gRPC / 裸 TCP）会连续拿到协议层错误。
 * 这类目标要自动改判「容器状态」，而不是永久红。真正的连接被拒 / 超时
 * 仍然必须判故障，否则监控就没用了。
 */
describe('非 HTTP 响应自动降级为容器状态判定', () => {
  it('classifyProbeFailure 区分 HTTP 状态错误 / 协议层错误 / 不可达', () => {
    expect(classifyProbeFailure({ t: 1, up: true, ms: 5, code: 200 })).toBe('none');
    expect(classifyProbeFailure({ t: 1, up: false, ms: 5, code: 503, err: 'HTTP 503' })).toBe('http-status');
    expect(classifyProbeFailure({ t: 1, up: false, ms: 5, err: 'Parse Error: Expected HTTP/' })).toBe('protocol');
    expect(classifyProbeFailure({ t: 1, up: false, ms: 5, err: 'socket hang up' })).toBe('protocol');
    expect(classifyProbeFailure({ t: 1, up: false, ms: 5, err: 'read ECONNRESET' })).toBe('protocol');
    expect(classifyProbeFailure({ t: 1, up: false, ms: 5, err: 'connect ECONNREFUSED 127.0.0.1:10001' })).toBe('unreachable');
    expect(classifyProbeFailure({ t: 1, up: false, ms: 5, err: '探测超时（5000ms）' })).toBe('unreachable');
  });

  it('从未答过 HTTP 的目标连续协议层失败 → 改按容器状态判定，不判故障', async () => {
    const b = branch();
    let clock = Date.UTC(2026, 6, 27, 12, 0, 0);
    const probe: ProbeFn = async (target) => (target.probeKind === 'container'
      ? { up: target.serviceStatus === 'running', ms: 0 }
      : { up: false, ms: 2, err: 'Parse Error: Expected HTTP/' });
    const monitor = makeMonitor({ branches: [b], probe, now: () => clock });

    for (let i = 0; i < 3; i++) {
      await monitor.runCycle();
      clock += MIN;
    }

    const summary = monitor.getSummary();
    const row = summary.targets[0];
    expect(row.probeKind).toBe('container');
    expect(row.degraded).toBe(true);
    expect(row.degradeReason).toContain('容器状态');
    expect(row.status).toBe('up');
    expect(summary.overall.down).toBe(0);
    expect(monitor.getIncidents()).toHaveLength(0);

    // 降级后继续跑，仍然按容器状态判定，不会自己变回 HTTP 探测
    await monitor.runCycle();
    expect(monitor.getSummary().targets[0].probeKind).toBe('container');
  });

  it('连接被拒（真故障）不降级，照常判 down', async () => {
    const b = branch();
    let clock = Date.UTC(2026, 6, 27, 12, 0, 0);
    const monitor = makeMonitor({
      branches: [b],
      probe: async () => ({ up: false, ms: 0, err: 'connect ECONNREFUSED 127.0.0.1:10001' }),
      now: () => clock,
    });
    for (let i = 0; i < 3; i++) {
      await monitor.runCycle();
      clock += MIN;
    }
    const row = monitor.getSummary().targets[0];
    expect(row.degraded).toBe(false);
    expect(row.probeKind).toBe('http');
    expect(row.status).toBe('down');
  });

  it('曾经答过 HTTP 的目标后来连接被重置 → 视为真故障，不降级', async () => {
    const b = branch();
    let clock = Date.UTC(2026, 6, 27, 12, 0, 0);
    let healthy = true;
    const monitor = makeMonitor({
      branches: [b],
      probe: async () => (healthy
        ? { up: true, ms: 8, code: 200 }
        : { up: false, ms: 1, err: 'read ECONNRESET' }),
      now: () => clock,
    });
    await monitor.runCycle();
    healthy = false;
    for (let i = 0; i < 3; i++) {
      clock += MIN;
      await monitor.runCycle();
    }
    const row = monitor.getSummary().targets[0];
    expect(row.degraded).toBe(false);
    expect(row.status).toBe('down');
    expect(monitor.getIncidents()[0].ongoing).toBe(true);
  });

  it('分支重新部署换了宿主机端口时解除降级，重新按 HTTP 探测', async () => {
    const b = branch();
    let clock = Date.UTC(2026, 6, 27, 12, 0, 0);
    const seen: string[] = [];
    const probe: ProbeFn = async (target) => {
      seen.push(target.probeKind);
      return target.probeKind === 'container'
        ? { up: true, ms: 0 }
        : { up: false, ms: 2, err: 'Parse Error: Expected HTTP/' };
    };
    const monitor = makeMonitor({ branches: [b], probe, now: () => clock });
    for (let i = 0; i < 3; i++) {
      await monitor.runCycle();
      clock += MIN;
    }
    expect(monitor.getSummary().targets[0].degraded).toBe(true);

    b.services.api.hostPort = 10099; // 重新部署，端口重分配
    await monitor.runCycle();
    expect(seen[seen.length - 1]).toBe('http');
    expect(monitor.getSummary().targets[0].degraded).toBe(false);
  });
});
