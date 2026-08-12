/**
 * 生产存活监控回归（发布目标纳入 uptime）。
 *
 * 这批用例守的是同一件事：**生产目标不能被分支专用逻辑误伤，也不能被降级闸吞成假绿**。
 * 每条都标了事故值（不修会发生什么），因为这些坑的共同后果是「状态页是绿的，
 * 生产是死的」——比没有状态页更危险。
 */

import { describe, it, expect } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { BranchEntry, ReleaseTarget } from '../../src/types.js';
import {
  UptimeMonitorService,
  defaultHttpProbe,
  pausedReasonOf,
  selectAllProbeTargets,
  selectReleaseProbeTargets,
  type ProbeFn,
  type ProbeTarget,
  type UptimeMonitorConfig,
} from '../../src/services/uptime-monitor.js';
import {
  RELEASE_PROBE_ID_PREFIX,
  isReleaseTargetProbeable,
  releaseProbeSkipReason,
  releaseProbeTargetId,
  releaseProbeUrl,
} from '../../src/services/release-probe-target.js';
import { MAX_SAMPLES_PER_TARGET } from '../../src/services/uptime-metrics.js';

const HEALTH_URL = 'https://prod.example.test/health';

/** 绑一个端口再立刻放掉，拿到一个确定「没人监听」的地址：探了必失败，跳过则无痕。 */
async function unreachableUrl(): Promise<string> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}/health`;
}

function releaseTarget(overrides: Partial<ReleaseTarget> = {}): ReleaseTarget {
  return {
    id: 'tgt-prod',
    projectId: 'proj',
    name: '官网',
    type: 'ssh',
    createdAt: '2026-07-28T00:00:00.000Z',
    isEnabled: true,
    ssh: {
      host: '10.0.0.1',
      port: 22,
      user: 'deploy',
      privateKeyRef: 'host-prod',
      appPath: '/opt/app',
      deployCommand: './deploy.sh',
      healthcheckUrl: HEALTH_URL,
    },
    ...overrides,
  };
}

function branch(overrides: Partial<BranchEntry> = {}): BranchEntry {
  return {
    id: 'proj-feat-a',
    projectId: 'proj',
    branch: 'feat/a',
    worktreePath: '/tmp/wt',
    status: 'running',
    createdAt: '2026-07-27T00:00:00.000Z',
    services: {
      api: { profileId: 'api', containerName: 'c', hostPort: 10001, status: 'running' },
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
    scope: 'trunk',
    storePath: '',
    ...overrides,
  };
}

function makeMonitor(opts: {
  branches?: BranchEntry[];
  releaseTargets?: ReleaseTarget[];
  probe: ProbeFn;
  now: () => number;
  config?: Partial<UptimeMonitorConfig>;
}): UptimeMonitorService {
  return new UptimeMonitorService({
    state: {
      getAllBranches: () => opts.branches || [],
      getReleaseTargets: () => opts.releaseTargets || [],
    },
    config: testConfig(opts.config),
    probe: opts.probe,
    now: opts.now,
  });
}

describe('发布目标不受分支专用逻辑误伤', () => {
  it('scope=trunk（默认）下发布目标照常产出', () => {
    // 事故值：发布目标走进 selectProbeTargets 的分支循环，被
    // `scope === trunk && !isTrunkBranch` 一刀 continue 掉 ——
    // 默认配置下生产目标永远不会出现在状态页，功能等于没做。
    const targets = selectAllProbeTargets([branch()], [releaseTarget()], [], { scope: 'trunk' });
    const release = targets.filter((t) => t.probeKind === 'url');
    expect(release).toHaveLength(1);
    expect(release[0]!.active).toBe(true);
    // 同一次调用里，特性分支确实被 trunk 收窄掉了 —— 证明不是靠放宽 scope 换来的。
    expect(targets.filter((t) => t.probeKind !== 'url')).toHaveLength(0);
  });

  it('远端 executor 排除只作用于分支，不影响发布目标', () => {
    // 事故值：那条规则治的是「hostPort 属于另一台机器」，而 URL 探测打的是公网
    // 地址，与容器跑在哪台机器无关。误用会让集群部署下生产目标全部沉默。
    const remoteBranch = branch({ executorId: 'node-2', id: 'proj-main', branch: 'main' } as Partial<BranchEntry>);
    const targets = selectAllProbeTargets([remoteBranch], [releaseTarget()], [], { scope: 'all' });
    expect(targets.find((t) => t.probeKind === 'http')!.active).toBe(false);
    const release = targets.find((t) => t.probeKind === 'url')!;
    expect(release.active).toBe(true);
    // 发布目标压根没有 executor 归属这一维，别给它扣上分支的帽子。
    expect(release.remoteExecutor).toBeUndefined();
  });

  it('发布目标的 id 与分支目标的 id 不可能撞键', () => {
    // 事故值：撞键 = 两个目标共用一条 records 记录，谁后写谁覆盖，状态页上
    // 生产目标显示的是某条分支的可用率。
    const legacyBranch = branch({ id: 'release', branch: 'release', projectId: 'proj' });
    const targets = selectAllProbeTargets(
      [legacyBranch],
      [releaseTarget({ id: 'api' })],
      [],
      { scope: 'all' },
    );
    const ids = targets.map((t) => t.id);
    expect(ids).toContain('release::api');
    expect(ids).toContain('release@api');
    expect(new Set(ids).size).toBe(ids.length);
    // 结构性保证：发布目标 id 里没有 `::`，而分支目标 id 必然有。
    expect(RELEASE_PROBE_ID_PREFIX).not.toContain('::');
    expect(releaseProbeTargetId({ id: 'api' })).not.toContain('::');
  });
});

describe('不可探测的发布目标记 paused，不记故障', () => {
  const cases: Array<{ label: string; target: ReleaseTarget; reason: string }> = [
    { label: '已停用', target: releaseTarget({ isEnabled: false }), reason: '已停用' },
    { label: '已归档', target: releaseTarget({ lifecycle: 'archived' }), reason: '已归档' },
    { label: '非 SSH 类型', target: releaseTarget({ type: 'webhook' }), reason: '不是站点' },
    {
      label: '未配置上线地址',
      target: releaseTarget({ ssh: { ...releaseTarget().ssh!, healthcheckUrl: '   ' } }),
      reason: '未配置上线地址',
    },
  ];

  for (const { label, target, reason } of cases) {
    it(`${label} → paused + 人话原因，且从不发探测`, async () => {
      const probe: ProbeFn = async () => { throw new Error('不可探测的目标不该被探测'); };
      const monitor = makeMonitor({ releaseTargets: [target], probe, now: () => 1_000 });
      await monitor.runCycle();
      const record = monitor.getRecord(releaseProbeTargetId(target))!;
      expect(record.status).toBe('paused');
      expect(record.pausedReason).toContain(reason);
      // paused 文案不能落回分支那套模板，否则用户看到「分支状态 release-target」。
      expect(record.pausedReason).not.toContain('分支');
      expect(record.incidents).toHaveLength(0);
      expect(record.samples).toHaveLength(0);
    });
  }

  it('命中 CDS_UPTIME_EXCLUDE 的发布目标标为未纳入监控', async () => {
    const probe: ProbeFn = async () => { throw new Error('被排除的目标不该被探测'); };
    const monitor = makeMonitor({
      releaseTargets: [releaseTarget()],
      probe,
      now: () => 1_000,
      config: { excludePatterns: ['tgt-prod'] },
    });
    await monitor.runCycle();
    const record = monitor.getRecord(releaseProbeTargetId(releaseTarget()))!;
    expect(record.excluded).toBe(true);
    expect(record.status).toBe('paused');
    expect(record.pausedReason).toContain('未纳入监控');
  });

  it('CDS_UPTIME_RELEASE_ENABLED=0 时完全不产生发布目标', async () => {
    const monitor = makeMonitor({
      releaseTargets: [releaseTarget()],
      probe: async () => ({ up: true, ms: 5 }),
      now: () => 1_000,
      config: { releaseTargetsEnabled: false },
    });
    await monitor.runCycle();
    expect(monitor.getSummary().targets).toHaveLength(0);
  });
});

describe('URL 型永不降级（假绿防线）', () => {
  it('连续协议层错误也不改判为容器状态', async () => {
    // 事故值：套用分支那条自动降级闸，连续 3 次协议错误后目标被改成
    // 「按容器状态判定」，而生产站点在 CDS 这边没有容器，读到的是 ProbeTarget
    // 上占位的 serviceStatus='enabled' → 恒为 up。生产整站挂掉，状态页全绿。
    let t = 1_000;
    const monitor = makeMonitor({
      releaseTargets: [releaseTarget()],
      // 这条错误文案正是 classifyProbeFailure 判定为 protocol 的那一类
      probe: async () => ({ up: false, ms: 12, err: 'Parse Error: Expected HTTP/' }),
      now: () => (t += 60_000),
      config: { failureThreshold: 3 },
    });
    for (let i = 0; i < 5; i++) await monitor.runCycle();

    const record = monitor.getRecord(releaseProbeTargetId(releaseTarget()))!;
    expect(record.degraded).toBeFalsy();
    expect(record.probeKind).toBe('url');
    expect(record.status).toBe('down');
    expect(record.incidents.some((i) => i.endedAt === null)).toBe(true);
  });

  it('defaultHttpProbe 对 url 型不走容器兜底', async () => {
    // 事故值：url 型 hostPort 恒为 0，落进 `hostPort <= 0` 的退化分支就会拿
    // serviceStatus 当结论 —— 探的是「CDS 以为的目标开关」而不是生产站点本身。
    const target: ProbeTarget = {
      id: 'release@tgt-prod',
      branchId: '',
      projectId: 'proj',
      profileId: 'tgt-prod',
      name: '生产 / 官网',
      hostPort: 0,
      probeKind: 'url',
      url: await unreachableUrl(),
      active: true,
      branchStatus: 'release-target',
      serviceStatus: 'enabled',
      excluded: false,
    };
    const sample = await defaultHttpProbe(target, 1_000);
    expect(sample.up).toBe(false);
    // 结论必须来自真的发过一次 HTTP，而不是读容器状态得来的
    expect(sample.err).toBeTruthy();
    expect(sample.err).not.toContain('容器状态');
  });
});

describe('探测成功后进入正常统计口径', () => {
  it('真实 HTTP 200 → up，24h 可用率与响应时间可算', async () => {
    const server = http.createServer((_req, res) => { res.statusCode = 200; res.end('ok'); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      let t = 1_000;
      const monitor = new UptimeMonitorService({
        state: {
          getAllBranches: () => [],
          getReleaseTargets: () => [releaseTarget({
            ssh: { ...releaseTarget().ssh!, healthcheckUrl: `http://127.0.0.1:${port}/health` },
          })],
        },
        config: testConfig(),
        now: () => (t += 60_000),
      });
      await monitor.runCycle();
      const summary = monitor.getSummary();
      const row = summary.targets.find((r) => r.probeKind === 'url')!;
      expect(row.status).toBe('up');
      expect(row.name).toContain('生产');
      expect(row.probeUrl).toContain(`127.0.0.1:${port}`);
      expect(row.availability24h).toBe(1);
      expect(row.sampleCount24h).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('防再修一边：可探测性只有一份判定', () => {
  const matrix: ReleaseTarget[] = [
    releaseTarget(),
    releaseTarget({ isEnabled: false }),
    releaseTarget({ lifecycle: 'archived' }),
    releaseTarget({ type: 'static-site' }),
    releaseTarget({ ssh: undefined }),
    releaseTarget({ ssh: { ...releaseTarget().ssh!, healthcheckUrl: '' } }),
  ];

  it('releaseProbeSkipReason 为 null ⟺ 可探测且配了地址', () => {
    // 两个函数各自漂移的后果：状态页要么「标了暂停却说不出为什么」，
    // 要么「说了原因却仍在探测」。
    for (const target of matrix) {
      const expected = isReleaseTargetProbeable(target) && releaseProbeUrl(target).length > 0;
      expect(releaseProbeSkipReason(target) === null).toBe(expected);
    }
  });

  it('存活监控的 active 与判定源结论一致', () => {
    for (const target of matrix) {
      const probeTarget = selectReleaseProbeTargets([target])[0]!;
      expect(probeTarget.active).toBe(releaseProbeSkipReason(target) === null);
      if (!probeTarget.active) {
        expect(pausedReasonOf(probeTarget)).toBe(releaseProbeSkipReason(target));
      }
    }
  });

  it('发布中心预检与存活监控对同一目标给出同一个结论', async () => {
    // 这是本 PR 的核心守卫：可探测性判定有两个消费方（预检的「上线地址可访问」
    // 与存活监控的 active）。谁被单独改一边，这条就红。
    // 事故值：只改一边 → 预检说「目标未启用，已跳过健康检查」而状态页还在探，
    // 或反过来状态页把一个正常目标常年标成暂停。
    const { ReleaseService } = await import('../../src/services/release-service.js');

    // 预检真的探了就会拿到连接失败，跳过了就是 warn 文案 —— 用它区分「探没探」，
    // 不依赖外网。
    const deadUrl = await unreachableUrl();

    const runPreflightHealthcheck = async (target: ReleaseTarget): Promise<string> => {
      const plans: unknown[] = [];
      const stateService = {
        getBranch: () => ({
          id: 'proj-main',
          projectId: 'proj',
          branch: 'main',
          status: 'running',
          githubCommitSha: 'a'.repeat(40),
          services: {},
          createdAt: '2026-07-28T00:00:00.000Z',
          worktreePath: '/tmp/wt',
        }),
        getReleaseTarget: () => target,
        getReleasePlans: () => plans,
        upsertReleasePlan: (plan: unknown) => { plans.push(plan); return plan; },
        getProject: () => ({ id: 'proj', slug: 'proj', name: 'proj' }),
        getLatestSuccessfulReleaseRun: () => ({ releaseId: 'rel-old', commitSha: 'b'.repeat(40) }),
        // 磁盘复查（2026-07-30）要翻失败历史；本用例只关心 healthcheck，给空历史即可。
        getReleaseRuns: () => [],
        getRemoteHost: () => ({ id: 'host-prod', sshPrivateKeyFingerprint: 'fp' }),
        // 阶段三起预检结论要落库（消掉「向导跑一次、startRelease 再跑一次」的重复探测）。
        // 本用例只关心 healthcheck 那条 check 的文案，落库存哪儿无所谓，给个空实现即可。
        addReleasePreflight: (record: unknown) => record,
      } as never;
      const service = new ReleaseService(stateService, { sshExecutor: async () => 'cds-release-connect-ok' });
      const result = await service.preflight({
        branchId: 'proj-main',
        targetId: target.id,
        operator: 'tester',
        previewUrl: 'https://preview.example.test',
      });
      return result.checks.find((check) => check.id === 'healthcheck')?.message || '';
    };

    for (const base of [releaseTarget(), releaseTarget({ isEnabled: false }), releaseTarget({ lifecycle: 'archived' })]) {
      const target: ReleaseTarget = { ...base, ssh: { ...base.ssh!, healthcheckUrl: deadUrl } };
      const preflightMessage = await runPreflightHealthcheck(target);
      const preflightProbed = !preflightMessage.includes('跳过');
      const monitorProbes = selectReleaseProbeTargets([target])[0]!.active;
      expect(monitorProbes).toBe(preflightProbed);
    }
  });
});
