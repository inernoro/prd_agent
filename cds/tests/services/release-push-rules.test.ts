import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  describePushRule,
  evaluatePushRule,
  isPushSchedule,
  isTimerDrivenSchedule,
  matchGlob,
  selectPushRuleJobs,
  type PushRuleSchedule,
} from '../../src/services/release-push-rules.js';
import type { ScheduledJob } from '../../src/types.js';

/**
 * 「自动发布规则」的判据。这条链路的失败模式全是**静默**的：
 * 规则没触发不会报错，规则误触发会往生产发一版——两头都只能靠判据在提交前拦住。
 */

function rule(overrides: Partial<PushRuleSchedule> = {}): PushRuleSchedule {
  return { type: 'push', branchPattern: 'main', event: 'push', ...overrides };
}

function job(overrides: Partial<ScheduledJob> = {}): ScheduledJob {
  return {
    id: overrides.id || 'j1',
    projectId: 'prd-agent',
    name: 'main → prod',
    enabled: true,
    schedule: rule(),
    timeoutSeconds: 600,
    retryCount: 0,
    concurrencyPolicy: 'skip',
    createdAt: '2026-08-14T00:00:00.000Z',
    updatedAt: '2026-08-14T00:00:00.000Z',
    ...overrides,
  };
}

describe('glob：只支持 * 与 **，语义要能一句话说清', () => {
  it('单星不跨斜杠，双星跨', () => {
    expect(matchGlob('release/*', 'release/1.2')).toBe(true);
    expect(matchGlob('release/*', 'release/a/b')).toBe(false);
    expect(matchGlob('feature/**', 'feature/a/b/c')).toBe(true);
    expect(matchGlob('docs/**', 'docs/guide/a.md')).toBe(true);
    expect(matchGlob('docs/**', 'src/a.ts')).toBe(false);
  });

  it('字面量精确匹配，不做前缀宽松', () => {
    expect(matchGlob('main', 'main')).toBe(true);
    expect(matchGlob('main', 'main-2')).toBe(false);
    expect(matchGlob('main', 'release/main')).toBe(false);
  });

  /** 正则元字符必须被转义，否则 `release.x` 会连 `releaseZx` 一起命中。 */
  it('正则元字符按字面处理', () => {
    expect(matchGlob('release.1', 'release.1')).toBe(true);
    expect(matchGlob('release.1', 'releaseX1')).toBe(false);
    expect(matchGlob('a+b', 'a+b')).toBe(true);
  });

  it('空 pattern 不匹配任何东西（不是匹配一切）', () => {
    expect(matchGlob('', 'main')).toBe(false);
    expect(matchGlob('   ', 'main')).toBe(false);
  });
});

describe('触发判据', () => {
  it('事件类型、分支都对才触发', () => {
    const ctx = { projectId: 'p', branch: 'main', event: 'push' as const, changedPaths: ['src/a.ts'] };
    expect(evaluatePushRule(rule(), ctx).matched).toBe(true);
    expect(evaluatePushRule(rule({ branchPattern: 'develop' }), ctx).matched).toBe(false);
    expect(evaluatePushRule(rule({ event: 'pr-open' }), ctx).matched).toBe(false);
  });

  it('没配路径过滤时不看改动清单', () => {
    const decision = evaluatePushRule(rule(), { projectId: 'p', branch: 'main', event: 'push', changedPaths: [] });
    expect(decision.matched).toBe(true);
  });

  it('配了路径过滤：命中才触发', () => {
    const schedule = rule({ branchPattern: 'main', pathPattern: 'docs/**' });
    expect(evaluatePushRule(schedule, { projectId: 'p', branch: 'main', event: 'push', changedPaths: ['docs/a.md', 'src/b.ts'] }).matched).toBe(true);
    expect(evaluatePushRule(schedule, { projectId: 'p', branch: 'main', event: 'push', changedPaths: ['src/b.ts'] }).matched).toBe(false);
  });

  /**
   * 最要紧的一条。GitHub 对大 push 会截断 commits，此时 changedPaths 是空的。
   * 若把「读不到清单」当成「没有路径过滤」，`docs/** → docs-site` 这类规则就会
   * 在一次纯代码的大 push 上触发——发错东西比漏发糟得多。
   */
  it('配了路径过滤但拿不到改动清单时不触发，并说明原因', () => {
    const decision = evaluatePushRule(
      rule({ pathPattern: 'docs/**' }),
      { projectId: 'p', branch: 'main', event: 'push', changedPaths: [] },
    );
    expect(decision.matched).toBe(false);
    expect(decision.reason).toContain('拿不到改动清单');
  });

  it('不匹配时都给得出原因，便于排查「为什么没发」', () => {
    for (const schedule of [rule({ branchPattern: 'develop' }), rule({ event: 'pr-open' }), rule({ pathPattern: 'docs/**' })]) {
      const decision = evaluatePushRule(schedule, { projectId: 'p', branch: 'main', event: 'push', changedPaths: ['src/a.ts'] });
      expect(decision.matched).toBe(false);
      expect(decision.reason.length).toBeGreaterThan(6);
    }
  });
});

