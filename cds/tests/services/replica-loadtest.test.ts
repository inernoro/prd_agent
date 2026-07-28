/**
 * 复制集压测（replica-loadtest）回归。
 *
 * 这个功能天生危险：它在**生产 CDS 宿主**上主动制造负载，还要向一个由入参决定的
 * Host 发请求。所以测试覆盖的重点不是「指标算得漂不漂亮」，而是四道闸真的关得住：
 *
 *   1. 分位数/指标在空样本、单样本这些边界上不炸（报告是决策依据，算错比不算更坏）；
 *   2. 并发/时长/方法/请求头的硬上限一律拒绝而不是静默截断；
 *   3. SSRF：非本分支域名一律 403——否则拿自己分支的授权就能让 CDS 替你压别人；
 *   4. 磁盘冻结档拒绝发起、同时只允许一个压测在跑、取消能在一个请求周期内生效。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StateService } from '../../src/services/state.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';
import { computePreviewSlug } from '../../src/services/preview-slug.js';
import type { BranchEntry, BuildProfile } from '../../src/types.js';
import {
  LOADTEST_LIMITS,
  LatencyDigest,
  LoadTestError,
  ReplicaLoadTestService,
  buildComparison,
  classifyStatus,
  describePhase,
  isHostAllowedForBranch,
  normalizeLoadTestConfig,
  percentile,
  withReplicaPin,
  type LoadTestRequestFn,
  type LoadTestTargetMetrics,
} from '../../src/services/replica-loadtest.js';

const ROOT = 'example.test';
const SLUG = computePreviewSlug('main', 'demo');
const HOST = `${SLUG}.${ROOT}`;

let tmpDir: string;
let state: StateService;

const mkMember = (id: string, status: 'running' | 'stopped' = 'running') => ({
  id,
  versionId: 'dv1',
  weight: 50,
  image: 'img',
  status,
  containerName: `cds-proj-main-api-${id}`,
  hostPort: 12000,
  dbMode: 'shared' as const,
  createdAt: new Date().toISOString(),
});

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-loadtest-'));
  state = new StateService(path.join(tmpDir, 'state.json'));
  state.addProject({ id: 'proj', slug: 'demo', name: 'demo', createdAt: new Date().toISOString() } as Parameters<typeof state.addProject>[0]);
  state.addBuildProfile({
    id: 'api', projectId: 'proj', name: 'api', runtime: 'docker', containerPort: 8080, pathPrefixes: ['/api/'],
  } as unknown as BuildProfile);
  const branch: BranchEntry = {
    id: 'proj-main', projectId: 'proj', branch: 'main', worktreePath: '/tmp/x',
    services: { api: { status: 'running', hostPort: 11000, containerName: 'cds-proj-main-api' } },
    status: 'running', createdAt: new Date().toISOString(),
    replicaSets: {
      api: {
        profileId: 'api', enabled: true, primaryWeight: 50,
        members: [mkMember('res-1')],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    },
  } as unknown as BranchEntry;
  state.addBranch(branch);
});

afterEach(async () => {
  await flushAllJsonStateStores();
  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

/** 立即返回 200 的假执行器：测试不碰网络，跑得完、跑得稳。 */
const okRequest: LoadTestRequestFn = async ({ path: p }) => ({
  status: 200,
  servedBy: /__rs=api%3A([a-z0-9-]+)/.exec(p)?.[1],
});

const mkService = (over: Partial<ConstructorParameters<typeof ReplicaLoadTestService>[0]> = {}): ReplicaLoadTestService =>
  new ReplicaLoadTestService({
    state,
    rootDomains: [ROOT],
    forwarderPort: 9090,
    requestFn: okRequest,
    ...over,
  });

/* ────────────── 纯函数：分位数与指标边界 ────────────── */

