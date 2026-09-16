/*
 * 守卫：CDS 用监控自发现协议监控自己。
 *
 * 用户 2026-09-16：「先加上自己的吧，以代码初始化的方式来驱动，方便 CDS 迁移部署在
 * 其他服务器上。比如自己的部署、构建、页面打开时间什么的，找几个用户最在意的分类。」
 *
 * 四组用例，各自盯一种会静默坏掉的方式：
 *   1. 协议一致性 —— 自检端点的输出必须能被 CDS 自己的解析器一条不落地读进来。
 *      这是唯一能证明「协议作者自己吃得下自己协议」的判据；扫源码字面量证明不了。
 *   2. 量不到就说量不到 —— 磁盘读不到写 null 不写 0，Docker 打不通写哨兵值不写 0，
 *      探测器一轮没跑写哨兵值不写 0。三处任何一处缺省成 0 都会被读成「一切正常」。
 *   3. 引导幂等 —— 多跑不多建；删了项目再跑会回来。
 *   4. 接线 —— index.ts 真挂了路由、真在发现之前引导；两处免登录白名单都放行了它；
 *      拔掉内置端点被拒。删掉任何一根线，其它测试都不会红。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { discoverMonitors } from '../../src/services/monitor-discovery.js';
import {
  buildSelfCheck,
  DOCKER_UNREACHABLE_MS,
  DOCKER_PING_MAX_MS,
  PROBER_STALE_AFTER_SECONDS,
  PROBER_STALLED_SECONDS,
  SELF_STATUS_GRACE_MS,
  SELF_CHECK_PATH,
  type SelfCheckDeps,
} from '../../src/services/self-check.js';
import {
  ensureSelfMonitoring,
  isSelfCheckEndpoint,
  SELF_PROJECT_ID,
  selfCheckUrl,
  type SelfMonitoringState,
} from '../../src/services/self-monitoring-bootstrap.js';
import type { Project } from '../../src/types.js';

const NOW = Date.parse('2026-09-16T10:00:00Z');
const iso = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;

/** 一切健康的依赖；每个用例只改自己关心的那一项。 */
function healthyDeps(overrides: Partial<SelfCheckDeps> = {}): SelfCheckDeps {
  return {
    now: () => NOW,
    deploymentRuns: () => [
      { status: 'running', startedAt: iso(-3 * HOUR), finishedAt: iso(-3 * HOUR + 5 * MIN) },
      { status: 'building', startedAt: iso(-5 * MIN) },
    ],
    webhookDeliveries: () => [
      { receivedAt: iso(-10 * MIN), signatureValid: true, dispatchAction: 'deploy' },
      // 两天前的坏签名不在 24 小时窗口里，不该算进来。
      { receivedAt: iso(-48 * HOUR), signatureValid: false, dispatchAction: 'error' },
    ],
    buildGate: () => ({ active: 1, queued: 0, max: 3, waiters: [] }),
    cycleHealth: () => ({ sinceLastCycleMs: 40_000, stale: false, running: false, watchdogResets: 0 }),
    processStartedAt: () => NOW - 2 * HOUR,
    diskUsage: () => ({ totalBytes: 100, freeBytes: 60 }),
    dockerPing: async () => ({ ok: true, ms: 120, detail: '27.1.1' }),
    httpStats: async () => ({ requests: 400, serverErrors: 2, branchesP95Ms: 380 }),
    liveAlarmChannels: () => 1,
    selfStatus: () => ({ ready: true, bundleStale: false, headSha: 'abc1234', currentBranch: 'main' }),
    storeBackend: () => 'mongo-split',
    ...overrides,
  };
}

const URL_ = selfCheckUrl(7000);

