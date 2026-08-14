/**
 * 「自动发布规则」的匹配判据——分支满足条件时自动发到目标环境。
 *
 * 设计稿 design_handoff_release_center §4 要的是 `main → prod-main`、
 * `release/* → prod-eu`（手动批准）、`docs/** → docs-site`（仅文档变更）这一类
 * **事件驱动**规则；CDS 原有的自动发布只有 daily / interval / manual 三种**定时**
 * 调度，两者是不同的触发面，不是换个说法。
 *
 * 底座仍然复用 ScheduledJob：动作、并发、幂等、审批、失败回滚、运行记录全是现成的，
 * 这里只新增一种 schedule（`type: 'push'`）和它的匹配判据。**不另起一张表、不另起
 * 一个执行器**——那会立刻分裂成两套语义各自漂移。
 *
 * 判据是纯函数，全部可单测：webhook 那条路径难造，把「该不该触发」留在那里判，
 * 等于这段逻辑永远只能靠线上验证。
 */

import type { ScheduledJob, ScheduledJobSchedule } from '../types.js';

export type PushRuleEvent = 'push' | 'pr-open';

export type PushRuleSchedule = Extract<ScheduledJobSchedule, { type: 'push' }>;

/** 一次真实事件的上下文。changedPaths 为空表示「拿不到改动清单」，不是「没有改动」。 */
export interface PushRuleContext {
  projectId: string;
  branch: string;
  event: PushRuleEvent;
  changedPaths: string[];
}

/**
 * 定时驱动判据的**唯一来源**。
 *
 * 此前 scheduled-job-service 里有四处各写一遍 `schedule.type !== 'manual'`
 * （tick 取到期任务 / reconcile / claim / 算下一次）。新增 push 类型后，
 * 漏改任何一处都会让事件驱动的规则被定时器当成「立刻到期」反复执行——
 * 而且编译、类型、既有测试全都发现不了（predicate-and-wiring-discipline 形状 3）。
 */
export type TimerDrivenSchedule = Extract<ScheduledJobSchedule, { type: 'interval' | 'daily' }>;

export function isTimerDrivenSchedule(schedule: ScheduledJobSchedule): schedule is TimerDrivenSchedule {
  return schedule.type === 'interval' || schedule.type === 'daily';
}

export function isPushSchedule(schedule: ScheduledJobSchedule): schedule is PushRuleSchedule {
  return schedule.type === 'push';
}

/**
 * glob 匹配。只支持这三种，够覆盖分支名与路径前缀，且语义能一句话说清：
 *
 * - `*`  匹配任意个非 `/` 字符（`release/*` 命中 `release/1.2`，不命中 `release/a/b`）
 * - `**` 匹配任意字符，含 `/`（`docs/**` 命中 `docs/a/b.md`）
 * - 其余字符按字面匹配
 *
 * 刻意不支持 `?` / `[abc]` / `{a,b}`：多一种写法就多一类「用户以为会命中但没命中」的
 * 静默失败，而这条链路的失败后果是「该发的没发」——没有任何报错会告诉你。
 */
export function matchGlob(pattern: string, value: string): boolean {
  const trimmed = (pattern || '').trim();
  if (!trimmed) return false;
  // 逐段扫描，不用「先转义再回填」那种链式 replace：那种写法要引入一个占位字符，
  // 而任何占位字符都可能出现在用户真实的 pattern 里，撞上就静默错判。
  let source = '';
  for (let i = 0; i < trimmed.length; i += 1) {
    if (trimmed[i] === '*') {
      if (trimmed[i + 1] === '*') { source += '.*'; i += 1; } else { source += '[^/]*'; }
      continue;
    }
    source += trimmed[i].replace(/[.+?^${}()|[\]\\]/, '\\$&');
  }
  return new RegExp(`^${source}$`).test(value);
}

export interface PushRuleDecision {
  matched: boolean;
  /** 不匹配时说清为什么，直接进日志——「规则没触发」是最难排查的一类问题。 */
  reason: string;
}

/**
 * 这条规则该不该被这次事件触发。
 *
 * 路径过滤的两条边界都必须显式处理，否则会朝相反方向出错：
 * - 规则**没配**路径过滤 → 任何改动都触发（不看 changedPaths）；
 * - 规则**配了**路径过滤但这次拿不到改动清单（大 push 被 GitHub 截断、
 *   payload 里没有 commits）→ **不触发**，并说明原因。宁可漏发一次让人手动点，
 *   也不能因为「清单读不到」就把 docs-only 规则当成全量规则发上生产。
 */
export function evaluatePushRule(schedule: PushRuleSchedule, ctx: PushRuleContext): PushRuleDecision {
  if (schedule.event !== ctx.event) {
    return { matched: false, reason: `触发事件不符（规则要 ${schedule.event}，本次是 ${ctx.event}）` };
  }
  if (!matchGlob(schedule.branchPattern, ctx.branch)) {
    return { matched: false, reason: `分支不匹配（规则 ${schedule.branchPattern}，本次 ${ctx.branch}）` };
  }
  const pathPattern = (schedule.pathPattern || '').trim();
  if (!pathPattern) return { matched: true, reason: '分支匹配，未设路径过滤' };
  if (ctx.changedPaths.length === 0) {
    return { matched: false, reason: `规则设了路径过滤 ${pathPattern}，但本次拿不到改动清单，按不触发处理` };
  }
  const hit = ctx.changedPaths.filter((p) => matchGlob(pathPattern, p));
  if (hit.length === 0) {
    return { matched: false, reason: `没有改动命中 ${pathPattern}` };
  }
  return { matched: true, reason: `${hit.length} 个改动命中 ${pathPattern}` };
}

/**
 * 挑出本次事件该触发的规则。
 *
 * 停用的规则（`enabled === false`）一律跳过——设计稿里 `release/* → prod-eu` 那条
 * 就是「暂停」状态，暂停必须真的不发。
 */
export function selectPushRuleJobs(jobs: ScheduledJob[], ctx: PushRuleContext): ScheduledJob[] {
  return jobs.filter((job) => {
    if (job.projectId !== ctx.projectId) return false;
    if (!job.enabled) return false;
    if (!isPushSchedule(job.schedule)) return false;
    return evaluatePushRule(job.schedule, ctx).matched;
  });
}

/** 规则列表那一行的「触发条件」文案。UI 与日志共用，避免两处各写一版。 */
export function describePushRule(schedule: PushRuleSchedule, requireApproval: boolean): string {
  const bits: string[] = [schedule.event === 'pr-open' ? '开 PR 时' : '每次 push'];
  if (schedule.pathPattern) bits.push(`仅 ${schedule.pathPattern} 变更`);
  bits.push(requireApproval ? '需手动批准' : '自动发布');
  return bits.join(' · ');
}