describe('分位数计算（报告是决策依据，边界不许炸）', () => {
  it('空样本返回 0——报告里 0 表示没有样本，比 NaN 更适合直接渲染', () => {
    expect(percentile([], 50)).toBe(0);
    expect(percentile([], 99)).toBe(0);
  });

  it('单样本时任何分位都等于那个值', () => {
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([42], 95)).toBe(42);
    expect(percentile([42], 0)).toBe(42);
  });

  it('nearest-rank：p50/p90/p99 落在正确的名次上', () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
    expect(percentile(values, 50)).toBe(50);
    expect(percentile(values, 90)).toBe(90);
    expect(percentile(values, 95)).toBe(95);
    expect(percentile(values, 99)).toBe(99);
    expect(percentile(values, 100)).toBe(100);
  });

  it('乱序输入不影响结果（内部排序，且不改原数组）', () => {
    const values = [30, 10, 20];
    expect(percentile(values, 50)).toBe(20);
    expect(values).toEqual([30, 10, 20]);
  });

  it('分位参数越界被夹紧，不抛异常', () => {
    expect(percentile([1, 2, 3], -10)).toBe(1);
    expect(percentile([1, 2, 3], 999)).toBe(3);
  });

  it('错误归类：5xx 是被压垮，4xx 多半是路径打错了', () => {
    expect(classifyStatus(200)).toBeNull();
    expect(classifyStatus(302)).toBeNull();
    expect(classifyStatus(404)).toBe('http4xx');
    expect(classifyStatus(503)).toBe('http5xx');
  });
});

/* ────────────── 纯函数：硬上限 ────────────── */

describe('压测硬闸：越界一律拒绝，不静默截断', () => {
  const norm = (input: Parameters<typeof normalizeLoadTestConfig>[0], targets = 1) =>
    normalizeLoadTestConfig(input, targets, HOST, '/api/');

  it('给出可用默认值（少绕路：用户什么都不填也能跑）', () => {
    const cfg = norm(undefined);
    expect(cfg.concurrency).toBeGreaterThan(0);
    expect(cfg.durationSec).toBeGreaterThanOrEqual(LOADTEST_LIMITS.minDurationSec);
    expect(cfg.method).toBe('GET');
    expect(cfg.path).toBe('/api/');
  });

  it('单目标并发超上限直接报错', () => {
    expect(() => norm({ concurrency: LOADTEST_LIMITS.maxConcurrencyPerTarget + 1 })).toThrow(LoadTestError);
    expect(() => norm({ concurrency: 0 })).toThrow(/并发数需在/);
  });

  it('合计并发（目标数 × 并发）超上限报错——A/B 时目标数会把并发乘上去', () => {
    const perTarget = LOADTEST_LIMITS.maxConcurrencyPerTarget;
    const targets = Math.ceil(LOADTEST_LIMITS.maxTotalConcurrency / perTarget) + 1;
    expect(() => norm({ concurrency: perTarget }, targets)).toThrow(/合计/);
  });

  it('时长上下限、总请求数上限都拦得住', () => {
    expect(() => norm({ durationSec: LOADTEST_LIMITS.maxDurationSec + 1 })).toThrow(/持续时长/);
    expect(() => norm({ durationSec: 1 })).toThrow(/持续时长/);
    expect(() => norm({ warmupSec: LOADTEST_LIMITS.maxWarmupSec + 1 })).toThrow(/预热时长/);
    expect(() => norm({ maxRequests: LOADTEST_LIMITS.maxTotalRequests + 1 })).toThrow(/总请求数/);
  });

  it('方法白名单外一律拒绝', () => {
    expect(() => norm({ method: 'TRACE' })).toThrow(/不支持的方法/);
    expect(norm({ method: 'post', body: '{}' }).method).toBe('POST');
  });

  it('路径必须是可打印 ASCII——控制字符会让 http.request 在并发里同步抛', () => {
    expect(() => norm({ path: 'api' })).toThrow(/请求路径/);
    expect(() => norm({ path: '/api/ x' })).toThrow(/请求路径/);
    // 内嵌换行是请求头注入的经典载体，必须拒（首尾空白按 trim 处理属正常容错）
    expect(() => norm({ path: '/api/\nX-Injected: 1' })).toThrow(/请求路径/);
    expect(norm({ path: '/api/health?x=1' }).path).toBe('/api/health?x=1');
  });

  it('保留请求头不许覆写——覆写 Host 等于偷换被压目标', () => {
    expect(() => norm({ headers: { Host: 'evil.example.com' } })).toThrow(/不能覆写/);
    expect(() => norm({ headers: { 'X-CDS-Loadtest': '0' } })).toThrow(/不能覆写/);
    expect(norm({ headers: { 'X-Trace': 'abc' } }).headers).toEqual({ 'X-Trace': 'abc' });
  });

  it('GET 不许带请求体；请求体超长拒绝', () => {
    expect(() => norm({ method: 'GET', body: 'x' })).toThrow(/不能携带请求体/);
    expect(() => norm({ method: 'POST', body: 'x'.repeat(LOADTEST_LIMITS.maxBodyBytes + 1) })).toThrow(/请求体/);
  });
});

