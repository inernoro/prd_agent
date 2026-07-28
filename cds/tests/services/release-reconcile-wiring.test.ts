/**
 * 发布中断收敛的启动 + 周期接线（阶段一 · 止血）。
 *
 * 背景：CDS 自更新/重启把在途发布的执行体带走后，ReleaseRun 永远停在 running，
 * 在途守卫会因此拒绝该目标的一切新发布——这个发布目标从此发不出去。分支部署那条
 * 链路早就有「启动收一轮 + 每 5 分钟收一轮」，发布这条一直没接。
 *
 * 这里钉两件事：
 *   1. 注入式：启动会立刻收一轮，之后按周期收；失败不许拖垮主流程；不叠加。
 *   2. 源码守卫：createServer 里真的调了它（否则上面全是死代码）。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  startReleaseRunReaper,
  RELEASE_RECONCILE_INTERVAL_MS,
  type ReleaseRunReconciler,
} from '../../src/server.js';

type Timer = { unref?: () => void };

/** 假定时器：手动触发 tick，避免测试等真实 5 分钟。 */
function fakeTimer() {
  const fns: Array<() => void> = [];
  let cleared = 0;
  let lastMs = 0;
  let unrefCalls = 0;
  return {
    setTimer: (fn: () => void, ms: number): Timer => {
      fns.push(fn);
      lastMs = ms;
      return { unref: () => { unrefCalls += 1; } };
    },
    clearTimer: () => { cleared += 1; },
    tick: () => { for (const fn of [...fns]) fn(); },
    get intervalMs() { return lastMs; },
    get cleared() { return cleared; },
    get unrefCalls() { return unrefCalls; },
  };
}

