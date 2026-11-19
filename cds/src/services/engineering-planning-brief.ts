import type {
  PlanningBriefCitation, PlanningBriefTarget, PlanningDebt, PlanningDebtBrief, PlanningDecision, PlanningEvent, PlanningPlan,
} from '../shared/engineering-planning.js';
import { planningToday, unpaid } from './engineering-planning-domain.js';

type Section = PlanningDebtBrief['sections'][number];
type Line = Section['lines'][number];
const historyLabels: Partial<Record<PlanningEvent['type'], string>> = {
  updated: '调整预计偿还日期', deferred: '暂缓', started: '开始处理', progress: '处理进展', repaid: '曾登记偿还', reopened: '复发重开',
  dropped: '失效', extinct: '随功能消失', branch_moved: '调整决策归属',
};
const approachLabels = { candidate: '候选', tried: '试过', rejected: '否决' } as const;
const day = 86_400_000;

function excerpt(text: string) {
  const content = text.replace(/\s+/gu, ' ').trim();
  return content.length > 220 ? `${content.slice(0, 220)}…` : content;
}
const fact = (text: string, ...cites: PlanningBriefCitation[]): Line => ({ kind: 'fact', text, cites });
const gap = (text: string): Line => ({ kind: 'gap', text, cites: [] });