/* ────────────── SSRF 白名单 ────────────── */

describe('SSRF 闸门：只许压本分支已发布的域名', () => {
  const allow = {
    labels: new Set([SLUG, `${SLUG}-api-res-1`, `${SLUG}-gw`]),
    customDomains: new Set(['demo.example.com']),
    roots: [ROOT],
  };

  it('放行主入口 / 命名子域 / 成员直达域', () => {
    expect(isHostAllowedForBranch(HOST, allow)).toBe(true);
    expect(isHostAllowedForBranch(`${SLUG}-gw.${ROOT}`, allow)).toBe(true);
    expect(isHostAllowedForBranch(`${SLUG}-api-res-1.${ROOT}`, allow)).toBe(true);
  });

  it('拒绝任意外部 URL 主机名', () => {
    expect(isHostAllowedForBranch('evil.example.com', allow)).toBe(false);
    expect(isHostAllowedForBranch('169.254.169.254', allow)).toBe(false);
    expect(isHostAllowedForBranch('localhost', allow)).toBe(false);
    expect(isHostAllowedForBranch('', allow)).toBe(false);
    expect(isHostAllowedForBranch('http://evil.example.com/x', allow)).toBe(false);
  });

  it('拒绝「首标签以本分支 slug 打头」的别家域名（前缀匹配的经典漏洞）', () => {
    expect(isHostAllowedForBranch(`${SLUG}-other.${ROOT}`, allow)).toBe(false);
    expect(isHostAllowedForBranch(`${SLUG}.evil.com`, allow)).toBe(false);
    expect(isHostAllowedForBranch(`a.${SLUG}.${ROOT}`, allow)).toBe(false);
  });

  it('自定义域走全串精确匹配', () => {
    expect(isHostAllowedForBranch('demo.example.com', allow)).toBe(true);
    expect(isHostAllowedForBranch('x.demo.example.com', allow)).toBe(false);
  });

  it('根域未配置（纯本地 dev）时退回首标签语义，功能仍可用', () => {
    const local = { labels: new Set([SLUG]), customDomains: new Set<string>(), roots: [] as string[] };
    expect(isHostAllowedForBranch(`${SLUG}.localhost`, local)).toBe(true);
    expect(isHostAllowedForBranch('evil.localhost', local)).toBe(false);
  });

  it('服务层发起时对非法 host 回 403（端到端闸门，不只是纯函数）', () => {
    const svc = mkService();
    expect(() => svc.start('proj-main', 'api', { host: 'evil.example.com', durationSec: 3 }))
      .toThrow(/不属于该分支的已发布域名/);
    try {
      svc.start('proj-main', 'api', { host: 'evil.example.com', durationSec: 3 });
    } catch (err) {
      expect((err as LoadTestError).status).toBe(403);
    }
  });
});

/* ────────────── 并发闸 / 取消 / 磁盘刹车 ────────────── */

