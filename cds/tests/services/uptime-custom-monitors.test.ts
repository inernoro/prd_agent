/**
 * 监控中心「自定义监控」回归（2026-09-08 重做）。
 *
 * 守四件事：
 *   1. 输入校验与派生按最小输入原则工作（名称可留空、状态码规则有默认、部分更新不丢字段）；
 *   2. 自定义目标与分支 / 发布目标走同一轮次、同一去抖，但不被分支专用逻辑误伤
 *      （不自动降级、不做发布归因、间隔只能比全局慢）；
 *   3. 「立即探测」与「试探测」走的是与轮次相同的探测实现，不是第二套判定；
 *   4. index.ts 的接线在场——少一行，「添加监控」保存成功但永远不会被探。
 */

import { describe, it, expect, vi } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { BranchEntry, UptimeCustomMonitor } from '../../src/types.js';
import {
  UptimeMonitorService,
  defaultHttpProbe,
  pausedReasonOf,
  probeSourceOfId,
  selectAllProbeTargets,
  selectCustomProbeTargets,
  type ProbeFn,
  type UptimeMonitorConfig,
} from '../../src/services/uptime-monitor.js';
import {
  CUSTOM_PROBE_ID_PREFIX,
  customProbeTargetId,
  describeMonitorProbe,
  normalizeUptimeMonitorInput,
  parseStatusSpec,
  probeCustomMonitor,
  statusMatches,
} from '../../src/services/uptime-custom-monitor.js';
import { MAX_SAMPLES_PER_TARGET } from '../../src/services/uptime-metrics.js';

const MIN = 60_000;
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../');

function monitor(overrides: Partial<UptimeCustomMonitor> = {}): UptimeCustomMonitor {
  return {
    id: 'mon-1',
    name: '上游网关',
    kind: 'http',
    url: 'https://gw.example.test/health',
    method: 'GET',
    expectedStatus: '200-299',
    enabled: true,
    projectId: 'proj',
    createdAt: '2026-09-08T00:00:00.000Z',
    updatedAt: '2026-09-08T00:00:00.000Z',
    ...overrides,
  };
}

function branch(overrides: Partial<BranchEntry> = {}): BranchEntry {
  return {
    id: 'proj-main',
    projectId: 'proj',
    branch: 'main',
    worktreePath: '/tmp/wt',
    status: 'running',
    createdAt: '2026-07-27T00:00:00.000Z',
    lastAccessedAt: '2026-07-27T09:00:00.000Z',
    services: {
      api: { profileId: 'api', containerName: 'cds-proj-main-api', hostPort: 10001, status: 'running' },
    },
    ...overrides,
  } as BranchEntry;
}

function testConfig(overrides: Partial<UptimeMonitorConfig> = {}): UptimeMonitorConfig {
  return {
    enabled: true,
    intervalMs: MIN,
    timeoutMs: 5_000,
    failureThreshold: 3,
    recoveryThreshold: 1,
    maxSamples: MAX_SAMPLES_PER_TARGET,
    excludePatterns: [],
    scope: 'all',
    storePath: '',
    ...overrides,
  };
}

function makeMonitor(opts: {
  monitors: UptimeCustomMonitor[];
  branches?: BranchEntry[];
  probe: ProbeFn;
  now: () => number;
  config?: Partial<UptimeMonitorConfig>;
}): UptimeMonitorService {
  return new UptimeMonitorService({
    state: {
      getAllBranches: () => opts.branches || [],
      getUptimeMonitors: () => opts.monitors,
    },
    config: testConfig(opts.config),
    probe: opts.probe,
    now: opts.now,
  });
}

