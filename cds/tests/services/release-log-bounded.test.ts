import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StateService } from '../../src/services/state.js';
import {
  buildReleaseLogSnapshot,
  resolveReleaseFirstEventSeq,
  shouldPersistReleaseLog,
  RELEASE_MAX_LOGS,
} from '../../src/services/release-log-buffer.js';
import type { ReleaseRun } from '../../src/types.js';

/**
 * 发布日志有界 + 批量落盘回归（阶段三记账）。
 *
 * 事故值：
 *  - `appendReleaseRunLog` 每追加一行就 `save()` 一次 —— 灌 1200 行 = **1200 次全量落盘**。
 *    releaseRuns 属 global rest，每次落盘都要把全部 run 的全部日志整份序列化 /
 *    structuredClone，开销随已累积日志量增长，实际是平方级。
 *  - `ReleaseRun.logs` 没有任何上限，单次发布的 SSH 输出可以无界撑大 global 文档；
 *    唯一的截断发生在持久化层的应急压缩，且**不写任何标记**，续传客户端静默缺一段。
 *
 * 本套件把三件事钉成回归：条数上限 500、截断标记 firstEventSeq、落盘次数收敛。
 */

const BASE_AT = Date.parse('2026-07-28T10:00:00.000Z');

describe('发布日志有界与批量落盘', () => {
  let stateDir: string;
  let stateService: StateService;
  let saveCount = 0;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-release-log-'));
    stateService = new StateService(path.join(stateDir, 'state.json'));
    stateService.load();
    stateService.addProject({ id: 'p1', slug: 'p1', name: 'P1' } as never);
    stateService.addReleaseRun(seedRun());
    saveCount = 0;
    stateService.onSave(() => { saveCount += 1; });
  });

  afterEach(async () => {
    await stateService.flush();
    if (fs.existsSync(stateDir)) fs.rmSync(stateDir, { recursive: true, force: true });
  });

  function seedRun(): ReleaseRun {
    return {
      releaseId: 'rel_logs',
      projectId: 'p1',
      branchId: 'b1',
      commitSha: 'a'.repeat(40),
      artifact: { type: 'branch-preview', commitSha: 'a'.repeat(40), branchId: 'b1', branchName: 'main' },
      targetId: 'target-prod',
      planId: 'p1:ssh-script',
      status: 'running',
      startedAt: '2026-07-28T10:00:00.000Z',
      logs: [],
      seq: 0,
    };
  }

  /** at 用递增 1ms 的假时间：时间闸（1s）不会插手，落盘次数只由「攒够 50 行」决定。 */
  function pump(lines: number): void {
    for (let i = 0; i < lines; i += 1) {
      stateService.appendReleaseRunLog('rel_logs', {
        level: 'info',
        message: `line ${i + 1}`,
        phase: 'deploy',
        at: new Date(BASE_AT + i).toISOString(),
      });
    }
  }

  it('灌 1200 行：只保留最近 500 条，firstEventSeq 指向真实窗口头部', () => {
    pump(1200);
    const run = stateService.getReleaseRun('rel_logs')!;

    // 事故值：修复前 logs.length === 1200（无上限）。
    expect(run.logs.length).toBe(RELEASE_MAX_LOGS);
    expect(run.seq).toBe(1200);
    expect(run.logs[0].seq).toBe(701);
    expect(run.logs[run.logs.length - 1].seq).toBe(1200);
    expect(run.firstEventSeq).toBe(701);
  });

  it('灌 1200 行：落盘次数从 1200 收敛到攒批次数', () => {
    pump(1200);

    // 事故值：修复前每行一次 save()，saveCount === 1200。
    // 修复后按 50 行一批 → 24 次；这里留一点余量，但必须远小于行数。
    expect(saveCount).toBe(24);
    expect(saveCount).toBeLessThan(1200 / 10);
  });

  it('error 级日志不攒批，立刻落盘', () => {
    pump(3);
    const before = saveCount;
    stateService.appendReleaseRunLog('rel_logs', {
      level: 'error',
      message: '发布命令失败',
      phase: 'deploy',
      at: new Date(BASE_AT + 3).toISOString(),
    });
    // 失败证据是排障第一现场，进程若在这一刻挂掉，丢的恰好是最需要的那几行。
    expect(saveCount).toBe(before + 1);
  });

  it('攒批中的尾巴由 flushPendingReleaseLogs 兜底落盘', () => {
    pump(5);
    const before = saveCount;
    stateService.flushPendingReleaseLogs();
    expect(saveCount).toBe(before + 1);
    // 已经落过盘就不再空转写一次。
    stateService.flushPendingReleaseLogs();
    expect(saveCount).toBe(before + 1);
  });

  it('patchReleaseRun 不会把截断标记冲掉', () => {
    pump(600);
    const patched = stateService.patchReleaseRun('rel_logs', { status: 'success', firstEventSeq: undefined });
    expect(patched.logs.length).toBe(RELEASE_MAX_LOGS);
    expect(patched.firstEventSeq).toBe(101);
  });

  it('SSE 快照对已截断的续传位置如实报 truncated', () => {
    pump(1200);
    const run = stateService.getReleaseRun('rel_logs')!;

    // 客户端断在第 10 条，回来续传时窗口头部已经是 701 —— 中间那段真的没了。
    const stale = buildReleaseLogSnapshot(run, 10);
    expect(stale.truncated).toBe(true);
    expect(stale.firstEventSeq).toBe(701);
    expect(stale.logs[0].seq).toBe(701);

    // 断在窗口内则完整可续，不该误报截断。
    const fresh = buildReleaseLogSnapshot(run, 1100);
    expect(fresh.truncated).toBe(false);
    expect(fresh.logs.length).toBe(100);
  });
});

describe('release-log-buffer 纯函数判据', () => {
  it('存量 run 没有 firstEventSeq 字段时，截断标记从 logs[0].seq 推导', () => {
    // 被持久化层应急压缩过的历史 run：头部日志已被丢掉，却没有任何标记。
    // 若假设 firstEventSeq === 1 就会对客户端撒谎，说「你要的那段还在」。
    const legacy = { seq: 900, logs: [{ seq: 880, at: '', level: 'info' as const, message: 'x' }] };
    expect(resolveReleaseFirstEventSeq(legacy)).toBe(880);
    expect(buildReleaseLogSnapshot(legacy, 10).truncated).toBe(true);
  });

  it('日志为空的新 run 不报截断', () => {
    const fresh = { seq: 0, logs: [] };
    expect(buildReleaseLogSnapshot(fresh, 0).truncated).toBe(false);
  });

  it('落库字段与实际日志打架时以实际日志为准', () => {
    const lying = {
      seq: 900,
      firstEventSeq: 1,
      logs: [{ seq: 880, at: '', level: 'info' as const, message: 'x' }],
    };
    expect(resolveReleaseFirstEventSeq(lying)).toBe(880);
  });

  it('攒批闸：够行数 / 够时长 / error 三者任一放行', () => {
    const base = { pendingLines: 1, lastSaveAtMs: 1_000, nowMs: 1_100, level: 'info' as const };
    expect(shouldPersistReleaseLog(base)).toBe(false);
    expect(shouldPersistReleaseLog({ ...base, pendingLines: 50 })).toBe(true);
    expect(shouldPersistReleaseLog({ ...base, nowMs: 2_000 })).toBe(true);
    expect(shouldPersistReleaseLog({ ...base, level: 'error' })).toBe(true);
  });
});
