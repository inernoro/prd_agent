/*
 * 守卫：自更新的「重启前等待」必须可见，restartStatus 只有一处判定。
 *
 * 2026-09-16 两次自更新：记录 success、cdscli 报 restarted:true、self status 说 incomplete，
 * 其实都在等在途部署排空（最多 5 分钟），只是这段等待对谁都不可见。
 * 四组用例：判定矩阵；人话文案；三条重启路由都把进度接上了；cdscli 只在确认换进程后才报完成。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  describeRestartWait,
  getRestartWait,
  resolveRestartStatus,
  setRestartWait,
  type RestartWaitState,
} from '../../src/services/self-restart-wait.js';

const T0 = '2026-09-16T08:16:46.000Z';
const before = '2026-09-16T08:10:00.000Z';
const after = '2026-09-16T08:21:58.000Z';
const success = { status: 'success', updateMode: 'restart', ts: T0 };
const wait = (over: Partial<RestartWaitState> = {}): RestartWaitState => ({
  source: 'api.self-update', phase: 'draining-deploys', since: 0, waitedMs: 65_000, timeoutMs: 300_000, pendingRuns: ['dr_a', 'dr_b'], ...over,
});

afterEach(() => setRestartWait(null));

describe('restartStatus 判定矩阵', () => {
  it('正在等待（排空 / 落盘 / 换进程）→ pending，不管上一条记录怎么写', () => {
    expect(resolveRestartStatus({ activeSelfUpdate: null, restartWait: wait(), lastSelfUpdate: success, daemonReadyAt: null, pidStartedAt: before })).toBe('pending');
    expect(resolveRestartStatus({ activeSelfUpdate: null, restartWait: wait({ phase: 'spawning' }), lastSelfUpdate: success, daemonReadyAt: null, pidStartedAt: before })).toBe('pending');
  });

  it('自更新还在跑 → pending', () => {
    expect(resolveRestartStatus({ activeSelfUpdate: { id: 'x' }, restartWait: null, lastSelfUpdate: null, daemonReadyAt: null, pidStartedAt: before })).toBe('pending');
  });

  it('记录 success 且进程晚于记录时刻 → completed（pid 或 daemonReadyAt 任一成立）', () => {
    expect(resolveRestartStatus({ activeSelfUpdate: null, restartWait: null, lastSelfUpdate: success, daemonReadyAt: null, pidStartedAt: after })).toBe('completed');
    expect(resolveRestartStatus({ activeSelfUpdate: null, restartWait: null, lastSelfUpdate: success, daemonReadyAt: after, pidStartedAt: before })).toBe('completed');
  });

  it('记录 success 但进程仍是更新前那个 → incomplete（真的没换）', () => {
    expect(resolveRestartStatus({ activeSelfUpdate: null, restartWait: null, lastSelfUpdate: success, daemonReadyAt: before, pidStartedAt: before })).toBe('incomplete');
    expect(resolveRestartStatus({ activeSelfUpdate: null, restartWait: null, lastSelfUpdate: success, daemonReadyAt: null, pidStartedAt: null })).toBe('incomplete');
  });

  it('web-only 更新 / 失败记录 / 没有记录 → not_required', () => {
    expect(resolveRestartStatus({ activeSelfUpdate: null, restartWait: null, lastSelfUpdate: { ...success, updateMode: 'web-only' }, daemonReadyAt: null, pidStartedAt: before })).toBe('not_required');
    expect(resolveRestartStatus({ activeSelfUpdate: null, restartWait: null, lastSelfUpdate: { ...success, status: 'failed' }, daemonReadyAt: null, pidStartedAt: before })).toBe('not_required');
    expect(resolveRestartStatus({ activeSelfUpdate: null, restartWait: null, lastSelfUpdate: null, daemonReadyAt: null, pidStartedAt: before })).toBe('not_required');
  });

  it('等待状态是进程内单例：set 了就能 get，清掉就没了', () => {
    setRestartWait(wait());
    expect(getRestartWait()?.pendingRuns).toEqual(['dr_a', 'dr_b']);
    setRestartWait(null);
    expect(getRestartWait()).toBeNull();
  });
});

describe('等待文案：在等谁、等了多久、最多等多久', () => {
  it('排空阶段写出在途数量、已等秒数、上限，并说清超时会怎样', () => {
    const t = describeRestartWait(wait());
    expect(t).toContain('2 个在途部署');
    expect(t).toContain('已等 65s');
    expect(t).toContain('最多 300s');
    expect(t).toContain('超时会照常重启');
  });
  it('落盘与换进程阶段各有自己的话', () => {
    expect(describeRestartWait(wait({ phase: 'flushing', waitedMs: 70_000 }))).toContain('落盘');
    expect(describeRestartWait(wait({ phase: 'spawning' }))).toContain('换进程');
  });
});

describe('接线守卫', () => {
  const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
  const codeOf = (src: string): string => src.replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '').replace(/^\s*\/\/.*$/gm, '');
  const branches = codeOf(read('../../src/routes/branches.ts'));
  const cli = read('../../../.claude/skills/cds/cli/cdscli.py');
  const tab = codeOf(read('../../web/src/pages/cds-settings/tabs/MaintenanceTab.tsx'));

  it('restartStatus 只在 self-restart-wait.ts 判一次：路由里不再自己比 pid 与更新时刻', () => {
    expect(branches).toContain('resolveRestartStatus({');
    expect(branches).not.toMatch(/confirmedByPid\s*=/);
    expect(branches).toContain('restartWait,');
  });

  it('三条重启路由都把排空进度接到了 SSE（自更新 / 仅重启 / 强制同步）', () => {
    const sources = [...branches.matchAll(/source: '(api\.self-update|api\.self-restart|api\.self-force-sync)',\s*\n\s*onProgress:/g)].map((m) => m[1]);
    expect(sources.sort()).toEqual(['api.self-force-sync', 'api.self-restart', 'api.self-update']);
  });

  it('排空每一轮都把等待状态写进单例，换进程前进入 spawning，重启没生效时清掉', () => {
    expect(branches).toMatch(/onWait: \(pending, waitedMs\) => \{[\s\S]{0,400}setRestartWait\(state\)/);
    expect(branches).toMatch(/phase: 'spawning'/);
    expect(branches).toMatch(/endSelfUpdateDrain\(\);\s*setRestartWait\(null\);\s*console\.warn\('\[self-update\] 重启未生效/);
  });

  it('cdscli 以 restartStatus=completed 为准才报 restarted:true，不再靠 healthz 200', () => {
    expect(cli).toContain('rs == "completed"');
    expect(cli).toContain('"restarted": True');
    expect(cli).not.toContain('"restarted": not no_wait');
    expect(cli).toContain('/api/self-status');
  });

  it('维护页在 pending 时把等待文案摆成横幅', () => {
    expect(tab).toMatch(/restartStatus === 'pending' && data\.restartWait/);
    expect(tab).toContain('data.restartWait.message');
  });
});