describe('协议一致性：自检文档喂给 CDS 自己的解析器', () => {
  it('13 条监控一条不落、零拒收，且全部落在 production', async () => {
    const doc = await buildSelfCheck(healthyDeps());
    const { monitors, rejected } = discoverMonitors(doc, URL_);
    expect(rejected).toEqual([]);
    expect(monitors.map((m) => m.componentId).sort()).toEqual([
      'alarm.live-channels',
      'api.branches-p95-ms',
      'api.error-rate-30m',
      'build.oldest-wait-minutes',
      'build.queue-waiting',
      'deploy.failure-rate-24h',
      'deploy.stuck',
      'host.disk-used-percent',
      'host.docker-ping-ms',
      'prober.since-last-cycle-seconds',
      'self.bundle-stale',
      'webhook.dispatch-errors-24h',
      'webhook.signature-failures-24h',
    ]);
    for (const m of monitors) {
      expect(m.environment, m.componentId).toBe('production');
      expect(m.intervalSeconds, m.componentId).toBe(300);
    }
  });

  it('被动观测的每一条，其样本 componentId 都真实存在于同一份文档里', async () => {
    const doc = await buildSelfCheck(healthyDeps());
    const { monitors } = discoverMonitors(doc, URL_);
    const passive = monitors.filter((m) => m.observeMode === 'passive');
    expect(passive.length).toBeGreaterThanOrEqual(3);
    for (const m of passive) {
      expect(m.sampleComponentId, m.componentId).toBeTruthy();
      expect(doc.checks[m.sampleComponentId as string], `${m.componentId} 的样本 ${m.sampleComponentId}`).toBeDefined();
    }
  });

  it('健康时整份文档 pass，端点头 releaseId 是当前 HEAD', async () => {
    const doc = await buildSelfCheck(healthyDeps());
    expect(doc.status).toBe('pass');
    expect(doc.releaseId).toBe('abc1234');
    expect(doc.serviceId).toBe('cds');
  });

  it('八个用户在意的分类都覆盖到了', async () => {
    const doc = await buildSelfCheck(healthyDeps());
    const types = new Set(Object.values(doc.checks).map((c) => c.componentType));
    expect([...types].sort()).toEqual(['alarm', 'build', 'deploy', 'github', 'host', 'http', 'prober', 'self', 'store']);
  });
});