describe('压测并发闸与生命周期', () => {
  it('磁盘冻结档拒绝发起（507），理由带原始档位说明', () => {
    const svc = mkService({ diskBlockReason: () => '宿主磁盘已用 97%，已冻结新的构建与部署派发' });
    try {
      svc.start('proj-main', 'api', { durationSec: 3 });
      throw new Error('本应拒绝');
    } catch (err) {
      expect(err).toBeInstanceOf(LoadTestError);
      expect((err as LoadTestError).status).toBe(507);
      expect((err as LoadTestError).message).toContain('97%');
    }
  });

  it('同时只允许一个压测在跑，第二个被拒并说明谁在占用', async () => {
    const svc = mkService();
    const first = svc.start('proj-main', 'api', { durationSec: 3, concurrency: 1 });
    expect(first.status).toBe('running');
    try {
      svc.start('proj-main', 'api', { durationSec: 3, concurrency: 1 });
      throw new Error('本应拒绝');
    } catch (err) {
      expect((err as LoadTestError).status).toBe(409);
      expect((err as LoadTestError).message).toContain(first.id);
    }
    expect(svc.activeHolders()).toHaveLength(1);
    expect(svc.activeHolders()[0]).toMatchObject({ branchId: 'proj-main', profileId: 'api' });
    svc.cancel('proj-main', first.id);
  });

  it('取消在一个请求周期内生效：状态即刻翻转、闸位即刻释放、worker 随即退出', async () => {
    let inFlight = 0;
    const slowRequest: LoadTestRequestFn = async () => {
      inFlight += 1;
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return { status: 200 };
    };
    const svc = mkService({ requestFn: slowRequest });
    const run = svc.start('proj-main', 'api', { durationSec: 60, concurrency: 2 });
    await new Promise((r) => setTimeout(r, 30));
    const cancelled = svc.cancel('proj-main', run.id);
    expect(cancelled.status).toBe('cancelled');
    expect(svc.activeHolders()).toHaveLength(0);
    // 一个请求周期（5ms）后 worker 必须全部退出，不再有新请求进入
    await new Promise((r) => setTimeout(r, 40));
    expect(inFlight).toBe(0);
    const after = svc.get('proj-main', run.id);
    expect(after.status).toBe('cancelled');
    expect(after.progressPct).toBe(100);
    // 已跑出的样本保留，不因取消而丢弃
    expect(after.targets.reduce((s, t) => s + t.requests, 0)).toBeGreaterThan(0);
  });

  it('心跳过期的僵尸会被收割，闸位不会永久泄漏（周期收敛）', () => {
    let clock = 1_000_000;
    const hang: LoadTestRequestFn = () => new Promise(() => { /* 永不 resolve，模拟卡死 */ });
    const svc = mkService({ requestFn: hang, now: () => clock });
    const run = svc.start('proj-main', 'api', { durationSec: 10, concurrency: 1 });
    expect(svc.activeHolders()).toHaveLength(1);
    clock += LOADTEST_LIMITS.staleHeartbeatMs + 1000;
    expect(svc.reapStale()).toBe(1);
    expect(svc.activeHolders()).toHaveLength(0);
    expect(svc.get('proj-main', run.id).status).toBe('error');
    expect(svc.health().ok).toBe(true);
  });

  it('健康不变量：占位数恒等于 running 记录数', async () => {
    const svc = mkService();
    const run = svc.start('proj-main', 'api', { durationSec: 3, concurrency: 1 });
    expect(svc.health()).toMatchObject({ ok: true, active: 1, running: 1 });
    svc.cancel('proj-main', run.id);
    expect(svc.health()).toMatchObject({ ok: true, active: 0, running: 0 });
  });

  it('没有运行中的实例时拒绝发起，并说清为什么', () => {
    const branch = state.getBranch('proj-main')!;
    branch.services!.api.status = 'stopped';
    branch.replicaSets!.api.members[0].status = 'stopped';
    state.save();
    const svc = mkService();
    expect(() => svc.start('proj-main', 'api', { durationSec: 3 })).toThrow(/没有可压测的运行中实例/);
  });

  it('不存在的分支 / 服务给 404', () => {
    const svc = mkService();
    expect(() => svc.start('nope', 'api', {})).toThrow(/分支不存在/);
    expect(() => svc.start('proj-main', 'nope', {})).toThrow(/服务不存在/);
  });
});

/* ────────────── 目标解析与报告 ────────────── */

