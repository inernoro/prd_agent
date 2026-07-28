/**
 * 启动期关键依赖的重试与诊断（2026-07-27 宕机复盘 P1，事故本体）。
 *
 * 根盘写满 → CDS 自用 mongo 退出 → master 启动时 init 抛错 → 整个 boot 直接 throw
 * → 进程退出 → systemd 重启 → 再抛，restart counter 到 58，35 分钟全站 502。
 *
 * 这里钉两条：等得起（暂时性故障不该一次就死）、等不到也要退出（不静默降级到
 * 过期 JSON），外加「报错要指向真凶」。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  bootRetryDelayMs, withBootRetry, diagnoseDiskForBootFailure,
  DEFAULT_BOOT_RETRY_ATTEMPTS,
} from '../../src/services/boot-retry.js';

describe('退避曲线', () => {
  it('指数增长并封顶', () => {
    expect(bootRetryDelayMs(1)).toBe(2_000);
    expect(bootRetryDelayMs(2)).toBe(4_000);
    expect(bootRetryDelayMs(3)).toBe(8_000);
    expect(bootRetryDelayMs(10)).toBe(30_000);
  });

  it('默认忍耐窗口够覆盖一次容器重启（>= 60s）', () => {
    let total = 0;
    for (let i = 1; i < DEFAULT_BOOT_RETRY_ATTEMPTS; i += 1) total += bootRetryDelayMs(i);
    expect(total).toBeGreaterThanOrEqual(60_000);
  });
});

describe('withBootRetry', () => {
  const noSleep = async () => undefined;

  it('第一次就成功不重试', async () => {
    let calls = 0;
    const r = await withBootRetry(async () => { calls += 1; return 'ok'; }, { sleep: noSleep });
    expect(r).toBe('ok');
    expect(calls).toBe(1);
  });

  it('前几次失败、后面成功 → 返回成功（这正是「等一会儿就好」的场景）', async () => {
    let calls = 0;
    const r = await withBootRetry(async () => {
      calls += 1;
      if (calls < 3) throw new Error('connect ECONNREFUSED');
      return 'ok';
    }, { sleep: noSleep });
    expect(r).toBe('ok');
    expect(calls).toBe(3);
  });

  it('用尽重试仍失败 → 抛最后一次的错（该退出还是要退出，不静默降级）', async () => {
    let calls = 0;
    await expect(withBootRetry(async () => {
      calls += 1;
      throw new Error(`fail-${calls}`);
    }, { sleep: noSleep, attempts: 3 })).rejects.toThrow('fail-3');
    expect(calls).toBe(3);
  });

  it('每次失败都回调，便于把「在等什么」打进日志', async () => {
    const seen: number[] = [];
    await expect(withBootRetry(async () => { throw new Error('x'); }, {
      sleep: noSleep, attempts: 3, onAttemptFailed: (a) => seen.push(a),
    })).rejects.toThrow('x');
    expect(seen).toEqual([1, 2]); // 最后一次不再等待，直接抛
  });
});

describe('磁盘诊断', () => {
  it('满盘时直指真凶', () => {
    const hint = diagnoseDiskForBootFailure({ totalBytes: 100e9, freeBytes: 1e9 });
    expect(hint).toContain('磁盘');
    expect(hint).toContain('99%');
  });

  it('磁盘充裕时返回 null，不误导排障方向', () => {
    expect(diagnoseDiskForBootFailure({ totalBytes: 100e9, freeBytes: 60e9 })).toBeNull();
  });

  it('读不到磁盘信息时返回 null（不编造）', () => {
    expect(diagnoseDiskForBootFailure(null)).toBeNull();
    expect(diagnoseDiskForBootFailure({ totalBytes: 0, freeBytes: 0 })).toBeNull();
  });
});

/**
 * 鉴权连接也必须享受同一条启动退避（Codex PR #1275 七轮 P2）。
 *
 * 标准安装 `exec_cds.sh init` 同时开 `CDS_STORAGE_MODE=mongo-split` 与
 * `CDS_AUTH_BACKEND=mongo`，两者指向**同一个** mongo。此前只有 state store 包了
 * 重试，鉴权那条一次失败就 throw 退出：状态库连上之后 mongo 再抖一下，进程照样死，
 * 宣传的「约 90s 忍耐窗口」形同虚设。
 */
describe('鉴权连接的启动退避（契约）', () => {
  const src = readFileSync(new URL('../../src/index.ts', import.meta.url), 'utf8');

  it('initAuthStore 里的连接包在 withBootRetry 中', () => {
    const i = src.indexOf('async function initAuthStore()');
    expect(i).toBeGreaterThan(-1);
    const body = src.slice(i, i + 2400);
    expect(body).toContain('withBootRetry(');
    expect(body).toContain('new RealAuthMongoHandle(');
  });

  it('每次重试都新建 handle：连接失败的 handle 是半开的，复用它等于白重试', () => {
    const i = src.indexOf('async function initAuthStore()');
    const body = src.slice(i, i + 2400);
    // new 必须出现在 withBootRetry 的回调内部，而不是它之前
    const retryAt = body.indexOf('withBootRetry(');
    const newAt = body.indexOf('new RealAuthMongoHandle(');
    expect(newAt).toBeGreaterThan(retryAt);
  });

  it('等待定时器不 unref（同 state store：启动期没有别的 handle 撑事件循环）', () => {
    const i = src.indexOf('async function initAuthStore()');
    const body = src.slice(i, i + 2400);
    expect(body).toContain('setTimeout(r, ms)');
    expect(body).not.toContain('.unref');
  });
});