describe('startReleaseRunReaper — 注入式行为', () => {
  it('启动时立刻收一轮（重启正是执行体丢失的时刻，不能等满一个周期）', () => {
    let calls = 0;
    const timer = fakeTimer();
    startReleaseRunReaper({
      service: { reconcileInterruptedReleases: () => { calls += 1; return { reconciled: 0 }; } },
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
      log: () => {},
    });
    expect(calls).toBe(1);
  });

  it('之后按周期继续收，默认周期与部署侧同频（5 分钟）', () => {
    let calls = 0;
    const timer = fakeTimer();
    startReleaseRunReaper({
      service: { reconcileInterruptedReleases: () => { calls += 1; return { reconciled: 0 }; } },
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
      log: () => {},
    });
    timer.tick();
    timer.tick();
    expect(calls).toBe(3); // 1 次启动 + 2 次周期
    expect(timer.intervalMs).toBe(RELEASE_RECONCILE_INTERVAL_MS);
    expect(RELEASE_RECONCILE_INTERVAL_MS).toBe(5 * 60 * 1000);
  });

  it('定时器 unref，收割器不该把进程钉住不退出', () => {
    const timer = fakeTimer();
    startReleaseRunReaper({
      service: { reconcileInterruptedReleases: () => ({ reconciled: 0 }) },
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
      log: () => {},
    });
    expect(timer.unrefCalls).toBe(1);
  });

  it('收敛到东西时落一条可读的 warn（数量 + 目标已释放）', () => {
    const logs: string[] = [];
    const timer = fakeTimer();
    startReleaseRunReaper({
      service: { reconcileInterruptedReleases: () => ({ reconciled: 2 }) },
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
      log: (m) => logs.push(m),
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('2');
    expect(logs[0]).toContain('发布');
  });

  it('什么都没收敛时保持安静（不刷屏）', () => {
    const logs: string[] = [];
    const timer = fakeTimer();
    startReleaseRunReaper({
      service: { reconcileInterruptedReleases: () => ({ reconciled: 0 }) },
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
      log: (m) => logs.push(m),
    });
    timer.tick();
    expect(logs).toEqual([]);
  });

  it('同步抛错被吞掉：收割失败绝不拖垮主流程，但要留 warn', () => {
    const logs: string[] = [];
    const timer = fakeTimer();
    expect(() => startReleaseRunReaper({
      service: { reconcileInterruptedReleases: () => { throw new Error('mongo down'); } },
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
      log: (m) => logs.push(m),
    })).not.toThrow();
    expect(logs[0]).toContain('mongo down');
    // 抛错之后必须解除 busy，否则一次失败就把后续所有周期永久堵住
    expect(() => timer.tick()).not.toThrow();
    expect(logs).toHaveLength(2);
  });

  it('异步 reject 同样被吞掉并解除 busy（契约允许返回 Promise）', async () => {
    const logs: string[] = [];
    const timer = fakeTimer();
    let calls = 0;
    startReleaseRunReaper({
      service: {
        reconcileInterruptedReleases: () => { calls += 1; return Promise.reject(new Error('ssh timeout')); },
      },
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
      log: (m) => logs.push(m),
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(logs[0]).toContain('ssh timeout');
    timer.tick();
    expect(calls).toBe(2);
  });

  it('异步收敛结果也会被统计（返回 Promise 时的 reconciled 不丢）', async () => {
    const logs: string[] = [];
    const timer = fakeTimer();
    startReleaseRunReaper({
      service: { reconcileInterruptedReleases: async () => ({ reconciled: 3 }) },
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
      log: (m) => logs.push(m),
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(logs[0]).toContain('3');
  });

  it('上一轮没跑完就跳过这一轮（不叠加，同 build-gate 的重试纪律）', async () => {
    let calls = 0;
    let release: (() => void) | null = null;
    const timer = fakeTimer();
    startReleaseRunReaper({
      service: {
        reconcileInterruptedReleases: () => {
          calls += 1;
          return new Promise<{ reconciled: number }>((resolve) => {
            release = () => resolve({ reconciled: 0 });
          });
        },
      },
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
      log: () => {},
    });
    expect(calls).toBe(1);
    timer.tick();
    timer.tick();
    expect(calls).toBe(1); // 仍在途，后续 tick 被跳过
    release?.();
    await Promise.resolve();
    await Promise.resolve();
    timer.tick();
    expect(calls).toBe(2); // 落地后恢复正常
  });

  it('契约被改名/漏实现时出声报警，而不是静默不收割', () => {
    const logs: string[] = [];
    const timer = fakeTimer();
    const handle = startReleaseRunReaper({
      service: {} as unknown as ReleaseRunReconciler,
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
      log: (m) => logs.push(m),
    });
    expect(logs[0]).toContain('reconcileInterruptedReleases');
    expect(timer.intervalMs).toBe(0); // 没有排定期任务
    expect(() => handle.stop()).not.toThrow();
  });

  it('stop 会清掉定时器', () => {
    const timer = fakeTimer();
    const handle = startReleaseRunReaper({
      service: { reconcileInterruptedReleases: () => ({ reconciled: 0 }) },
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
      log: () => {},
    });
    handle.stop();
    expect(timer.cleared).toBe(1);
  });
});

describe('源码守卫：createServer 真的接了收割器', () => {
  const serverSrc = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '../../src/server.ts'),
    'utf8',
  );

  it('createServer 里调用了 startReleaseRunReaper（否则上面全是死代码）', () => {
    const createServerIdx = serverSrc.indexOf('export function createServer(');
    expect(createServerIdx).toBeGreaterThan(0);
    expect(serverSrc.slice(createServerIdx)).toContain('startReleaseRunReaper({');
  });

  it('收割器拿到的是真的 ReleaseService，不是空壳', () => {
    const createServerIdx = serverSrc.indexOf('export function createServer(');
    const body = serverSrc.slice(createServerIdx);
    expect(body).toContain('new ReleaseService(deps.stateService)');
    // 类型标注即契约：方法被改名会在编译期报错，而不是运行期静默不收割。
    expect(body).toMatch(/const releaseReconciler: ReleaseRunReconciler = new ReleaseService\(/);
  });
});

describe('API label 覆盖：releases 执行类端点（cds/CLAUDE.md §0.1）', () => {
  it('retry / cancel 都有中文 label，Activity Monitor 不显示裸 URL', async () => {
    const { resolveApiLabel } = await import('../../src/server.js');
    expect(resolveApiLabel('POST', '/releases/runs/rel_1/retry')).toBe('重试发布记录');
    expect(resolveApiLabel('POST', '/releases/runs/rel_1/cancel')).toBe('取消进行中发布');
  });

  it('既有 releases 端点的 label 不被新条目截胡', async () => {
    const { resolveApiLabel } = await import('../../src/server.js');
    expect(resolveApiLabel('POST', '/releases/runs/rel_1/rollback')).toBe('回滚发布记录');
    expect(resolveApiLabel('GET', '/releases/runs/rel_1')).toBe('查看发布记录');
    expect(resolveApiLabel('GET', '/releases/runs/rel_1/stream')).toBe('订阅发布日志流');
    expect(resolveApiLabel('GET', '/releases/runs')).toBe('列出发布记录');
  });

  it('auditApiLabels 口径（express 路由原样带 :id）同样有 label', async () => {
    const { resolveApiLabel } = await import('../../src/server.js');
    expect(resolveApiLabel('POST', '/releases/runs/:id/retry')).toBe('重试发布记录');
    expect(resolveApiLabel('POST', '/releases/runs/:id/cancel')).toBe('取消进行中发布');
  });

  it('带具体 id 的发布链路全都有 label，Activity Monitor 不出现裸 URL', async () => {
    const { resolveApiLabel } = await import('../../src/server.js');
    // 真实调用带的是具体 id；此前 releases 只有 staticMap 的 `:id` 条目，
    // 审计能过、线上却整条链路都是裸 URL。
    const cases: Array<[string, string, string]> = [
      ['POST', '/api/releases/projects/prd-agent/discover', '检测项目可用发布策略'],
      ['POST', '/api/releases/branches/prd-agent-main/preflight', '执行发布前检查'],
      ['POST', '/api/releases/branches/prd-agent-main/runs', '启动分支发布'],
      ['PATCH', '/api/releases/targets/tgt_1', '更新发布目标'],
      ['DELETE', '/api/releases/targets/tgt_1', '删除发布目标'],
      ['POST', '/api/releases/targets/tgt_1/archive', '归档发布目标并保留审计证据'],
    ];
    for (const [method, path, label] of cases) {
      expect(resolveApiLabel(method, path), `${method} ${path}`).toBe(label);
    }
  });

  it('本机生产发布目标（local-prod）不被 targets/:id 的 pattern 吞掉', async () => {
    const { resolveApiLabel } = await import('../../src/server.js');
    expect(resolveApiLabel('POST', '/releases/targets/local-prod')).toBe('创建本机生产发布目标');
  });
});