describe('部署 / 构建 / 页面', () => {
  it('在途超过 45 分钟的部署算卡住：整份文档 fail，且判据是 eq 0', async () => {
    const doc = await buildSelfCheck(healthyDeps({
      deploymentRuns: () => [{ status: 'building', startedAt: iso(-50 * MIN) }],
    }));
    expect(doc.checks['deploy.stuck']).toMatchObject({ observedValue: 1, status: 'fail' });
    expect(doc.status).toBe('fail');
    const { monitors } = discoverMonitors(doc, URL_);
    expect(monitors.find((m) => m.componentId === 'deploy.stuck')).toMatchObject({ op: 'eq', value: '0', severity: 'P0' });
  });

  it('在途 5 分钟的部署不算卡住', async () => {
    const doc = await buildSelfCheck(healthyDeps());
    expect(doc.checks['deploy.stuck']).toMatchObject({ observedValue: 0, status: 'pass' });
  });

  it('在途才 20 分钟但心跳停了 15 分钟：算卡住——被重启打断的部署就长这样', async () => {
    const doc = await buildSelfCheck(healthyDeps({
      deploymentRuns: () => [
        { status: 'building', startedAt: iso(-20 * MIN), heartbeatAt: iso(-15 * MIN) },
        // 心跳 2 分钟前还在：不算
        { status: 'building', startedAt: iso(-20 * MIN), heartbeatAt: iso(-2 * MIN) },
        // 没有心跳字段的老记录不按心跳判
        { status: 'building', startedAt: iso(-20 * MIN) },
      ],
    }));
    const c = doc.checks['deploy.stuck'];
    expect(c).toMatchObject({ observedValue: 1, status: 'fail' });
    expect(c.output).toContain('心跳停了');
  });

  it('既超 45 分钟又心跳停了的同一个部署只算一次', async () => {
    const doc = await buildSelfCheck(healthyDeps({
      deploymentRuns: () => [{ status: 'building', startedAt: iso(-50 * MIN), heartbeatAt: iso(-30 * MIN) }],
    }));
    expect(doc.checks['deploy.stuck'].observedValue).toBe(1);
  });

  it('近 24 小时没有部署结束：失败率写 0 但样本量是 0，被动观测不会读成一切正常', async () => {
    const doc = await buildSelfCheck(healthyDeps({ deploymentRuns: () => [] }));
    expect(doc.checks['deploy.finished-24h'].observedValue).toBe(0);
    const { monitors } = discoverMonitors(doc, URL_);
    expect(monitors.find((m) => m.componentId === 'deploy.failure-rate-24h')).toMatchObject({
      observeMode: 'passive', sampleComponentId: 'deploy.finished-24h',
    });
  });

  it('构建队列积压 6 个、最久等 20 分钟：两条都 fail', async () => {
    const doc = await buildSelfCheck(healthyDeps({
      buildGate: () => ({ active: 3, queued: 6, max: 3, waiters: [{ enqueuedAt: iso(-20 * MIN) }, { enqueuedAt: iso(-2 * MIN) }] }),
    }));
    expect(doc.checks['build.queue-waiting']).toMatchObject({ observedValue: 6, status: 'fail' });
    expect(doc.checks['build.oldest-wait-minutes']).toMatchObject({ observedValue: 20, status: 'fail' });
  });

  it('没接 HTTP 日志存储：三条页面指标都是 null + warn，而不是 0 + pass', async () => {
    const doc = await buildSelfCheck(healthyDeps({ httpStats: async () => null }));
    expect(doc.checks['api.requests-30m']).toMatchObject({ observedValue: null, status: 'warn' });
    expect(doc.checks['api.branches-p95-ms']).toMatchObject({ observedValue: null, status: 'warn' });
    expect(doc.checks['api.error-rate-30m']).toMatchObject({ observedValue: null, status: 'warn' });
  });

  it('近 30 分钟没人打开过分支列表：P95 为 null、warn，样本量 0', async () => {
    const doc = await buildSelfCheck(healthyDeps({ httpStats: async () => ({ requests: 0, serverErrors: 0, branchesP95Ms: null }) }));
    expect(doc.checks['api.branches-p95-ms']).toMatchObject({ observedValue: null, status: 'warn' });
    expect(doc.checks['api.requests-30m'].observedValue).toBe(0);
  });

  it('P95 超 1500ms 或 5xx 超 5% 都 fail', async () => {
    const doc = await buildSelfCheck(healthyDeps({ httpStats: async () => ({ requests: 100, serverErrors: 9, branchesP95Ms: 2200 }) }));
    expect(doc.checks['api.branches-p95-ms'].status).toBe('fail');
    expect(doc.checks['api.error-rate-30m']).toMatchObject({ observedValue: 9, status: 'fail' });
  });
});

