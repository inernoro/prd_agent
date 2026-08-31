import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  BRANCH_DELETE_CLEANUP_MARKER,
  hasBranchDeleteIntentReason,
  isAutoWakeEligible,
  isCdsInitiatedStop,
} from '../../src/services/branch-wake-eligibility.js';
import { hasBranchDeleteCleanupIntent } from '../../src/services/startup-reconcile.js';
import type { BranchEntry } from '../../src/types.js';

/**
 * 被动访问预览域名时「该不该自动拉起」的判定源。
 *
 * 由来（2026-08-30）：原判据只认 lastStopSource === 'scheduler'。线上 49 个分支里
 * 有 5 个容器都还在、一个 docker restart 就能起来，只因来源被记成 system / webhook
 * 被挡在门外，预览域名永久 503。其中 auto-lifecycle 那条停机文案写的原话就是
 * 「下次访问重建」——承诺从落地起没兑现过。
 */

const ROOT = resolve(__dirname, '../..');
const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8');

function branch(over: Partial<BranchEntry> = {}): BranchEntry {
  return {
    id: 'proj-feat-x',
    branch: 'feat/x',
    projectId: 'default',
    status: 'idle',
    services: { web: { profileId: 'web', containerName: 'c-web', hostPort: 30000, status: 'stopped' } },
    lastStopSource: 'scheduler',
    ...over,
  } as BranchEntry;
}

describe('停机来源分档', () => {
  // 十个取值一个不漏。新增取值时这张表会逼着人回答「它该不该被自动拉起」。
  const ALL: Array<NonNullable<BranchEntry['lastStopSource']>> = [
    'user', 'scheduler', 'executor', 'crash', 'oom', 'external', 'cds', 'webhook', 'ai', 'system',
  ];

  it.each(['scheduler', 'cds', 'system'] as const)('%s 是 CDS 自己的决定，放行', (source) => {
    expect(isCdsInitiatedStop(source)).toBe(true);
  });

  it.each(['user', 'executor', 'crash', 'oom', 'external', 'webhook', 'ai'] as const)(
    '%s 背后有主体意图或拉起来更糟，不放行',
    (source) => {
      expect(isCdsInitiatedStop(source)).toBe(false);
    },
  );

  it('十个取值全部被显式分过档，没有漏网的', () => {
    const judged = ALL.filter((s) => typeof isCdsInitiatedStop(s) === 'boolean');
    expect(judged).toHaveLength(ALL.length);
    // 放行档恰好三个——多一个都得先在这条测试里解释清楚。
    expect(ALL.filter(isCdsInitiatedStop).sort()).toEqual(['cds', 'scheduler', 'system']);
  });

  it('来源缺失（旧数据）不放行', () => {
    expect(isCdsInitiatedStop(undefined)).toBe(false);
  });
});

describe('isAutoWakeEligible', () => {
  it('调度器降温的分支可以拉起（原有行为不回退）', () => {
    expect(isAutoWakeEligible(branch({ lastStopSource: 'scheduler' }))).toBe(true);
  });

  it('auto-lifecycle 停的分支现在可以拉起——它的停机文案就写着「下次访问重建」', () => {
    const note = '项目设置：启动满 30 分钟，已切发布版并停止（release），下次访问重建';
    expect(isAutoWakeEligible(branch({ lastStopSource: 'system', lastStopReason: note }))).toBe(true);
    expect(isAutoWakeEligible(branch({ lastStopSource: 'cds', lastStopReason: 'CDS 生命周期策略触发停止' }))).toBe(true);
  });

  it.each(['user', 'ai', 'webhook', 'external', 'crash', 'oom'] as const)(
    '%s 停的分支不许被一次被动访问拉起',
    (source) => {
      expect(isAutoWakeEligible(branch({ lastStopSource: source }))).toBe(false);
    },
  );

  it('删除流程留下的停机一律不拉起——半路拉起来会和清理打架', () => {
    for (const source of ['system', 'cds', 'webhook'] as const) {
      const b = branch({ lastStopSource: source, lastStopReason: `${BRANCH_DELETE_CLEANUP_MARKER}，正在回收资源` });
      expect(isAutoWakeEligible(b), `${source} + 删除意图`).toBe(false);
    }
  });

  it('非 idle 状态不拉起（error 走诊断页，stopping 归删除链路）', () => {
    expect(isAutoWakeEligible(branch({ status: 'error' }))).toBe(false);
    expect(isAutoWakeEligible(branch({ status: 'stopping' }))).toBe(false);
    expect(isAutoWakeEligible(branch({ status: 'running' }))).toBe(false);
  });

  it('远端执行器持有的分支不拉起：本机 docker restart 是注定失败的空操作', () => {
    expect(isAutoWakeEligible(branch({ executorId: 'exec-1' }))).toBe(false);
  });

  it('从没成功部署过（没有已建服务）不拉起：restart 无物可重启', () => {
    expect(isAutoWakeEligible(branch({ services: {} }))).toBe(false);
  });
});

describe('删除意图判定只定义一次', () => {
  it('startup-reconcile 在共享判定之上只多加一条 status===stopping', () => {
    const reason = `${BRANCH_DELETE_CLEANUP_MARKER}，正在回收资源`;
    const stopping = branch({ status: 'stopping', lastStopSource: 'cds', lastStopReason: reason });
    const idle = branch({ status: 'idle', lastStopSource: 'cds', lastStopReason: reason });

    expect(hasBranchDeleteIntentReason(stopping)).toBe(true);
    expect(hasBranchDeleteIntentReason(idle)).toBe(true);
    expect(hasBranchDeleteCleanupIntent(stopping)).toBe(true);
    // 同一份理由，idle 时不属于「启动残渣清理」的处理范围，但仍然是删除意图。
    expect(hasBranchDeleteCleanupIntent(idle)).toBe(false);
  });

  it('删除标记全仓只有一处定义', () => {
    // 标记字符串抄第二份 = 改一处忘一处，删除链路和唤醒判据会各认各的。
    const hits = ['src/services/branch-wake-eligibility.ts', 'src/services/startup-reconcile.ts', 'src/services/proxy.ts', 'src/index.ts']
      .filter((rel) => read(rel).includes(`'${BRANCH_DELETE_CLEANUP_MARKER}'`));
    expect(hits).toEqual(['src/services/branch-wake-eligibility.ts']);
  });
});

describe('判据不许再分裂成两份（形状 3 守卫）', () => {
  // 原来 proxy.ts 与 index.ts 各写一份 lastStopSource 判断，两份都只认 'scheduler'。
  // 这条守卫钉住：两个调用点都消费同一个函数，谁也不许自己再判一次来源。
  it.each(['src/services/proxy.ts', 'src/index.ts'])('%s 消费共享判据且不自判来源', (rel) => {
    const src = read(rel);
    expect(src).toContain('isAutoWakeEligible');
    const code = src.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
    expect(code).not.toMatch(/lastStopSource\s*!==\s*'scheduler'/);
  });
});