describe('normalizeUptimeMonitorInput 校验与派生', () => {
  it('http：名称留空按主机名派生，状态码规则缺省 200-399，方法缺省 GET', () => {
    const r = normalizeUptimeMonitorInput({ kind: 'http', url: 'https://api.example.test:8443/ping' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.monitor.name).toBe('api.example.test:8443');
    expect(r.monitor.expectedStatus).toBe('200-399');
    expect(r.monitor.method).toBe('GET');
    expect(r.monitor.enabled).toBe(true);
    expect(r.monitor.id).toMatch(/^mon-/);
  });

  it('http：非 http(s) 地址拒收并指出字段', () => {
    const r = normalizeUptimeMonitorInput({ kind: 'http', url: 'ftp://x.test' });
    expect(r).toMatchObject({ ok: false, field: 'url' });
    expect(normalizeUptimeMonitorInput({ kind: 'http', url: '' })).toMatchObject({ ok: false, field: 'url' });
  });

  it('keyword：必须有关键字，且不能用 HEAD', () => {
    expect(normalizeUptimeMonitorInput({ kind: 'keyword', url: 'https://x.test' })).toMatchObject({ ok: false, field: 'keyword' });
    expect(normalizeUptimeMonitorInput({ kind: 'keyword', url: 'https://x.test', keyword: 'ok', method: 'HEAD' }))
      .toMatchObject({ ok: false, field: 'method' });
    const r = normalizeUptimeMonitorInput({ kind: 'keyword', url: 'https://x.test', keyword: '"status":"ok"' });
    expect(r.ok).toBe(true);
  });

  it('tcp：主机必填、端口 1-65535，名称派生为 host:port', () => {
    expect(normalizeUptimeMonitorInput({ kind: 'tcp', port: 6379 })).toMatchObject({ ok: false, field: 'host' });
    expect(normalizeUptimeMonitorInput({ kind: 'tcp', host: 'redis', port: 70000 })).toMatchObject({ ok: false, field: 'port' });
    const r = normalizeUptimeMonitorInput({ kind: 'tcp', host: 'redis.internal', port: '6379' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.monitor.name).toBe('redis.internal:6379');
    expect(r.monitor.port).toBe(6379);
  });

  it('状态码规则：写法不合法拒收；间隔与超时越界拒收', () => {
    expect(normalizeUptimeMonitorInput({ kind: 'http', url: 'https://x.test', expectedStatus: '2xx' }))
      .toMatchObject({ ok: false, field: 'expectedStatus' });
    expect(normalizeUptimeMonitorInput({ kind: 'http', url: 'https://x.test', intervalSeconds: 5 }))
      .toMatchObject({ ok: false, field: 'intervalSeconds' });
    expect(normalizeUptimeMonitorInput({ kind: 'http', url: 'https://x.test', timeoutMs: 100 }))
      .toMatchObject({ ok: false, field: 'timeoutMs' });
  });

  it('部分更新：只传 enabled=false 时其它字段全部沿用旧值（暂停不能把地址弄丢）', () => {
    const existing = monitor({ intervalSeconds: 120, timeoutMs: 8000, tags: ['核心'] });
    const r = normalizeUptimeMonitorInput({ enabled: false }, { existing });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.monitor).toMatchObject({
      id: 'mon-1',
      name: '上游网关',
      url: existing.url,
      expectedStatus: '200-299',
      intervalSeconds: 120,
      timeoutMs: 8000,
      tags: ['核心'],
      projectId: 'proj',
      enabled: false,
      createdAt: existing.createdAt,
    });
  });

  it('更新时显式传空名 = 要求重新派生', () => {
    const r = normalizeUptimeMonitorInput({ name: '' }, { existing: monitor() });
    expect(r.ok && r.monitor.name).toBe('gw.example.test');
  });

  it('id 非法字符拒收', () => {
    expect(normalizeUptimeMonitorInput({ kind: 'http', url: 'https://x.test', id: 'a b' })).toMatchObject({ ok: false, field: 'id' });
  });
});

describe('状态码规则', () => {
  it('parseStatusSpec 支持单码、区间、混合与中文逗号', () => {
    expect(parseStatusSpec('200-299')).toEqual([[200, 299]]);
    expect(parseStatusSpec('200-399,401，404')).toEqual([[200, 399], [401, 401], [404, 404]]);
    expect(parseStatusSpec('')).toEqual([[200, 399]]);
    expect(parseStatusSpec('300-200')).toBeNull();
    expect(parseStatusSpec('600')).toBeNull();
  });

  it('statusMatches 按规则判定', () => {
    expect(statusMatches(204, '200-299')).toBe(true);
    expect(statusMatches(301, '200-299')).toBe(false);
    expect(statusMatches(401, '200-399,401')).toBe(true);
  });
});

describe('selectCustomProbeTargets 目标推导', () => {
  it('启用的监控 → active 的 custom 目标，id 带 monitor@ 前缀，探测方式按 kind 映射', () => {
    const targets = selectCustomProbeTargets([
      monitor(),
      monitor({ id: 'mon-2', kind: 'keyword', keyword: 'ok' }),
      monitor({ id: 'mon-3', kind: 'tcp', host: 'db', port: 5432, url: undefined }),
    ]);
    expect(targets.map((t) => t.id)).toEqual(['monitor@mon-1', 'monitor@mon-2', 'monitor@mon-3']);
    expect(targets.map((t) => t.probeKind)).toEqual(['url', 'keyword', 'tcp']);
    expect(targets.every((t) => t.source === 'custom' && t.active)).toBe(true);
    expect(targets[0].probeDescription).toBe(describeMonitorProbe(monitor()));
    expect(customProbeTargetId(monitor())).toBe(`${CUSTOM_PROBE_ID_PREFIX}mon-1`);
  });

  it('停用的监控 → paused，原因说明怎么恢复', () => {
    const [t] = selectCustomProbeTargets([monitor({ enabled: false })]);
    expect(t.active).toBe(false);
    expect(pausedReasonOf(t)).toContain('手动暂停');
  });

  it('排除名单对自定义监控同样生效', () => {
    const [t] = selectCustomProbeTargets([monitor()], ['上游*']);
    expect(t.excluded).toBe(true);
    expect(t.active).toBe(false);
  });

  it('间隔只能比全局慢：比全局快的按全局结算', () => {
    const [fast, slow] = selectCustomProbeTargets(
      [monitor({ intervalSeconds: 20 }), monitor({ id: 'mon-2', intervalSeconds: 300 })],
      [],
      { globalIntervalMs: MIN },
    );
    expect(fast.intervalMs).toBe(MIN);
    expect(slow.intervalMs).toBe(300_000);
  });

  it('selectAllProbeTargets 把三类合并，且关闭发布目标探测时自定义目标不受牵连', () => {
    const all = selectAllProbeTargets([branch()], [], [], {
      scope: 'all',
      releaseTargetsEnabled: false,
      customMonitors: [monitor()],
    });
    expect(all.map((t) => t.source)).toEqual(['branch', 'custom']);
  });

  it('probeSourceOfId 按前缀反推来源', () => {
    expect(probeSourceOfId('monitor@mon-1')).toBe('custom');
    expect(probeSourceOfId('release@tgt')).toBe('release');
    expect(probeSourceOfId('proj-main::api')).toBe('branch');
  });
});

describe('探测轮次纳入自定义监控', () => {
  it('自定义目标走同一轮次：连续失败达阈值判 down，摘要带 source / monitorId / 探测方式', async () => {
    let now = 0;
    const probe: ProbeFn = vi.fn(async (target) => {
      expect(target.source).toBe('custom');
      return { up: false, ms: 12, code: 503, err: 'HTTP 503' };
    });
    const svc = makeMonitor({ monitors: [monitor()], probe, now: () => now });
    for (let i = 0; i < 3; i += 1) {
      now += MIN;
      await svc.runCycle();
    }
    const summary = svc.getSummary(10);
    expect(summary.targets).toHaveLength(1);
    expect(summary.targets[0]).toMatchObject({
      id: 'monitor@mon-1',
      source: 'custom',
      status: 'down',
      monitorId: 'mon-1',
      enabled: true,
      intervalSeconds: 60,
      probeDescription: 'GET https://gw.example.test/health · 状态 200-299',
      incidentCount: 1,
    });
    expect(summary.overall.down).toBe(1);
    expect(svc.getIncidents()[0]).toMatchObject({ source: 'custom', targetName: '上游网关', ongoing: true });
  });

  it('自定义目标自己的超时优先于全局', async () => {
    const seen: number[] = [];
    const probe: ProbeFn = async (_t, timeoutMs) => {
      seen.push(timeoutMs);
      return { up: true, ms: 1 };
    };
    const svc = makeMonitor({ monitors: [monitor({ timeoutMs: 9_000 }), monitor({ id: 'mon-2' })], probe, now: () => MIN });
    await svc.runCycle();
    expect(seen.sort()).toEqual([5_000, 9_000]);
  });

  it('间隔闸：180s 的监控在 60s 全局轮次里只每三轮探一次，中间状态原样保留', async () => {
    let now = 0;
    const probe: ProbeFn = vi.fn(async () => ({ up: true, ms: 1 }));
    const svc = makeMonitor({ monitors: [monitor({ intervalSeconds: 180 })], probe, now: () => now });
    for (let i = 1; i <= 6; i += 1) {
      now = i * MIN;
      await svc.runCycle();
    }
    // 第 1 轮（首探）、第 4 轮（180s 后）：两次。第 7 轮才会是第三次。
    expect(probe).toHaveBeenCalledTimes(2);
    expect(svc.getSummary(10).targets[0].status).toBe('up');
    expect(svc.getSummary(10).targets[0].intervalSeconds).toBe(180);
  });

  it('自定义目标永不自动降级：连续协议层错误照常判 down', async () => {
    let now = 0;
    const probe: ProbeFn = async () => ({ up: false, ms: 0, err: 'socket hang up' });
    const svc = makeMonitor({ monitors: [monitor()], probe, now: () => now });
    for (let i = 0; i < 4; i += 1) {
      now += MIN;
      await svc.runCycle();
    }
    const record = svc.getRecord('monitor@mon-1');
    expect(record?.degraded).toBeFalsy();
    expect(record?.status).toBe('down');
  });

  it('停用后：不再探测，已开的故障就地收尾，状态变 paused', async () => {
    let now = 0;
    const monitors = [monitor()];
    const probe: ProbeFn = vi.fn(async () => ({ up: false, ms: 0, err: 'HTTP 500' }));
    const svc = makeMonitor({ monitors, probe, now: () => now });
    for (let i = 0; i < 3; i += 1) {
      now += MIN;
      await svc.runCycle();
    }
    expect(svc.getRecord('monitor@mon-1')?.status).toBe('down');
    monitors[0] = monitor({ enabled: false });
    now += MIN;
    await svc.runCycle();
    expect(probe).toHaveBeenCalledTimes(3);
    const summary = svc.getSummary(10).targets[0];
    expect(summary.status).toBe('paused');
    expect(summary.enabled).toBe(false);
    expect(summary.openIncidentSince).toBeNull();
    expect(svc.getIncidents()[0].ongoing).toBe(false);
  });

  it('删除定义后台账在下一轮被清理', async () => {
    const monitors = [monitor()];
    const svc = makeMonitor({ monitors, probe: async () => ({ up: true, ms: 1 }), now: () => MIN });
    await svc.runCycle();
    expect(svc.getRecord('monitor@mon-1')).toBeDefined();
    monitors.length = 0;
    await svc.runCycle();
    expect(svc.getRecord('monitor@mon-1')).toBeUndefined();
  });

  it('改名 / 改地址立刻反映到台账（不用等删掉重建）', async () => {
    const monitors = [monitor()];
    const svc = makeMonitor({ monitors, probe: async () => ({ up: true, ms: 1 }), now: () => MIN });
    await svc.runCycle();
    monitors[0] = monitor({ name: '网关（新）', url: 'https://gw2.example.test/health' });
    await svc.runCycle();
    const t = svc.getSummary(10).targets[0];
    expect(t.name).toBe('网关（新）');
    expect(t.probeUrl).toBe('https://gw2.example.test/health');
    expect(t.probeDescription).toContain('gw2.example.test');
  });
});

describe('probeNow 立即探测', () => {
  it('对存在且活跃的目标探一次并记入台账，返回采样与判定后的状态', async () => {
    let now = MIN;
    const probe: ProbeFn = vi.fn(async () => ({ up: true, ms: 33, code: 200 }));
    const svc = makeMonitor({ monitors: [monitor()], branches: [branch()], probe, now: () => now });
    const result = await svc.probeNow('monitor@mon-1');
    expect(result).toMatchObject({ ok: true, status: 'up', sample: { up: true, ms: 33 } });
    expect(probe).toHaveBeenCalledTimes(1);
    expect(svc.getRecord('monitor@mon-1')?.samples).toHaveLength(1);
    // 分支目标同样可以立即探
    now += 1;
    const branchResult = await svc.probeNow('proj-main::api');
    expect(branchResult).toMatchObject({ ok: true });
  });

  it('目标不存在 → null；停用的目标 → skipped 并给原因，且台账立刻标 paused（不用等下一轮）', async () => {
    const svc = makeMonitor({ monitors: [monitor({ enabled: false })], probe: async () => ({ up: true, ms: 1 }), now: () => MIN });
    expect(await svc.probeNow('monitor@nope')).toBeNull();
    const r = await svc.probeNow('monitor@mon-1');
    expect(r).toMatchObject({ ok: false });
    expect(r && !r.ok ? r.skipped : '').toContain('手动暂停');
    expect(svc.getSummary(10).targets[0]).toMatchObject({ id: 'monitor@mon-1', status: 'paused' });
  });

  it('forgetTarget 立刻抹掉台账，删除后状态页不再挂着它', async () => {
    const svc = makeMonitor({ monitors: [monitor()], probe: async () => ({ up: true, ms: 1 }), now: () => MIN });
    await svc.probeNow('monitor@mon-1');
    expect(svc.forgetTarget('monitor@mon-1')).toBe(true);
    expect(svc.getSummary(10).targets).toHaveLength(0);
    expect(svc.forgetTarget('monitor@mon-1')).toBe(false);
  });

  it('立即探测与轮次共用去抖：单次失败不会直接判 down', async () => {
    const svc = makeMonitor({ monitors: [monitor()], probe: async () => ({ up: false, ms: 1, err: 'HTTP 500' }), now: () => MIN });
    const r = await svc.probeNow('monitor@mon-1');
    expect(r).toMatchObject({ ok: true, status: 'unknown' });
  });
});

describe('probeCustomMonitor 真实探测', () => {
  async function serve(handler: http.RequestListener): Promise<{ url: string; close: () => Promise<void> }> {
    const server = http.createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    return {
      url: `http://127.0.0.1:${port}`,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  it('http：状态码在规则内即 up，不在规则内即 down 并写明原因', async () => {
    const srv = await serve((req, res) => {
      res.statusCode = req.url === '/ok' ? 200 : 503;
      res.end('hello');
    });
    try {
      const ok = await probeCustomMonitor({ kind: 'http', url: `${srv.url}/ok`, expectedStatus: '200-299' }, 2000);
      expect(ok).toMatchObject({ up: true, code: 200 });
      const bad = await probeCustomMonitor({ kind: 'http', url: `${srv.url}/bad`, expectedStatus: '200-299' }, 2000);
      expect(bad).toMatchObject({ up: false, code: 503 });
      expect(bad.err).toContain('503');
      // 用户明确说 503 也算活（维护页），就按用户说的
      const lenient = await probeCustomMonitor({ kind: 'http', url: `${srv.url}/bad`, expectedStatus: '200-299,503' }, 2000);
      expect(lenient.up).toBe(true);
    } finally {
      await srv.close();
    }
  });

  it('keyword：响应体含关键字才 up', async () => {
    const srv = await serve((_req, res) => { res.end('{"status":"ok","db":"connected"}'); });
    try {
      const hit = await probeCustomMonitor({ kind: 'keyword', url: srv.url, keyword: '"db":"connected"' }, 2000);
      expect(hit.up).toBe(true);
      const miss = await probeCustomMonitor({ kind: 'keyword', url: srv.url, keyword: 'degraded' }, 2000);
      expect(miss.up).toBe(false);
      expect(miss.err).toContain('degraded');
    } finally {
      await srv.close();
    }
  });

  it('http：连不上 → down，错误原文保留', async () => {
    const srv = await serve((_req, res) => res.end());
    const url = srv.url;
    await srv.close();
    const r = await probeCustomMonitor({ kind: 'http', url }, 2000);
    expect(r.up).toBe(false);
    expect(r.err).toBeTruthy();
  });

  it('tcp：端口开着 → up；没人听 → down', async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      expect((await probeCustomMonitor({ kind: 'tcp', host: '127.0.0.1', port }, 2000)).up).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    const closed = await probeCustomMonitor({ kind: 'tcp', host: '127.0.0.1', port }, 2000);
    expect(closed.up).toBe(false);
    expect(closed.err).toBeTruthy();
  });

  it('defaultHttpProbe 对 custom 目标分派到自定义实现（不走 < 500 即存活的分支口径）', async () => {
    const srv = await serve((_req, res) => { res.statusCode = 404; res.end(); });
    try {
      const [target] = selectCustomProbeTargets([monitor({ url: srv.url, expectedStatus: '200-299' })]);
      const r = await defaultHttpProbe(target, 2000);
      // 分支口径下 404 算存活；自定义规则 200-299 下必须判失败。
      expect(r).toMatchObject({ up: false, code: 404 });
    } finally {
      await srv.close();
    }
  });
});

describe('接线守卫：index.ts 必须把自定义监控接进探测器与路由', () => {
  const indexSource = fs.readFileSync(path.join(REPO, 'src/index.ts'), 'utf8');
  const serverSource = fs.readFileSync(path.join(REPO, 'src/server.ts'), 'utf8');

  it('探测器读到 stateService.listUptimeMonitors', () => {
    expect(indexSource).toContain('getUptimeMonitors: () => stateService.listUptimeMonitors()');
  });

  it('路由拿到写入面（store），否则所有写接口都是 503', () => {
    const window = indexSource.slice(indexSource.indexOf('createUptimeRouter({'));
    expect(window).toContain('upsertUptimeMonitor');
    expect(window).toContain('removeUptimeMonitor');
  });

  it('每条新路由都有 Activity Monitor 中文标签', () => {
    for (const label of ['列出自定义监控', '新增自定义监控', '试探自定义监控', '修改自定义监控', '删除自定义监控', '立即探测目标']) {
      expect(serverSource).toContain(label);
    }
  });
});