describe('目标解析：主实例 + 运行中副本各自钉选', () => {
  it('默认把主实例与全部运行中副本一起纳入（这就是 A/B 对比台）', () => {
    const svc = mkService();
    const targets = svc.resolveTargets('proj-main', 'api', undefined, HOST, '/api/');
    expect(targets.map((t) => t.memberId)).toEqual(['primary', 'res-1']);
    expect(targets.map((t) => t.pinned)).toEqual(['api:primary', 'api:res-1']);
  });

  it('memberIds 可缩小范围；停止态副本永远不进目标', () => {
    const branch = state.getBranch('proj-main')!;
    branch.replicaSets!.api.members.push(mkMember('res-2', 'stopped'));
    state.save();
    const svc = mkService();
    expect(svc.resolveTargets('proj-main', 'api', ['res-1'], HOST, '/api/').map((t) => t.memberId)).toEqual(['res-1']);
    expect(svc.resolveTargets('proj-main', 'api', undefined, HOST, '/api/').map((t) => t.memberId)).toEqual(['primary', 'res-1']);
  });

  it('报告在跑的过程中就有阶段文案与进度（禁止空白等待）', () => {
    const svc = mkService();
    const run = svc.start('proj-main', 'api', { durationSec: 10, warmupSec: 3, concurrency: 1 });
    expect(run.phase).toContain('预热');
    expect(run.etaSec).toBeGreaterThan(0);
    expect(run.targets).toHaveLength(2);
    svc.cancel('proj-main', run.id);
    expect(describePhase('running', 5, 3, 8)).toContain('加压中');
    expect(describePhase('done', 10, 0, 0)).toContain('已完成');
  });

  it('跑完后落在 done，并给出 A/B 对比结论与逐秒序列', async () => {
    const svc = mkService();
    const started = svc.start('proj-main', 'api', { durationSec: 3, concurrency: 2 });
    await new Promise((r) => setTimeout(r, 3400));
    const report = svc.get('proj-main', started.id);
    expect(report.status).toBe('done');
    expect(report.progressPct).toBe(100);
    expect(report.targets.every((t) => t.requests > 0)).toBe(true);
    expect(report.targets.every((t) => t.series.length > 0)).toBe(true);
    // 钉选真的生效：响应头回来的落点就是我们钉的那个成员
    expect(Object.keys(report.targets[1].servedBy)).toEqual(['res-1']);
    expect(report.comparison?.rows).toHaveLength(1);
    expect(report.comparison?.summary).toBeTruthy();
    expect(svc.health().ok).toBe(true);
  }, 10_000);
});

/* ────────────── 延迟直方图（定长内存的指标聚合） ────────────── */