describe('挑规则', () => {
  const ctx = { projectId: 'prd-agent', branch: 'main', event: 'push' as const, changedPaths: ['src/a.ts'] };

  it('暂停的规则真的不发', () => {
    expect(selectPushRuleJobs([job({ enabled: false })], ctx)).toHaveLength(0);
  });

  it('别的项目的规则不发', () => {
    expect(selectPushRuleJobs([job({ projectId: 'other' })], ctx)).toHaveLength(0);
  });

  it('定时任务不会被 push 事件带起来', () => {
    const timer = job({ id: 'timer', schedule: { type: 'daily', timeOfDay: '03:00' } });
    expect(selectPushRuleJobs([timer], ctx)).toHaveLength(0);
  });

  it('同一次 push 命中多条就都返回', () => {
    const jobs = [job({ id: 'a' }), job({ id: 'b', schedule: rule({ branchPattern: 'ma*' }) })];
    expect(selectPushRuleJobs(jobs, ctx).map((j) => j.id)).toEqual(['a', 'b']);
  });
});

describe('定时驱动判据是唯一的一份', () => {
  it('只有 interval / daily 参与定时轮询', () => {
    expect(isTimerDrivenSchedule({ type: 'interval', intervalMinutes: 5 })).toBe(true);
    expect(isTimerDrivenSchedule({ type: 'daily', timeOfDay: '03:00' })).toBe(true);
    expect(isTimerDrivenSchedule({ type: 'manual' })).toBe(false);
    expect(isTimerDrivenSchedule(rule())).toBe(false);
    expect(isPushSchedule(rule())).toBe(true);
  });

  /**
   * 这条判据此前散成四处 `type !== 'manual'`。漏改任何一处，push 规则都会被
   * 定时器当成「立刻到期」反复执行——编译、类型、既有测试全都发现不了
   * （predicate-and-wiring-discipline 形状 3）。
   */
  it('scheduled-job-service 里不许再出现第二份写法', () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), '../cds/src/services/scheduled-job-service.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/schedule\.type\s*[!=]==\s*'manual'/);
    expect(source).toContain('isTimerDrivenSchedule');
  });
});

