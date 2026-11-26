import type { PlanningDecision, PlanningPlan, PlanningPullRequest, PlanningStep } from '../../../../src/shared/engineering-planning';

const DAY = 86_400_000;
const planningDay = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' });
export const onDay = (value: string) => value.length === 10 ? value : planningDay.format(new Date(value));
export const daysSince = (value: string, today: string) => Math.floor((Date.parse(today) - Date.parse(onDay(value))) / DAY);

export function stepIsLate(step: PlanningStep, today: string) {
  return step.status !== 'done' && step.status !== 'cancelled' && Boolean(step.dueAt && step.dueAt < today);
}

export function planProgress(plan: PlanningPlan, today: string) {
  const steps = plan.steps.filter(step => step.status !== 'cancelled');
  const done = steps.filter(step => step.status === 'done').length;
  const total = steps.length;
  const late = steps.filter(step => stepIsLate(step, today)).length;
  const active = plan.steps.length > 0 ? done < total : true;
  const state: 'planned' | 'doing' | 'done' | 'cancelled' = !active ? (total ? 'done' : 'cancelled')
    : done || steps.some(step => step.status === 'doing') ? 'doing' : 'planned';
  return { done, total, late, active, state, percent: total ? Math.round(done * 100 / total) : 0 };
}

export function activePullRequests(decision: PlanningDecision) {
  return decision.pullRequests?.filter(pull => pull.state === 'open' || pull.state === 'draft') ?? [];
}

export function pullStallReasons(pull: Pick<PlanningPullRequest, 'state' | 'checks' | 'updatedAt'>, today: string) {
  if (pull.state !== 'open' && pull.state !== 'draft') return [];
  const idle = daysSince(pull.updatedAt, today);
  return [...(pull.checks === 'fail' ? ['检查失败'] : []), ...(idle >= 7 ? [`${idle} 天未更新`] : [])];
}

export function proposalIdleDays(decision: PlanningDecision, today: string) {
  return activePullRequests(decision).reduce((previous, pull) => Math.min(previous, daysSince(pull.updatedAt, today)),
    daysSince(decision.updatedAt, today));
}