describe('延迟直方图：O(1) 记账 + 定长内存', () => {
  const feed = (values: number[]): LatencyDigest => {
    const d = new LatencyDigest();
    for (const v of values) d.record(v);
    return d;
  };

  it('空摘要返回 0，与 percentile 的空样本语义一致', () => {
    const d = new LatencyDigest();
    expect(d.count).toBe(0);
    expect(d.quantile(50)).toBe(0);
    expect(d.avg).toBe(0);
    expect(d.byteEstimate()).toBe(0);
  });

  it('100ms 以下逐毫秒成桶，分位数与 percentile 完全一致（压测样本的主力区间）', () => {
    const values = Array.from({ length: 99 }, (_, i) => i + 1); // 1..99ms
    const d = feed(values);
    for (const p of [0, 25, 50, 90, 95, 99, 100]) {
      expect(d.quantile(p)).toBe(percentile(values, p));
    }
    expect(d.min).toBe(1);
    expect(d.max).toBe(99);
    expect(d.avg).toBe(50);
  });

  it('单样本任何分位都等于那个值；分位参数越界被夹紧', () => {
    const d = feed([42]);
    expect(d.quantile(0)).toBe(42);
    expect(d.quantile(95)).toBe(42);
    expect(d.quantile(-10)).toBe(42);
    expect(d.quantile(999)).toBe(42);
  });

  it('精度代价明示：粗桶段的分位数保守偏大，但绝不超过实测 max', () => {
    // 100-999ms 是 10ms 一桶：[100,101] 的 p50 精确值是 100，直方图给 101（桶上界
    // 109 被实测 max 收口）。宁可报慢不报快——不会把一个慢副本说成快。
    const d = feed([100, 101]);
    expect(percentile([100, 101], 50)).toBe(100);
    expect(d.quantile(50)).toBe(101);
    expect(d.quantile(50)).toBeLessThanOrEqual(d.max);
    // 1s 以上是 100ms 一桶，同样收口在 max
    const slow = feed([1000, 1250, 1499]);
    expect(slow.quantile(100)).toBe(1499);
    expect(slow.quantile(0)).toBeLessThanOrEqual(1099);
    // 超时上限以上落溢出桶，一律按 15000 计
    const timeout = feed([20_000]);
    expect(timeout.quantile(99)).toBe(15_000);
  });

  it('20 万条采样：count/min/max/avg 精确，内存不随条数增长', () => {
    const d = new LatencyDigest();
    for (let i = 0; i < LOADTEST_LIMITS.maxTotalRequests; i += 1) d.record(i % 50);
    const afterFull = d.byteEstimate();
    expect(d.count).toBe(LOADTEST_LIMITS.maxTotalRequests);
    expect(d.min).toBe(0);
    expect(d.max).toBe(49);
    expect(d.avg).toBe(24.5);
    // nearest-rank：rank = 10 万，恰好落在 0..24 这 25 个值的累计边界上
    expect(d.quantile(50)).toBe(24);
    // 定长：331 槽 x 4 字节，与采样条数无关
    expect(afterFull).toBe(LatencyDigest.SLOT_COUNT * 4);
    const small = feed([1]);
    expect(small.byteEstimate()).toBe(afterFull);
    d.release();
    expect(d.byteEstimate()).toBe(0);
  });
});

/* ────────────── 大样本聚合 ────────────── */

describe('大样本聚合：真实负载下报告不许炸', () => {
  it('跑满 20 万条采样也能出报告——指标聚合不得对采样数组用展开调用', async () => {
    const total = LOADTEST_LIMITS.maxTotalRequests;
    let clock = 1_000_000;
    let seq = 0;
    // 延迟按 0/1/2ms 循环：既让虚拟时钟推进得远慢于 deadline（20 万次共 20 万 ms < 300s），
    // 又给分位数一个可以精确断言的分布。
    const cycling: LoadTestRequestFn = async () => {
      clock += seq % 3;
      seq += 1;
      return { status: 200 };
    };
    const svc = mkService({ requestFn: cycling, now: () => clock });
    const started = svc.start('proj-main', 'api', {
      memberIds: ['primary'],
      concurrency: 1,
      durationSec: LOADTEST_LIMITS.maxDurationSec,
      maxRequests: total,
    });
    // activeHolders 不走 toReport，可以在「修复前的报告会抛异常」时安全地等待收尾
    for (let guard = 0; guard < 5000 && svc.activeHolders().length > 0; guard += 1) {
      await new Promise((r) => setImmediate(r));
    }
    expect(svc.activeHolders()).toHaveLength(0);

    // 修复前：targetMetrics 对 20 万条采样做 push(...) / Math.min(...) 展开，这里抛
    // RangeError: Maximum call stack size exceeded，前端每次轮询都 500。
    const report = svc.get('proj-main', started.id);
    const t = report.targets[0];
    expect(t.requests).toBe(total);
    expect(t.success).toBe(total);
    expect(t.min).toBe(0);
    expect(t.max).toBe(2);
    expect(t.avg).toBe(1);
    expect(t.p50).toBe(1);
    expect(t.p90).toBe(2);
    expect(t.p95).toBe(2);
    expect(t.p99).toBe(2);
    expect(report.status).toBe('done');

    // 内存有上限：留存的是「每秒一个采样点」的序列，不是 20 万条原始延迟
    expect(t.series.length).toBeLessThanOrEqual(LOADTEST_LIMITS.maxDurationSec + 2);
    const runtime = (svc as unknown as { runs: Map<string, { targets: Array<{ buckets: Map<number, unknown> }> }> })
      .runs.get(started.id)!;
    expect(runtime.targets[0].buckets.size).toBeLessThanOrEqual(LOADTEST_LIMITS.maxDurationSec + 2);
    for (const bucket of runtime.targets[0].buckets.values()) {
      expect(Array.isArray((bucket as { latencies?: unknown }).latencies)).toBe(false);
    }
  }, 120_000);
});

