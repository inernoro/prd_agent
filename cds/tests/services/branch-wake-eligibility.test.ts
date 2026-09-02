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

describe('【关键】项目暂停时，访问预览域名不许把它拉起来', () => {
  // Codex PR #1476 P1：项目暂停停分支带的是 X-CDS-Trigger: system，
  // 经 actor-resolver → state.ts 记成 lastStopSource='system'，正好落进
  // 「CDS 自己决定的」白名单。于是用户一访问预览域名，暂停的项目就自己活了，
  // 暂停要省的资源全回来，而且没人知道是谁开的。
  const pausedCandidate = branch({ status: 'idle', lastStopSource: 'system' });

  it('同一个分支：项目没暂停可以唤醒，暂停了就不行', () => {
    // 两条断言必须并排：只断言暂停不唤醒，把整个函数改成 return false 也会绿。
    expect(isAutoWakeEligible(pausedCandidate, { projectPaused: false })).toBe(true);
    expect(isAutoWakeEligible(pausedCandidate, { projectPaused: true })).toBe(false);
  });

  it('不传这个参数时保持既有行为（视为未暂停）', () => {
    expect(isAutoWakeEligible(pausedCandidate)).toBe(true);
  });

  it('暂停压倒所有来源分档，不是只挡 system', () => {
    for (const source of ['scheduler', 'cds', 'system'] as const) {
      const b = branch({ status: 'idle', lastStopSource: source });
      expect(isAutoWakeEligible(b, { projectPaused: false }), `${source} 未暂停应可唤醒`).toBe(true);
      expect(isAutoWakeEligible(b, { projectPaused: true }), `${source} 暂停中不得唤醒`).toBe(false);
    }
  });

  it('【关键】两个调用点都把项目暂停状态传进来了（形状 2：不传等于没修）', () => {
    // 上一版这条只查了 proxy.ts。判据是一份了（上面那条形状 3 守卫盯着），
    // 但**喂给它的料**有两处要喂，只喂一处等于 index.ts 那条复检对暂停完全不设防：
    // 暂停发生在「proxy 判完」与「复检执行」之间时照样把分支拉起来（Codex PR #1476 P1）。
    // 判据分裂治好了，接线只建一半又冒出来——所以这条必须逐个调用点都查。
    for (const rel of ['src/services/proxy.ts', 'src/index.ts']) {
      const code = read(rel).split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
      expect(code, `${rel} 应把 projectPaused 传给判据`).toMatch(/isAutoWakeEligible\(branch,\s*\{\s*projectPaused:/);
    }
  });

  it('【关键】唤醒跑到一半被暂停，落 running 之前还要再问一次', () => {
    // 入口判一次挡不住这条：暂停路由那次 stop 带的是 system 触发（优先级 10），
    // 打不过我们手上的 auto-restart 租约（35）被拒，而它 void fetch 不读响应。
    // 于是没人停得下来，最后是我们自己把分支标成 running——一个跑着的暂停项目。
    // 判据盯「再问一次」必须发生在标 running 之前，并且真的把容器停回去。
    const src = read('src/index.ts');
    const at = src.indexOf("proxyService.setOnReviveCooled");
    expect(at, '应有自动唤醒回调').toBeGreaterThan(0);
    const body = src.slice(at, src.indexOf('\n  });', at));
    const recheckAt = body.indexOf('if (isProjectPaused())');
    expect(recheckAt, '落 running 前应再问一次项目暂停状态').toBeGreaterThan(0);
    const runningAt = body.indexOf("branch.status = 'running'");
    expect(runningAt, '回调里应有标 running 的那一步').toBeGreaterThan(0);
    expect(runningAt, '复检必须排在标 running 之前').toBeGreaterThan(recheckAt);
    // 只是不标 running 不够：容器已经被我们拉起来了，得停回去，否则暂停项目照样在跑。
    const revert = body.slice(recheckAt, runningAt);
    expect(revert, '暂停时必须把刚拉起来的容器停回去').toMatch(/containerService\.stop\(/);
    expect(revert, '停回去要按 system 来源记账，与暂停路由那次 stop 同一档').toContain("lastStopSource = 'system'");
  });
});
