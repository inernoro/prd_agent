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
  bootRetryDelayMs, withBootRetry, diagnoseDiskForBootFailure, diagnoseDisksForBootFailure,
  bootRetryWindowMs, DEFAULT_BOOT_RETRY_ATTEMPTS,
} from '../../src/services/boot-retry.js';

describe('退避曲线', () => {
  it('指数增长并封顶', () => {
    expect(bootRetryDelayMs(1)).toBe(2_000);
    expect(bootRetryDelayMs(2)).toBe(4_000);
    expect(bootRetryDelayMs(3)).toBe(8_000);
    expect(bootRetryDelayMs(10)).toBe(30_000);
  });

  it('默认忍耐窗口就是注释承诺的 90s，不多不少（Codex 十轮 P2）', () => {
    // N 次尝试只有 N-1 段等待 —— 原先写 6 次实际只等 2+4+8+16+30 = 60s，
    // 比承诺少整整一段 30s。mongo 恰在那 30s 内恢复时 CDS 已经退出，
    // 正是本改动要消灭的 systemd 重启循环。这里用等号钉死，>= 挡不住这类漂移。
    let total = 0;
    for (let i = 1; i < DEFAULT_BOOT_RETRY_ATTEMPTS; i += 1) total += bootRetryDelayMs(i);
    expect(total).toBe(90_000);
    expect(bootRetryWindowMs()).toBe(90_000);
    expect(bootRetryWindowMs(6)).toBe(60_000); // 旧默认值的实际窗口，作对照
  });
});

/**
 * 磁盘诊断必须覆盖 **docker 数据根**（Codex 十轮 P2）。
 * mongo 的数据落在 docker 那侧，与仓库盘常不是同一个文件系统；2026-07-27
 * 撑爆的正是 containerd —— 只量仓库盘会让提示恰好在真凶场景下不出现。
 */
describe('多挂载点磁盘诊断', () => {
  const full = { totalBytes: 100e9, freeBytes: 1e9 };
  const roomy = { totalBytes: 100e9, freeBytes: 60e9 };

  it('仓库盘宽裕但 docker 盘满 → 仍然给出提示，并指明是哪个路径', () => {
    const hint = diagnoseDisksForBootFailure([
      { label: '/srv/repo', usage: roomy },
      { label: 'docker: /var/lib/docker', usage: full },
    ]);
    expect(hint).toBeTruthy();
    expect(hint).toContain('docker: /var/lib/docker');
    expect(hint).not.toContain('/srv/repo');
  });

  it('两个都满 → 都列出来', () => {
    const hint = diagnoseDisksForBootFailure([
      { label: '/srv/repo', usage: full },
      { label: 'docker: /var/lib/docker', usage: full },
    ]);
    expect(hint).toContain('/srv/repo');
    expect(hint).toContain('docker: /var/lib/docker');
  });

  it('都不满 → null，不误导排障方向', () => {
    expect(diagnoseDisksForBootFailure([
      { label: '/srv/repo', usage: roomy },
      { label: 'docker: /var/lib/docker', usage: roomy },
    ])).toBeNull();
  });

  it('读不到某个挂载点（null usage）不影响另一个的判定', () => {
    const hint = diagnoseDisksForBootFailure([
      { label: '/srv/repo', usage: null },
      { label: 'docker: /var/lib/docker', usage: full },
    ]);
    expect(hint).toContain('docker: /var/lib/docker');
  });

  it('启动失败路径必须真的量了 docker 数据根（结构契约）', () => {
    // 光有能力不够 —— index.ts 那两处失败诊断得真的调它。
    const src = readFileSync(new URL('../../src/index.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/function diagnoseBootDisks\(\)/);
    expect(src).toMatch(/resolveDockerDataRoot\(\)/);
    expect(src, '两处 storage 启动失败诊断都要走 diagnoseBootDisks')
      .not.toMatch(/diagnoseDiskForBootFailure\(defaultDiskUsage\(config\.repoRoot\)\)/);
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