/* ────────────── A/B 结论 ────────────── */

describe('A/B 对比结论', () => {
  const mkMetrics = (over: Partial<LoadTestTargetMetrics>): LoadTestTargetMetrics => ({
    memberId: 'x', label: 'x', requests: 100, success: 100, failed: 0, successRate: 1,
    qps: 100, avg: 10, min: 1, max: 50, p50: 10, p90: 20, p95: 20, p99: 30,
    errors: { timeout: 0, connect: 0, http5xx: 0, http4xx: 0, cancelled: 0, other: 0 },
    servedBy: {}, series: [], ...over,
  });

  it('只有一个目标时不出结论（没有参照物）', () => {
    expect(buildComparison([mkMetrics({ memberId: 'primary' })])).toBeUndefined();
  });

  it('没有样本的目标不参与对比', () => {
    const rows = buildComparison([
      mkMetrics({ memberId: 'primary' }),
      mkMetrics({ memberId: 'res-1', requests: 0 }),
    ]);
    expect(rows).toBeUndefined();
  });

  it('以主实例为基线，给出 p95 / 吞吐 / 成功率的相对差异', () => {
    const cmp = buildComparison([
      mkMetrics({ memberId: 'primary', label: '主实例', p95: 100, qps: 100, successRate: 1 }),
      mkMetrics({ memberId: 'res-1', label: '副本 1', p95: 118, qps: 91, successRate: 0.98 }),
    ]);
    expect(cmp?.baselineId).toBe('primary');
    expect(cmp?.rows[0].p95DeltaPct).toBe(18);
    expect(cmp?.rows[0].qpsDeltaPct).toBe(-9);
    expect(cmp?.rows[0].successRateDeltaPoint).toBe(-2);
    expect(cmp?.rows[0].verdict).toContain('更慢');
    expect(cmp?.summary).toContain('主实例');
  });

  it('差异小于 5% 判为持平，不制造虚假结论', () => {
    const cmp = buildComparison([
      mkMetrics({ memberId: 'primary', label: '主实例', p95: 100, qps: 100 }),
      mkMetrics({ memberId: 'res-1', label: '副本 1', p95: 102, qps: 101 }),
    ]);
    expect(cmp?.rows[0].verdict).toContain('持平');
  });

  it('没有 primary 时取第一个目标当基线', () => {
    const cmp = buildComparison([
      mkMetrics({ memberId: 'res-1', label: '副本 1', p95: 100 }),
      mkMetrics({ memberId: 'res-2', label: '副本 2', p95: 50 }),
    ]);
    expect(cmp?.baselineId).toBe('res-1');
    expect(cmp?.rows[0].p95DeltaPct).toBe(-50);
    expect(cmp?.summary).toContain('副本 2');
  });
});

describe('withReplicaPin：路径已带 __rs 时必须替换而不是追加（Codex PR #1273 P1）', () => {
  it('干净路径直接钉上', () => {
    expect(withReplicaPin('/health', 'rs-abc')).toBe('/health?__rs=rs-abc');
  });

  it('已有其他 query 时保留，并追加 __rs', () => {
    const out = withReplicaPin('/api?x=1', 'rs-abc');
    expect(out).toContain('x=1');
    expect(new URLSearchParams(out.split('?')[1]).getAll('__rs')).toEqual(['rs-abc']);
  });

  it('事故值：用户粘了已钉副本的预览 URL，必须替换掉旧 __rs（否则 A/B 全打到同一个副本）', () => {
    const out = withReplicaPin('/api?__rs=rs-USER&x=1', 'rs-target');
    const params = new URLSearchParams(out.split('?')[1]);
    // forwarder 用 .get() 取第一个——只能有一个值，且必须是本次落点
    expect(params.getAll('__rs')).toEqual(['rs-target']);
    expect(params.get('__rs')).toBe('rs-target');
    expect(params.get('x')).toBe('1');
  });

  it('带 hash 时 hash 原样保留在末尾', () => {
    expect(withReplicaPin('/page?a=1#top', 'rs-1')).toBe('/page?a=1&__rs=rs-1#top');
  });
});