describe('量不到就说量不到（三个哨兵）', () => {
  it('磁盘读不到：observedValue 是 null 且 fail，绝不是 0%', async () => {
    const doc = await buildSelfCheck(healthyDeps({ diskUsage: () => null }));
    expect(doc.checks['host.disk-used-percent']).toMatchObject({ observedValue: null, status: 'fail' });
  });

  it('磁盘 40% 用量算正常，92% 算 fail', async () => {
    const ok = await buildSelfCheck(healthyDeps());
    expect(ok.checks['host.disk-used-percent']).toMatchObject({ observedValue: 40, status: 'pass' });
    const full = await buildSelfCheck(healthyDeps({ diskUsage: () => ({ totalBytes: 100, freeBytes: 8 }) }));
    expect(full.checks['host.disk-used-percent']).toMatchObject({ observedValue: 92, status: 'fail' });
  });

  it('Docker 打不通：写哨兵值，它必须落在阈值之外，判据读到它就红', async () => {
    const doc = await buildSelfCheck(healthyDeps({ dockerPing: async () => ({ ok: false, ms: 3, detail: 'socket refused' }) }));
    const c = doc.checks['host.docker-ping-ms'];
    expect(c.status).toBe('fail');
    expect(c.observedValue).toBe(DOCKER_UNREACHABLE_MS);
    expect(DOCKER_UNREACHABLE_MS).toBeGreaterThan(DOCKER_PING_MAX_MS);
    expect(c.output).toContain('socket refused');
  });

  it('探测器起来之后一轮都没跑完且已停摆：写哨兵值而不是 0（0 会被读成「刚跑过」）', async () => {
    const doc = await buildSelfCheck(healthyDeps({ cycleHealth: () => ({ sinceLastCycleMs: null, stale: true, running: true, watchdogResets: 0 }) }));
    const c = doc.checks['prober.since-last-cycle-seconds'];
    expect(c.status).toBe('fail');
    expect(c.observedValue).toBe(PROBER_STALLED_SECONDS);
    expect(PROBER_STALLED_SECONDS).toBeGreaterThan(PROBER_STALE_AFTER_SECONDS);
  });

  it('刚重启、首轮还在跑：写进程起来多久，不响铃——否则每次自更新都先响一次', async () => {
    const doc = await buildSelfCheck(healthyDeps({
      cycleHealth: () => ({ sinceLastCycleMs: null, stale: false, running: true, watchdogResets: 0 }),
      processStartedAt: () => NOW - 20_000,
    }));
    const c = doc.checks['prober.since-last-cycle-seconds'];
    expect(c).toMatchObject({ observedValue: 20, status: 'pass' });
    expect(c.output).toContain('首轮还在跑');
  });

  it('停摆判定听探测器自己的：它说 stale，哪怕上一轮数字不大也 fail', async () => {
    const doc = await buildSelfCheck(healthyDeps({ cycleHealth: () => ({ sinceLastCycleMs: 100_000, stale: true, running: true, watchdogResets: 2 }) }));
    expect(doc.checks['prober.since-last-cycle-seconds'].status).toBe('fail');
  });

  it('拿不到探测器状态同样 fail', async () => {
    const doc = await buildSelfCheck(healthyDeps({ cycleHealth: () => null }));
    expect(doc.checks['prober.since-last-cycle-seconds'].status).toBe('fail');
  });
});

describe('接入 / 通知 / 自身', () => {
  it('24 小时内一条坏签名就是 P0；两天前的不算', async () => {
    const doc = await buildSelfCheck(healthyDeps());
    expect(doc.checks['webhook.signature-failures-24h']).toMatchObject({ observedValue: 0, status: 'pass' });
    const bad = await buildSelfCheck(healthyDeps({
      webhookDeliveries: () => [{ receivedAt: iso(-MIN), signatureValid: false, dispatchAction: 'ignored' }],
    }));
    expect(bad.checks['webhook.signature-failures-24h']).toMatchObject({ observedValue: 1, status: 'fail' });
    const { monitors } = discoverMonitors(bad, URL_);
    expect(monitors.find((m) => m.componentId === 'webhook.signature-failures-24h')?.severity).toBe('P0');
  });

  it('派发失败的 webhook 单独一条', async () => {
    const doc = await buildSelfCheck(healthyDeps({
      webhookDeliveries: () => [{ receivedAt: iso(-MIN), signatureValid: true, dispatchAction: 'error' }],
    }));
    expect(doc.checks['webhook.dispatch-errors-24h']).toMatchObject({ observedValue: 1, status: 'fail' });
    expect(doc.checks['webhook.signature-failures-24h'].status).toBe('pass');
  });

  it('没有一条通道有成功投递记录：fail，文案说清「配了但没发成功过的也不算」并给下一步', async () => {
    const doc = await buildSelfCheck(healthyDeps({ liveAlarmChannels: () => 0 }));
    const c = doc.checks['alarm.live-channels'];
    expect(c).toMatchObject({ observedValue: 0, status: 'fail' });
    expect(c.output).toContain('没发成功过的也不算');
    expect(c.output).toContain('演练一次');
  });

  it('前端产物落后于代码：flag 写 1，fail；拿不到自身状态也算 fail', async () => {
    const stale = await buildSelfCheck(healthyDeps({ selfStatus: () => ({ ready: true, bundleStale: true, headSha: 'deadbee', currentBranch: 'x' }) }));
    expect(stale.checks['self.bundle-stale']).toMatchObject({ observedValue: 1, status: 'fail' });
    const unknown = await buildSelfCheck(healthyDeps({ selfStatus: () => null }));
    expect(unknown.checks['self.bundle-stale']).toMatchObject({ observedValue: 1, status: 'fail' });
    expect(unknown.releaseId).toBeUndefined();
  });

  it('刚重启、自身状态缓存还没算完：宽限期内写 0 + warn 不响铃；过了宽限还不知道才 fail', async () => {
    const notReady = () => ({ ready: false, bundleStale: false, headSha: '', currentBranch: '' });
    const young = await buildSelfCheck(healthyDeps({ selfStatus: notReady, processStartedAt: () => NOW - 30_000 }));
    expect(young.checks['self.bundle-stale']).toMatchObject({ observedValue: 0, status: 'warn' });
    expect(young.checks['self.bundle-stale'].output).toContain('还没算完');
    expect(young.releaseId).toBeUndefined();
    const old = await buildSelfCheck(healthyDeps({ selfStatus: notReady, processStartedAt: () => NOW - SELF_STATUS_GRACE_MS - 1000 }));
    expect(old.checks['self.bundle-stale']).toMatchObject({ observedValue: 1, status: 'fail' });
  });
});

