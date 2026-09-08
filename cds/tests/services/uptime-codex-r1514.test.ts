/**
 * Codex PR #1514 首轮八条（监控中心重做）回归。
 *
 * 每条对应一个真实缺陷，用行为断言钉死：
 *   P1 自定义监控只给管理员：项目级 Key 写 / 试探一律 403（借 CDS 主机扫内网）；
 *   P1 立即探测折用户视角：进程在答、预览域名 5xx 时点「立即探测」不能翻绿；
 *   P1 项目级摘要的覆盖面只给本项目：未纳入清单不能枚举别的项目；
 *   P2 代理豁免只认进程级令牌：伪造 x-cds-poll 照常算访问；
 *   P2 立即探测的归属从当前目标定义解析：刚保存没进轮次的目标也拦；
 *   P2 编辑弹窗清空高级字段 = 重置（null），不是「沿用旧值」；
 *   P2 项目级摘要的总览计数与全量同一口径（未实测不算正常）；
 *   P2 详情页「重试」真的重发请求。
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { BranchEntry, UptimeCustomMonitor } from '../../src/types.js';
import {
  UptimeMonitorService,
  defaultHttpProbe,
  defaultUserViewProbe,
  selectCustomProbeTargets,
  selectProbeTargets,
  tallyTargetSummaries,
  type ProbeFn,
  type UptimeMonitorConfig,
  type UserViewProbeFn,
} from '../../src/services/uptime-monitor.js';
import { normalizeUptimeMonitorInput, probeCustomMonitor } from '../../src/services/uptime-custom-monitor.js';
import { StateService } from '../../src/services/state.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';
import { PROBE_MARKER_HEADER, isTrustedProbeRequest, probeRequestHeaders, stripProbeMarker } from '../../src/services/probe-marker.js';
import { createUptimeRouter, type UptimeMonitorStore } from '../../src/routes/uptime.js';
import { MAX_SAMPLES_PER_TARGET } from '../../src/services/uptime-metrics.js';

const MIN = 60_000;
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../');

function branch(overrides: Partial<BranchEntry> = {}): BranchEntry {
  return {
    id: 'proj-main', projectId: 'proj', branch: 'main', worktreePath: '/tmp/wt', status: 'running',
    createdAt: '2026-07-27T00:00:00.000Z', lastAccessedAt: '2026-09-08T09:00:00.000Z',
    services: { api: { profileId: 'api', containerName: 'c-api', hostPort: 10001, status: 'running' } },
    ...overrides,
  } as BranchEntry;
}

function customMonitor(overrides: Partial<UptimeCustomMonitor> = {}): UptimeCustomMonitor {
  return {
    id: 'mon-1', name: '上游网关', kind: 'http', url: 'https://gw.example.test/health', method: 'GET',
    expectedStatus: '200-299', enabled: true, projectId: 'proj',
    createdAt: '2026-09-08T00:00:00.000Z', updatedAt: '2026-09-08T00:00:00.000Z', ...overrides,
  };
}

function makeMonitor(opts: {
  branches?: BranchEntry[];
  monitors?: UptimeCustomMonitor[];
  probe?: ProbeFn;
  userViewProbe?: UserViewProbeFn;
  now: () => number;
  config?: Partial<UptimeMonitorConfig>;
}): UptimeMonitorService {
  return new UptimeMonitorService({
    state: {
      getAllBranches: () => opts.branches || [],
      getReleaseTargets: () => [],
      getUptimeMonitors: () => opts.monitors || [],
      getProject: (id) => ({ id, name: id === 'proj' ? 'MAP 平台' : '另一个项目' } as never),
      getPreviewUrl: (b) => `https://${b.id}.preview.test`,
    },
    config: {
      enabled: true, intervalMs: MIN, timeoutMs: 5_000, failureThreshold: 3, recoveryThreshold: 1,
      maxSamples: MAX_SAMPLES_PER_TARGET, excludePatterns: [], scope: 'all', storePath: '', userViewEnabled: true,
      ...opts.config,
    },
    probe: opts.probe || (async () => ({ up: true, ms: 10, code: 200 })),
    userViewProbe: opts.userViewProbe,
    now: opts.now,
  });
}

/** 起一个真 express，可选给请求盖上项目级 Key 的戳（模拟 server.ts 的全局门）。 */
async function serve(monitor: UptimeMonitorService, store?: UptimeMonitorStore): Promise<{
  call: (method: string, url: string, opts?: { scope?: string; body?: unknown }) => Promise<{ status: number; json: any }>;
  close: () => Promise<void>;
}> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const scope = req.headers['x-test-scope'];
    if (typeof scope === 'string' && scope) (req as { cdsProjectKey?: unknown }).cdsProjectKey = { projectId: scope };
    next();
  });
  app.use('/api', createUptimeRouter({ monitor, store }));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    call: async (method, url, opts = {}) => {
      const res = await fetch(`http://127.0.0.1:${port}${url}`, {
        method,
        headers: { 'content-type': 'application/json', ...(opts.scope ? { 'x-test-scope': opts.scope } : {}) },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      });
      return { status: res.status, json: await res.json().catch(() => null) };
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function memoryStore(initial: UptimeCustomMonitor[] = []): UptimeMonitorStore & { rows: Map<string, UptimeCustomMonitor> } {
  const rows = new Map(initial.map((m) => [m.id, m]));
  return {
    rows,
    listUptimeMonitors: (projectId) => [...rows.values()].filter((m) => !projectId || m.projectId === projectId),
    getUptimeMonitor: (id) => rows.get(id),
    upsertUptimeMonitor: (m) => { rows.set(m.id, m); return m; },
    removeUptimeMonitor: (id) => rows.delete(id),
  };
}

describe('P2 代理豁免只认进程级探测令牌', () => {
  it('探测头里带令牌且能被识别；只带公开的 x-cds-poll 头不算可信探测', () => {
    const headers = probeRequestHeaders();
    expect(headers['x-cds-poll']).toBe('true');
    expect(headers[PROBE_MARKER_HEADER]).toMatch(/^[0-9a-f]{48}$/);
    expect(isTrustedProbeRequest(headers)).toBe(true);
    expect(isTrustedProbeRequest({ 'x-cds-poll': 'true' })).toBe(false);
    expect(isTrustedProbeRequest({ [PROBE_MARKER_HEADER]: 'guess' })).toBe(false);
    expect(isTrustedProbeRequest(undefined)).toBe(false);
  });

  it('转发前抹掉令牌，分支容器里拿不到它', () => {
    const headers: Record<string, unknown> = { ...probeRequestHeaders(), host: 'x' };
    stripProbeMarker(headers);
    expect(headers).toEqual({ 'x-cds-poll': 'true', host: 'x' });
  });

  it('defaultUserViewProbe 发出的请求在服务端被判为可信探测', async () => {
    let trusted = false;
    const server = http.createServer((req, res) => { trusted = isTrustedProbeRequest(req.headers); res.statusCode = 200; res.end('ok'); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      await defaultUserViewProbe(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`, 2000);
      expect(trusted).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('proxy.ts 用 isTrustedProbeRequest 决定 touch / trackAccess，不再读 x-cds-poll', () => {
    const src = fs.readFileSync(path.join(REPO, 'src/services/proxy.ts'), 'utf8');
    expect(src).toContain('const isProbeRequest = isTrustedProbeRequest(req.headers);');
    expect(src).toContain('stripProbeMarker(req.headers);');
    expect(src).toMatch(/if \(this\.scheduler && !isProbeRequest\)/);
    expect(src).toContain('trackAccess: !isProbeRequest');
    expect(src).not.toMatch(/isPollRequest = String\(req\.headers\['x-cds-poll'\]/);
  });
});

describe('P1 立即探测折入用户视角', () => {
  it('进程在答、预览域名 5xx：轮次判故障后点「立即探测」仍是 down，故障不收尾', async () => {
    let now = 0;
    const userViewProbe = vi.fn(async () => ({ up: false, ms: 20, code: 502, err: '用户视角 HTTP 502' }));
    const svc = makeMonitor({ branches: [branch()], userViewProbe, now: () => now });
    for (let i = 0; i < 3; i += 1) { now += MIN; await svc.runCycle(); }
    expect(svc.getSummary(10).targets[0].status).toBe('down');
    now += 1000;
    const r = await svc.probeNow('proj-main::api');
    expect(r).toMatchObject({ ok: true, status: 'down' });
    expect(userViewProbe).toHaveBeenCalledTimes(4);
    const t = svc.getSummary(10).targets[0];
    expect(t.openIncidentSince).not.toBeNull();
    expect(t.userView).toMatchObject({ status: 'down' });
    expect(t.lastSample?.err).toContain('用户视角');
  });

  it('探测器够不着预览域名（unreachable）：立即探测不折，进程视角说了算', async () => {
    const svc = makeMonitor({
      branches: [branch()],
      userViewProbe: async () => ({ up: false, ms: 0, err: 'ENOTFOUND', unreachable: true }),
      now: () => MIN,
    });
    const r = await svc.probeNow('proj-main::api');
    expect(r).toMatchObject({ ok: true, status: 'up' });
    expect(svc.getSummary(10).targets[0].userView).toMatchObject({ status: 'unknown', unreachable: true });
  });
});

describe('P2 总览计数单一口径', () => {
  it('tallyTargetSummaries：未实测不算正常、排除与暂停分开计', () => {
    const tally = tallyTargetSummaries([
      { status: 'up', excluded: false, measured: true },
      { status: 'up', excluded: false, measured: false },
      { status: 'down', excluded: false, measured: false },
      { status: 'paused', excluded: false, measured: true },
      { status: 'unknown', excluded: true, measured: true },
      { status: 'unknown', excluded: false, measured: true },
    ]);
    expect(tally).toEqual({ total: 6, up: 1, unmeasured: 1, down: 1, paused: 1, excluded: 1, unknown: 1, ok: false });
  });
});

describe('项目级 Key 看摘要与单目标', () => {
  const twoProjects = () => [
    branch({ services: {
      api: { profileId: 'api', containerName: 'c', hostPort: 10001, status: 'running' },
      worker: { profileId: 'worker', containerName: 'w', hostPort: 0, status: 'running' },
    } as never }),
    branch({ id: 'other-main', projectId: 'other', branch: 'main', executorId: 'exec-remote-1' } as never),
  ];

  it('P2 项目级摘要的 overall 含 unmeasured，与全量同口径', async () => {
    const svc = makeMonitor({ branches: twoProjects(), userViewProbe: async () => ({ up: true, ms: 1 }), now: () => MIN });
    await svc.runCycle();
    const app = await serve(svc);
    try {
      const scoped = await app.call('GET', '/api/uptime/summary?segments=10', { scope: 'proj' });
      expect(scoped.status).toBe(200);
      expect(scoped.json.projectScope).toBe('proj');
      expect(scoped.json.targets.map((t: { id: string }) => t.id).sort()).toEqual(['proj-main::api', 'proj-main::worker']);
      expect(scoped.json.overall).toMatchObject({ total: 2, up: 1, unmeasured: 1, down: 0 });
    } finally {
      await app.close();
    }
  });

  it('P1 项目级摘要的 coverage 只含本项目：别的项目的远端分支不出现在未纳入清单里', async () => {
    const svc = makeMonitor({ branches: twoProjects(), userViewProbe: async () => ({ up: true, ms: 1 }), now: () => MIN });
    await svc.runCycle();
    const app = await serve(svc);
    try {
      const full = await app.call('GET', '/api/uptime/summary?segments=10');
      expect(full.json.coverage.uncovered.map((u: { projectId: string }) => u.projectId)).toEqual(['other']);
      const scoped = await app.call('GET', '/api/uptime/summary?segments=10', { scope: 'proj' });
      expect(scoped.json.coverage).toMatchObject({ total: 2, covered: 2, uncovered: [], byReason: [] });
      const other = await app.call('GET', '/api/uptime/summary?segments=10', { scope: 'other' });
      expect(other.json.coverage.total).toBe(1);
      expect(other.json.coverage.uncovered.map((u: { id: string }) => u.id)).toEqual(['other-main::api']);
    } finally {
      await app.close();
    }
  });

  it('P2 立即探测：归属从当前目标定义解析——还没进过轮次的别人目标也 403，不存在的同样 403（不给枚举）', async () => {
    const svc = makeMonitor({ branches: twoProjects(), userViewProbe: async () => ({ up: true, ms: 1 }), now: () => MIN });
    expect(svc.getRecord('other-main::api')).toBeUndefined();
    expect(svc.getTargetProjectId('other-main::api')).toBe('other');
    expect(svc.getTargetProjectId('nope::x')).toBeUndefined();
    const app = await serve(svc);
    try {
      expect((await app.call('POST', '/api/uptime/targets/other-main::api/probe', { scope: 'proj' })).status).toBe(403);
      expect((await app.call('POST', '/api/uptime/targets/nope::x/probe', { scope: 'proj' })).status).toBe(403);
      expect((await app.call('GET', '/api/uptime/targets/other-main::api/history', { scope: 'proj' })).status).toBe(403);
      const own = await app.call('POST', '/api/uptime/targets/proj-main::api/probe', { scope: 'proj' });
      expect(own.status).toBe(200);
      expect(own.json).toMatchObject({ ok: true, status: 'up' });
      // 管理员身份不受限，不存在的目标才是 404
      expect((await app.call('POST', '/api/uptime/targets/nope::x/probe')).status).toBe(404);
    } finally {
      await app.close();
    }
  });
});

describe('P1 自定义监控只给管理员身份', () => {
  it('项目级 Key 的新增 / 修改 / 删除 / 试探一律 403，且不会连出去；管理员照常', async () => {
    const store = memoryStore([customMonitor()]);
    const svc = makeMonitor({ monitors: [...store.rows.values()], now: () => MIN });
    const app = await serve(svc, store);
    const body = { kind: 'http', url: 'http://127.0.0.1:1/', projectId: 'proj' };
    try {
      for (const [method, url] of [
        ['POST', '/api/uptime/monitors'],
        ['POST', '/api/uptime/monitors/test'],
        ['PUT', '/api/uptime/monitors/mon-1'],
        ['DELETE', '/api/uptime/monitors/mon-1'],
      ] as const) {
        const r = await app.call(method, url, { scope: 'proj', body });
        expect(r.status, `${method} ${url}`).toBe(403);
        expect(r.json.error).toContain('管理员');
      }
      expect(store.rows.has('mon-1')).toBe(true);
      // 只读仍然开放：项目级 Key 能列自己项目下的自定义监控
      const list = await app.call('GET', '/api/uptime/monitors', { scope: 'proj' });
      expect(list.status).toBe(200);
      expect(list.json.monitors.map((m: { id: string }) => m.id)).toEqual(['mon-1']);
      // 管理员（无项目戳）可写
      const created = await app.call('POST', '/api/uptime/monitors', { body: { kind: 'tcp', host: '127.0.0.1', port: 9 } });
      expect(created.status).toBe(201);
      expect(store.rows.size).toBe(2);
    } finally {
      await app.close();
    }
  });
});

describe('P2 编辑时清空高级字段 = 重置', () => {
  it('expectedStatus / intervalSeconds / timeoutMs 传 null 回到默认；不传才沿用旧值', () => {
    const existing = customMonitor({ expectedStatus: '200-204', intervalSeconds: 300, timeoutMs: 8000 });
    const kept = normalizeUptimeMonitorInput({ enabled: false }, { existing });
    expect(kept.ok && kept.monitor).toMatchObject({ expectedStatus: '200-204', intervalSeconds: 300, timeoutMs: 8000 });
    const reset = normalizeUptimeMonitorInput({ expectedStatus: null, intervalSeconds: null, timeoutMs: null }, { existing });
    expect(reset.ok).toBe(true);
    if (!reset.ok) return;
    expect(reset.monitor.expectedStatus).toBe('200-399');
    expect(reset.monitor.intervalSeconds).toBeUndefined();
    expect(reset.monitor.timeoutMs).toBeUndefined();
  });

  it('编辑弹窗把清空的高级输入框发成 null，而不是不传', () => {
    const src = fs.readFileSync(path.join(REPO, 'web/src/pages/status/MonitorEditorDialog.tsx'), 'utf8');
    expect(src).toContain("body.expectedStatus = draft.expectedStatus.trim() || null;");
    expect(src).toContain("body.intervalSeconds = draft.intervalSeconds.trim() || null;");
    expect(src).toContain("body.timeoutMs = draft.timeoutMs.trim() || null;");
    expect(src).not.toMatch(/if \(draft\.intervalSeconds\.trim\(\)\) body\.intervalSeconds/);
  });
});

describe('P2 详情页「重试」真的重发', () => {
  it('重试递增 reloadToken 并进 useHistory 的依赖；不再把 range 原样 set 回去', () => {
    const src = fs.readFileSync(path.join(REPO, 'web/src/pages/status/TargetDetail.tsx'), 'utf8');
    expect(src).toContain('setReloadToken((n) => n + 1)');
    expect(src).toMatch(/\[targetId, range, generatedAt, reloadToken\]\)/);
    expect(src).not.toContain('setRange((r) => r)');
  });
});

describe('第二轮 P2 探测令牌只随用户视角发出', () => {
  async function capture(): Promise<{ port: number; seen: () => Record<string, unknown>; close: () => Promise<void> }> {
    let headers: Record<string, unknown> = {};
    const server = http.createServer((req, res) => { headers = { ...req.headers }; res.statusCode = 200; res.end('ok'); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
      port: (server.address() as AddressInfo).port,
      seen: () => headers,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  it('直连分支容器的进程视角探测：带 x-cds-poll、不带令牌（容器里的代码看得到请求头）', async () => {
    const srv = await capture();
    try {
      const [target] = selectProbeTargets([branch({ services: { api: { profileId: 'api', containerName: 'c', hostPort: srv.port, status: 'running' } } as never })]);
      const r = await defaultHttpProbe(target, 2000);
      expect(r.up).toBe(true);
      expect(srv.seen()['x-cds-poll']).toBe('true');
      expect(srv.seen()[PROBE_MARKER_HEADER]).toBeUndefined();
      expect(isTrustedProbeRequest(srv.seen())).toBe(false);
    } finally {
      await srv.close();
    }
  });

  it('自定义 HTTP 探测打任意外部地址：同样不带令牌', async () => {
    const srv = await capture();
    try {
      const [target] = selectCustomProbeTargets([customMonitor({ url: `http://127.0.0.1:${srv.port}/`, expectedStatus: '200-299' })]);
      await probeCustomMonitor(target.monitor!, 2000);
      expect(srv.seen()['x-cds-poll']).toBe('true');
      expect(srv.seen()[PROBE_MARKER_HEADER]).toBeUndefined();
    } finally {
      await srv.close();
    }
  });

  it('源码守卫：probeRequestHeaders 只在 defaultUserViewProbe 里被展开', () => {
    const monitorSrc = fs.readFileSync(path.join(REPO, 'src/services/uptime-monitor.ts'), 'utf8');
    const customSrc = fs.readFileSync(path.join(REPO, 'src/services/uptime-custom-monitor.ts'), 'utf8');
    expect(monitorSrc.match(/probeRequestHeaders\(\)/g)).toHaveLength(1);
    const userView = monitorSrc.slice(monitorSrc.indexOf('export const defaultUserViewProbe'), monitorSrc.indexOf('export const defaultUserViewProbe') + 1200);
    expect(userView).toContain('...probeRequestHeaders()');
    expect(customSrc).not.toContain('probeRequestHeaders');
  });
});

describe('第二轮 P2 管理员可以改归属项目', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await flushAllJsonStateStores();
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it('同一 id 从系统级挪到项目、再挪到另一个项目，都能保存且不抛冲突', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-uptime-r1514-'));
    dirs.push(dir);
    const state = new StateService(path.join(dir, 'state.json'));
    state.load();
    const base = customMonitor({ id: 'mon-move', projectId: null });
    expect(state.upsertUptimeMonitor(base).projectId).toBeNull();
    expect(state.upsertUptimeMonitor({ ...base, projectId: 'proj' }).projectId).toBe('proj');
    expect(state.upsertUptimeMonitor({ ...base, projectId: 'other' }).projectId).toBe('other');
    expect(state.getUptimeMonitor('mon-move')?.projectId).toBe('other');
    expect(state.listUptimeMonitors('proj')).toHaveLength(0);
    expect(state.listUptimeMonitors('other').map((m) => m.id)).toEqual(['mon-move']);
  });

  it('路由：管理员 PUT 换 projectId 得到 200 且落库', async () => {
    const store = memoryStore([customMonitor({ projectId: 'proj' })]);
    const svc = makeMonitor({ monitors: [...store.rows.values()], now: () => MIN });
    const app = await serve(svc, store);
    try {
      const r = await app.call('PUT', '/api/uptime/monitors/mon-1', { body: { projectId: 'other' } });
      expect(r.status).toBe(200);
      expect(r.json.monitor.projectId).toBe('other');
      expect(store.rows.get('mon-1')?.projectId).toBe('other');
      const cleared = await app.call('PUT', '/api/uptime/monitors/mon-1', { body: { projectId: null } });
      expect(cleared.status).toBe(200);
      expect(cleared.json.monitor.projectId).toBeNull();
    } finally {
      await app.close();
    }
  });
});

describe('第三轮 P1 自定义目标单独通道', () => {
  it('一个挂住的自定义地址不阻塞下一轮分支探测；自定义目标那一轮跳过，解挂后照常', async () => {
    let now = MIN;
    let release: () => void = () => undefined;
    const hang = new Promise<{ up: boolean; ms: number }>((resolve) => { release = () => resolve({ up: true, ms: 1 }); });
    const probe: ProbeFn = vi.fn(async (target) => (target.source === 'custom' ? hang : { up: true, ms: 5, code: 200 }));
    const svc = makeMonitor({ branches: [branch()], monitors: [customMonitor()], probe, userViewProbe: async () => ({ up: true, ms: 1 }), now: () => now });
    const first = svc.runCycle();
    // 主通道已结束（分支拿到第一份采样），自定义通道还挂着。
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(svc.getRecord('proj-main::api')?.samples).toHaveLength(1);
    expect(svc.getRecord('monitor@mon-1')?.samples ?? []).toHaveLength(0);
    now += MIN;
    await svc.runCycle();
    expect(svc.getRecord('proj-main::api')?.samples).toHaveLength(2);
    expect(svc.getRecord('monitor@mon-1')?.samples ?? []).toHaveLength(0);
    release();
    await first;
    expect(svc.getRecord('monitor@mon-1')?.samples).toHaveLength(1);
    now += MIN;
    await svc.runCycle();
    expect(svc.getRecord('monitor@mon-1')?.samples).toHaveLength(2);
    expect(svc.getRecord('proj-main::api')?.samples).toHaveLength(3);
  });
});

describe('第三轮 P2 forwarder 数据面抹探测令牌', () => {
  it('两条转发路径（HTTP / Upgrade）复制请求头后都删掉令牌', () => {
    const src = fs.readFileSync(path.join(REPO, 'src/forwarder/proxy-handler.ts'), 'utf8');
    expect(src).toContain("import { PROBE_MARKER_HEADER } from '../services/probe-marker.js';");
    expect(src.match(/delete fwdHeaders\[PROBE_MARKER_HEADER\]/g)).toHaveLength(2);
  });
});

describe('第三轮 P2 改归属项目后台账立刻同步', () => {
  it('refreshTarget：PUT 换 projectId 后，不等下一轮，摘要与项目级作用域都按新归属', async () => {
    const store = memoryStore([customMonitor({ projectId: 'proj' })]);
    const svc = new UptimeMonitorService({
      state: {
        getAllBranches: () => [],
        getReleaseTargets: () => [],
        getUptimeMonitors: () => [...store.rows.values()],
        getProject: (id) => ({ id, name: id } as never),
      },
      config: {
        enabled: true, intervalMs: MIN, timeoutMs: 5_000, failureThreshold: 3, recoveryThreshold: 1,
        maxSamples: MAX_SAMPLES_PER_TARGET, excludePatterns: [], scope: 'all', storePath: '', userViewEnabled: true,
      },
      probe: async () => ({ up: true, ms: 10, code: 200 }),
      now: () => MIN,
    });
    await svc.runCycle();
    expect(svc.getTargetProjectId('monitor@mon-1')).toBe('proj');
    const app = await serve(svc, store);
    try {
      const r = await app.call('PUT', '/api/uptime/monitors/mon-1', { body: { projectId: 'other' } });
      expect(r.status).toBe(200);
      expect(svc.getRecord('monitor@mon-1')?.projectId).toBe('other');
      expect(svc.getSummary(10).targets[0].projectId).toBe('other');
      const old = await app.call('GET', '/api/uptime/summary?segments=10', { scope: 'proj' });
      expect(old.json.targets).toHaveLength(0);
      const fresh = await app.call('GET', '/api/uptime/summary?segments=10', { scope: 'other' });
      expect(fresh.json.targets.map((t: { id: string }) => t.id)).toEqual(['monitor@mon-1']);
      expect((await app.call('POST', '/api/uptime/targets/monitor@mon-1/probe', { scope: 'proj' })).status).toBe(403);
    } finally {
      await app.close();
    }
  });
});