describe('落点核对：无法证明打到各自版本时不得出对比结论（Codex PR #1273 P1）', () => {
  const metric = (
    memberId: string, label: string, servedBy: Record<string, number>, p95: number,
    servedGroups: Record<string, number> = {}, expectedGroup = 'b1:api',
  ) => ({
    memberId, label, servedBy, servedGroups, expectedGroup, requests: 100, p95, qps: 50, successRate: 1,
    min: 1, max: 9, avg: 5, p50: 4, p90: 8, p99: 9,
    errors: {} as never, series: [],
  }) as unknown as Parameters<typeof buildComparison>[0][number];

  it('落点各自对得上时照常出结论', () => {
    const c = buildComparison([
      metric('primary', '主实例', {}, 10),
      metric('rs-a', '版本 A', { 'rs-a': 100 }, 20),
    ])!;
    expect(c.routingVerified).toBe(true);
    expect(c.rows).toHaveLength(1);
  });

  it('事故值：两个落点被同一个实例服务时拒绝出结论（否则是拿同一版本跟自己比）', () => {
    const c = buildComparison([
      metric('primary', '主实例', { 'rs-a': 100 }, 10),
      metric('rs-a', '版本 A', { 'rs-a': 100 }, 20),
    ])!;
    expect(c.routingVerified).toBe(false);
    expect(c.rows).toHaveLength(0);
    expect(c.summary).toContain('不给出版本对比结论');
  });

  it('副本落点实际由别的副本服务时拒绝出结论', () => {
    const c = buildComparison([
      metric('primary', '主实例', {}, 10),
      metric('rs-a', '版本 A', { 'rs-b': 100 }, 20),
    ])!;
    expect(c.routingVerified).toBe(false);
    expect(String(c.routingIssue)).toContain('rs-b');
  });
});

describe('压测请求必须有挂钟死线（SSE 类端点不得永久占住全局槽位）', () => {
  it('defaultRequestFn 用 setTimeout 挂钟死线而不是只靠 socket 空闲超时', () => {
    const src = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../../src/services/replica-loadtest.ts'),
      'utf-8',
    );
    const fn = src.slice(src.indexOf('function defaultRequestFn'));
    expect(fn).toContain('wallClock = setTimeout');
    expect(fn).toContain('clearTimeout(wallClock)');
  });
});


describe('落点核对必须连副本组一起判（跨 profile 同名成员会撞，Codex PR #1273 P1）', () => {
  const m = (memberId: string, label: string, servedBy: Record<string, number>, servedGroups: Record<string, number>, expectedGroup: string) => ({
    memberId, label, servedBy, servedGroups, expectedGroup, requests: 100, p95: 10, qps: 50, successRate: 1,
    min: 1, max: 9, avg: 5, p50: 4, p90: 8, p99: 9, errors: {} as never, series: [],
  }) as unknown as Parameters<typeof buildComparison>[0][number];

  it('组对得上时照常出结论', () => {
    const c = buildComparison([
      m('primary', '主实例', {}, { 'b1:api': 100 }, 'b1:api'),
      m('rs-a', '版本 A', { 'rs-a': 100 }, { 'b1:api': 100 }, 'b1:api'),
    ])!;
    expect(c.routingVerified).toBe(true);
  });

  it('事故值：路径解析到了另一个 profile（组不符）时拒绝出结论，即使成员 id 看起来对', () => {
    const c = buildComparison([
      m('primary', '主实例', {}, { 'b1:web': 100 }, 'b1:api'),
      m('rs-a', '版本 A', { 'rs-a': 100 }, { 'b1:api': 100 }, 'b1:api'),
    ])!;
    expect(c.routingVerified).toBe(false);
    expect(String(c.routingIssue)).toContain('副本组');
    expect(c.rows).toHaveLength(0);
  });
});