describe('启动引导：幂等、可回生', () => {
  function fakeState(): SelfMonitoringState & { projects: Project[] } {
    const projects: Project[] = [];
    return {
      projects,
      getProjects: () => projects,
      addProject: (p) => { projects.push(p); },
      addMonitorEndpoint: (projectId, url) => {
        const p = projects.find((x) => x.id === projectId);
        if (!p) return false;
        p.monitorEndpoints = [...(p.monitorEndpoints || []), url];
        return true;
      },
    };
  }

  it('第一次建项目 + 插端点；第二次什么都不做', () => {
    const state = fakeState();
    const first = ensureSelfMonitoring(state, 7000, NOW);
    expect(first).toMatchObject({ projectId: SELF_PROJECT_ID, createdProject: true, addedEndpoint: true });
    expect(first.url).toBe(`http://127.0.0.1:7000${SELF_CHECK_PATH}`);
    const second = ensureSelfMonitoring(state, 7000, NOW + 1000);
    expect(second).toMatchObject({ createdProject: false, addedEndpoint: false });
    expect(state.projects).toHaveLength(1);
    expect(state.projects[0].monitorEndpoints).toEqual([first.url]);
    expect(state.projects[0].kind).toBe('manual');
  });

  it('项目被删掉之后再启动会回来', () => {
    const state = fakeState();
    ensureSelfMonitoring(state, 7000, NOW);
    state.projects.splice(0, 1);
    const again = ensureSelfMonitoring(state, 7000, NOW);
    expect(again.createdProject).toBe(true);
    expect(state.projects).toHaveLength(1);
  });

  it('内置端点只认本机回环 + 自检路径', () => {
    expect(isSelfCheckEndpoint('http://127.0.0.1:7000/api/self-check')).toBe(true);
    expect(isSelfCheckEndpoint('http://localhost:7000/api/self-check')).toBe(true);
    expect(isSelfCheckEndpoint('https://cds.example.test/api/self-check')).toBe(false);
    expect(isSelfCheckEndpoint('http://127.0.0.1:7000/api/healthz')).toBe(false);
    expect(isSelfCheckEndpoint('not a url')).toBe(false);
  });
});