describe('接线：规则必须真的被 webhook 叫得醒', () => {
  const read = (rel: string): string => fs.readFileSync(path.resolve(process.cwd(), '../cds', rel), 'utf8');

  /**
   * 整条链路任何一环没接上，规则都会「建得出、存得下、永远不触发」，
   * 而且页面上看不出任何异常（形状 2：链路只建到一半）。所以三段都钉住。
   */
  it('server → 路由 → dispatcher → 服务，四段都接上了', () => {
    expect(read('src/server.ts')).toContain('runPushRules: (ctx) => scheduledJobService.runPushRules(ctx)');
    expect(read('src/routes/github-webhook.ts')).toContain('runPushRules,');
    expect(read('src/services/github-webhook-dispatcher.ts')).toContain('this.deps.runPushRules({');
    expect(read('src/services/scheduled-job-service.ts')).toContain('async runPushRules(');
  });

  /**
   * 位置判据：docs-only push 会在 handlePush 里提前 return，
   * `docs/** → docs-site` 这类规则要的正好是那种 push。钩子放在 return 之后
   * 等于这类规则永不触发——而它恰恰是设计稿点名的五条示例之一。
   */
  it('钩子在 docs-only 提前 return 之前触发', () => {
    const source = read('src/services/github-webhook-dispatcher.ts');
    const hook = source.indexOf('this.deps.runPushRules({');
    const docsOnly = source.indexOf('const docsOnly = entry ?');
    expect(hook).toBeGreaterThan(0);
    expect(docsOnly).toBeGreaterThan(0);
    expect(hook, '钩子必须在 docs-only 判定之前，否则纯文档 push 的规则永不触发').toBeLessThan(docsOnly);
  });

  it('钩子不 await、不抛，webhook 不会被一次发布拖住或打断', () => {
    const source = read('src/services/github-webhook-dispatcher.ts');
    const at = source.indexOf('this.deps.runPushRules({');
    const window = source.slice(at - 40, at + 400);
    expect(window).toContain('void this.deps.runPushRules({');
    expect(window).toContain('.catch(');
    expect(window).not.toContain('await this.deps.runPushRules');
  });
});

describe('触发条件文案', () => {
  it('把规则读成一句人话', () => {
    expect(describePushRule(rule(), false)).toBe('每次 push · 自动发布');
    expect(describePushRule(rule({ event: 'pr-open' }), true)).toBe('开 PR 时 · 需手动批准');
    expect(describePushRule(rule({ pathPattern: 'docs/**' }), false)).toBe('每次 push · 仅 docs/** 变更 · 自动发布');
  });
});

/**
 * 来源分支的**归属**。这一条是自测时被真实 API 打回来才发现的：
 * 建规则时 `POST /api/scheduled-jobs` 报「动作 1: 来源分支必填」——
 * 因为定时规则要求绑定一个具体分支，而事件规则存的是 glob，发哪个分支
 * 只有事件发生时才知道。两边语义不同，判据必须分开。
 */
describe('事件规则的来源分支由事件决定，不是建规则时钉死的那一个', () => {
  const read = (rel: string): string => fs.readFileSync(path.resolve(process.cwd(), '../cds', rel), 'utf8');

  it('路由：push 规则允许留空来源分支，定时规则仍然必填', () => {
    const route = read('src/routes/scheduled-jobs.ts');
    expect(route).toContain('allowDeferredBranch');
    expect(route).toContain("allowDeferredBranch: schedule.type === 'push'");
    // 留空只在 push 下放行，其余仍然报错
    expect(route).toContain("if (ctx.allowDeferredBranch) return { kind: 'branch', branchId: '' };");
    expect(route).toContain("return { error: '来源分支必填' };");
  });

  it('执行：runPushRules 把事件里的真实分支带下去覆盖占位值', () => {
    const service = read('src/services/scheduled-job-service.ts');
    expect(service).toContain('findBranchByProjectAndName(ctx.projectId, ctx.branch)');
    expect(service).toContain("this.runJob(job.id, 'push', { overrideBranchId: branch.id })");
    expect(service).toContain('overrideBranchId?: string;');
    // 覆盖只作用于 branch 来源；promote 的语义与哪个分支被推无关
    expect(service).toContain("overrideBranchId && target.source.kind === 'branch'");
  });

  it('前端建规则时不填固定分支，避免 release/* 只发其中一个', () => {
    const ui = read('web/src/pages/release-center/AutoRulesSection.tsx');
    expect(ui).toContain("source: { kind: 'branch', branchId: '' }");
    expect(ui).not.toContain('latestRun?.branchId');
  });

  it('分支在 CDS 里还没有记录时不发，并说明原因', () => {
    const service = read('src/services/scheduled-job-service.ts');
    expect(service).toContain('该分支在 CDS 里还没有记录，本次不发');
  });
});