function markdownText(text: string) {
  return text.replace(/\s+/gu, ' ').replace(/[\\`*_\[\]<>]/gu, character => `\\${character}`);
}

export function buildDebtBrief(debt: PlanningDebt, events: PlanningEvent[],
  related: { origin?: PlanningDecision; current?: PlanningDecision; plans: PlanningPlan[] }, now: Date): PlanningDebtBrief {
  const record = (label: string, target: PlanningBriefTarget = 'context'): PlanningBriefCitation =>
    ({ kind: 'record', id: debt.id, label, target });
  const fromEvent = (event: PlanningEvent): PlanningBriefCitation =>
    ({ kind: 'event', id: event.id, label: `${planningToday(new Date(event.at))} ${historyLabels[event.type] ?? '再次遇到'}` });
  const fromDecision = (decision: PlanningDecision): PlanningBriefCitation =>
    ({ kind: 'decision', id: decision.id, label: decision.source.type === 'adr' ? decision.source.ref : decision.id });
  const context = record('债务上下文');
  const hit = events.find(event => event.type === 'hit');
  const reopened = events.find(event => event.type === 'reopened');
  const active = unpaid(debt);
  const today = planningToday(now);
  const hitDate = hit && planningToday(new Date(hit.at));
  const confirmedRecently = active && hit && hitDate && hitDate <= today && (!reopened || events.indexOf(hit) < events.indexOf(reopened)) &&
    Date.parse(today) - Date.parse(hitDate) < 30 * day;
  const items = [
    { label: '问题和影响写清楚', ok: Boolean(debt.summary && debt.impact), next: '补充问题概况和实际影响。' },
    { label: '来源可追溯', ok: Boolean(debt.source.ref), next: '补充可追溯的发现来源。' },
    { label: '根因已确认', ok: debt.rootCause?.state === 'confirmed' && Boolean(debt.rootCause.text && debt.rootCause.basis), next: '定位并确认根因，补充依据。' },
    { label: '记录欠债时的取舍', ok: Boolean(debt.whyDebt), next: '补充当时接受债务的理由。' },
    { label: '记录期望方向', ok: Boolean(debt.direction?.target), next: '补充希望达成的结果和候选方案。' },
    { label: '有偿还标准', ok: debt.criteria.length > 0, next: '补充可以逐条核对的偿还标准。' },
    active ? { label: '近 30 天有再次遇到记录', ok: Boolean(confirmedRecently), next: '亲自确认问题是否仍存在，按实记录。' }
      : { label: '有可追溯的关闭依据', ok: Boolean(debt.repayment?.evidence.length || debt.outcome?.reason), next: '核对关闭依据。' },
  ];
  const missing = items.filter(item => !item.ok);

  const problem: Line[] = [
    debt.summary ? fact(excerpt(debt.summary), context) : gap('尚未记录问题概况。'),
    debt.impact ? fact(`影响 · ${excerpt(debt.impact)}`, context) : gap('尚未记录实际影响。'),
  ];
  if (debt.source.ref) problem.push(fact(`发现来源 · ${excerpt(debt.source.ref)}`, record('发现来源')));
  if (hit && hitDate) problem.push(fact(`${hitDate} 有再次遇到的记录${hit.note ? ` · ${excerpt(hit.note)}` : ''}`, fromEvent(hit)));
  if (debt.rootCause?.state === 'confirmed' && debt.rootCause.text && debt.rootCause.basis) {
    problem.push(fact(`根因 · ${excerpt(debt.rootCause.text)}。依据 · ${excerpt(debt.rootCause.basis)}`, context));
  } else if (debt.rootCause?.state === 'suspected' && debt.rootCause.text) {
    problem.push({ kind: 'inference', text: `记录中的根因推测 · ${excerpt(debt.rootCause.text)}`, cites: [context] });
  } else problem.push(gap('根因尚未确认。'));

  const recent = events.filter(event => event.type === 'updated' ? event.dates?.dueAt : historyLabels[event.type]).slice(0, 5);
  const previousRepayment = events.find(event => event.type === 'repaid');
  for (const event of [reopened, previousRepayment]) if (event && !recent.includes(event)) recent.push(event);
  const attempts = recent.map(event => {
    const date = (event.dates?.reviewAt ?? event.dates?.dueAt)?.map(value => value ?? '未设置').join(' → ');
    return fact(`${historyLabels[event.type]}${event.note ? ` · ${excerpt(event.note)}` : ''}${date ? ` · 日期 ${date}` : ''}`, fromEvent(event));
  });
  for (const approach of debt.direction?.approaches ?? []) {
    if (approach.status !== 'candidate') attempts.push(fact(`${approachLabels[approach.status]} · ${excerpt(approach.title)}${approach.note ? ` · ${excerpt(approach.note)}` : ''}`, context));
  }
  if (!attempts.length) attempts.push(gap('尚未记录处理尝试。'));

  const why = [debt.whyDebt ? fact(`当时的取舍 · ${excerpt(debt.whyDebt)}`, context) : gap('尚未记录欠债理由。')];
  if (related.origin) why.push(fact(`来源决策 · ${excerpt(related.origin.title)}`, fromDecision(related.origin)));
  if (debt.outcome) why.push(fact(`关闭依据 · ${excerpt(debt.outcome.reason)}`, record('关闭依据', 'outcome')));

  const direction = [debt.direction?.target ? fact(`期望方向 · ${excerpt(debt.direction.target)}`, context) : gap('尚未记录期望方向。')];
  for (const approach of debt.direction?.approaches ?? []) {
    if (approach.status === 'candidate') direction.push(fact(`候选方案 · ${excerpt(approach.title)}${approach.note ? ` · ${excerpt(approach.note)}` : ''}`, context));
  }
  if (debt.dueAt) direction.push(fact(`预计偿还 · ${debt.dueAt}`, record('预计偿还', 'header')));
  if (debt.trigger) direction.push(fact(`偿还触发条件 · ${excerpt(debt.trigger)}`, context));
  if (related.current && related.current.id !== related.origin?.id) direction.push(fact(`承接决策 · ${excerpt(related.current.title)}`, fromDecision(related.current)));
  for (const plan of related.plans) direction.push(fact(`已排入落地计划 · ${excerpt(plan.title)}`, { kind: 'plan', id: plan.id, label: plan.id }));
  if (debt.criteria.length) {
    direction.push(fact(`还清的样子 · ${excerpt(debt.criteria.map(criterion => criterion.text).join('。'))}`, record('偿还标准', 'criteria')));
  } else direction.push(gap('尚未登记偿还标准。'));

  const sections: Section[] = [
    { id: 'problem', title: '现在是什么问题', lines: problem },
    { id: 'attempts', title: '之前怎么处理过，为什么没解决', lines: attempts },
    { id: 'why', title: '为什么留到现在', lines: why },
    { id: 'direction', title: '期望往哪个方向走', lines: direction },
  ];
  const next = active ? (missing.length ? missing.slice(0, 2).map(item => item.next) : ['按偿还标准核对结果并登记证据。']) : [];
  const gaps = missing.map(item => item.label);
  const readiness = { score: items.length - gaps.length, max: items.length, items: items.map(({ label, ok }) => ({ label, ok })) };
  const kinds = { fact: '', inference: '【推测】', gap: '【缺口】' };
  const markdown = [
    `# ${debt.id} ${markdownText(debt.title)}`,
    `接手就绪度 ${readiness.score}/${readiness.max}`,
    ...sections.map(section => [`## ${section.title}`, ...section.lines.map(line => {
      const refs = line.cites.map(cite => `${markdownText(cite.label)} · ${cite.id}`).join('、');
      return `- ${kinds[line.kind]}${markdownText(line.text)}${refs ? `（出处 ${refs}）` : ''}`;
    })].join('\n')),
    ...(next.length ? [`## 建议的下一步\n${next.map(line => `- ${line}`).join('\n')}`] : []),
    ...(gaps.length ? [`## 记录缺口\n${gaps.map(label => `- ${label}`).join('\n')}`] : []),
  ].join('\n\n');
  return { readiness, sections, next, gaps, markdown };
}