describe('接线守卫：删掉任何一根线都不会有别的测试变红', () => {
  const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
  const codeOf = (src: string): string =>
    src.replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '').replace(/^\s*\/\/.*$/gm, '');
  const index = codeOf(read('../../src/index.ts'));
  const server = codeOf(read('../../src/server.ts'));
  const auth = codeOf(read('../../src/middleware/github-auth.ts'));
  const uptime = codeOf(read('../../src/routes/uptime.ts'));
  const strip = codeOf(read('../../web/src/pages/status/DiscoveryStrip.tsx'));
  const prober = codeOf(read('../../src/services/uptime-custom-monitor.ts'));
  const runner = codeOf(read('../../src/services/monitor-discovery-runner.ts'));
  const serverSrc = codeOf(read('../../src/server.ts'));

  it('index.ts 真挂了自检路由，且用的是共享路径常量；路由走短缓存，不让 13 条监控各算一份', () => {
    expect(index).toMatch(/app\.get\(SELF_CHECK_PATH,/);
    expect(index).toContain('buildSelfCheck(selfCheckDeps)');
    expect(index).toMatch(/app\.get\(SELF_CHECK_PATH,[\s\S]{0,800}cachedSelfCheck\(\)/);
  });

  it('启动引导必须发生在第一轮发现之前——否则第一轮把内置端点漏掉，要等下一轮才补', () => {
    const boot = index.indexOf('ensureSelfMonitoring(stateService');
    const firstRun = index.indexOf('void runDiscovery().catch');
    expect(boot).toBeGreaterThan(0);
    expect(firstRun).toBeGreaterThan(0);
    expect(boot).toBeLessThan(firstRun);
  });

  it('两处登录门白名单都放行了它（它有自己的令牌门，不走 cookie）', () => {
    expect(server).toContain(`path === '${SELF_CHECK_PATH}'`);
    expect(auth).toContain(`'${SELF_CHECK_PATH}'`);
  });

  it('路由在任何计算之前先验令牌与回环：验不过就 401，不算文档', () => {
    const route = index.slice(index.indexOf('app.get(SELF_CHECK_PATH,'));
    const verifyAt = route.indexOf('selfCheckAuth.verify(');
    const buildAt = route.indexOf('cachedSelfCheck()');
    expect(verifyAt).toBeGreaterThan(0);
    expect(buildAt).toBeGreaterThan(0);
    expect(verifyAt).toBeLessThan(buildAt);
    expect(route.slice(verifyAt, buildAt)).toContain('status(401)');
    expect(route.slice(verifyAt, buildAt)).toContain('req.socket.remoteAddress');
  });

  it('探测器的两条 fetch 与发现器的 fetch 都带 internalProbeHeaders——少一处，那条链路打自检端点就 401', () => {
    const proberFetches = prober.split('await fetch(').length - 1;
    const proberWired = prober.split('...internalProbeHeaders(').length - 1;
    expect(proberFetches).toBeGreaterThanOrEqual(2);
    expect(proberWired).toBe(proberFetches);
    expect(runner).toContain('...internalProbeHeaders(url)');
  });

  it('启动收尸接在 server.ts 里，且在周期收割之前', () => {
    const orphan = serverSrc.indexOf('reconcileOrphanedByRestart(');
    const periodic = serverSrc.indexOf('deploymentRunService.reconcileInterrupted()');
    expect(orphan).toBeGreaterThan(0);
    expect(orphan).toBeLessThan(periodic);
  });

  it('通知通道数按投递台账判：最近一次投递失败的通道不算活', () => {
    expect(index).toMatch(/liveAlarmChannels: \(\) => countLiveAlarmChannels\(/);
    expect(index).toMatch(/liveAlarmChannels:[\s\S]{0,300}alarmLedger\.view\(c, channelConfigured\(c\)\)/);
    expect(index).toMatch(/liveAlarmChannels:[\s\S]{0,300}alarmChannel\.snapshot\(\)/);
  });

  it('端点列表由服务端标出内置那条，拔它被拒；前端只认名单不自己判地址', () => {
    expect(uptime).toContain('builtin: endpoints.filter(isSelfCheckEndpoint)');
    expect(uptime).toMatch(/if \(isSelfCheckEndpoint\(url\)\) \{[\s\S]{0,200}status\(400\)/);
    expect(strip).toContain("data?.builtin || []).includes(url)");
    expect(strip).not.toContain('new URL(');
  });
});
