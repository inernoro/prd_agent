import type { DesignRun, DesignScreen, DesignSlot, DesignVersion } from './design-workspace.js';
import {
  designVisualCheckStatus, designVisualKey, designVisualReference, designVisualSlots,
  designVisualStandard, type DesignVisualCheckId, type DesignVisualStatus,
} from './design-visual.js';

export const designDimensions = {
  correctness: '正确性',
  compatibility: '兼容性',
  performance: '性能容量',
  security: '安全合规',
  operations: '运维部署',
  experience: '用户体验',
} as const;
export type DesignDimension = keyof typeof designDimensions;

export const designMethods = [
  ['mece', 'MECE 覆盖', '验收项有没有覆盖六个维度', 'risk-matrix · acceptance-test-design'],
  ['compare', '对照图', '实现和稿件逐画面是否一致', 'design-replication · cds-skeleton-review'],
  ['visual', '视觉', '位置、对齐、遮挡、深色和视口是否符合要求', 'create-visual-test-to-kb · issues-visual-run'],
  ['flow', '流程', '按角色走完关键任务，每一步结果是否正确', 'acceptance-scenario-orchestrator · flow-trace'],
  ['human', '人工', '需要人判断的验收项，按清单逐项核对', 'acceptance-checklist · human-verify'],
  ['smoke', '冒烟', '关键页面和接口能否正常打开和返回', 'smoke-test · stable-smoke'],
  ['debt', '验收债务', '哪些声明缺少测量方法，有哪些问题已记债', 'acceptance-debt-loop'],
] as const;
export type DesignMethodId = typeof designMethods[number][0];
export type DesignAcceptancePlan = Partial<Record<DesignMethodId, { applicable: boolean; reason?: string }>>;
export type DesignEvidenceStatus = 'passed' | 'failed' | 'missing';
export type DesignMethodStatus = DesignEvidenceStatus | 'notrun' | 'not_applicable';

type DesignMethodEvidence = { id: string; title: string; dimension: DesignDimension; by: string; at: string; status: DesignEvidenceStatus };
type DesignEvidenceResult = { expected: string; actual: string; status: DesignEvidenceStatus };
export type DesignFlow = DesignMethodEvidence & { role: string; steps: Array<DesignEvidenceResult & { action: string }> };
export type DesignSmoke = DesignMethodEvidence & DesignEvidenceResult & { target: 'page' | 'api'; path: string };

const visualDimensions: Record<DesignVisualCheckId, DesignDimension> = {
  'V-01': 'experience', 'V-02': 'experience', 'V-03': 'experience', 'V-04': 'compatibility',
  'V-05': 'security', 'V-06': 'correctness', 'V-07': 'experience', 'V-08': 'compatibility',
  'V-09': 'correctness', 'V-10': 'performance',
};

export function designMethodPlanEnabled(version: DesignVersion) {
  return version.acceptancePlan !== undefined || version.delivery?.files.some(file => file.path === '设计文档/验收手段.md') === true;
}

export function designMethodApplicable(version: DesignVersion, method: DesignMethodId) {
  return version.acceptancePlan?.[method]?.applicable !== false;
}

export function designCoverage(version: DesignVersion, run?: DesignRun) {
  const flows = designMethodApplicable(version, 'flow') ? run?.flows ?? [] : [];
  const smoke = designMethodApplicable(version, 'smoke') ? run?.smoke ?? [] : [];
  const hasScreens = version.screens.some(screen => designVisualSlots(screen).length);
  const visual = hasScreens ? designVisualStandard.filter(([id]) =>
    designMethodApplicable(version, 'visual') || id === 'V-01' && designMethodApplicable(version, 'compare')) : [];
  return (Object.entries(designDimensions) as [DesignDimension, string][]).map(([id, name]) => ({
    id, name,
    rules: version.acceptance.filter(rule => rule.dimension === id),
    flows: flows.filter(flow => flow.dimension === id),
    smoke: smoke.filter(item => item.dimension === id),
    visual: visual.filter(([check]) => visualDimensions[check] === id),
  }));
}

export function designEvidenceStatus(statuses: readonly string[]): DesignEvidenceStatus {
  if (statuses.includes('failed')) return 'failed';
  return statuses.length && statuses.every(status => status === 'passed') ? 'passed' : 'missing';
}

function ruleEvidence(version: DesignVersion, run: DesignRun, how: 'human' | 'screenshot') {
  const ids = new Set(version.acceptance.filter(rule => rule.how === how).map(rule => rule.id));
  return run.cells.filter(cell => ids.has(cell.itemId)).map(cell => cell.status);
}

export function designComparisonStatus(version: DesignVersion, screen: DesignScreen, slot: DesignSlot, run?: DesignRun): DesignVisualStatus {
  if (!run) return 'unverified';
  const entry = run.visual?.[designVisualKey(screen.id, slot)];
  const conclusion = designVisualCheckStatus('V-01', entry?.checks['V-01']);
  if (conclusion === 'failed') return 'failed';
  if (!entry?.imageId) return 'no_image';
  if (!designVisualReference(version, screen.id, slot, entry)) return 'no_reference';
  return conclusion;
}

export function designMethodVisualStatus(screen: DesignScreen, slot: DesignSlot, run?: DesignRun): DesignVisualStatus {
  if (!run) return 'unverified';
  const row = run.visual?.[designVisualKey(screen.id, slot)];
  const result = designEvidenceStatus(designVisualStandard.map(([id]) => designVisualCheckStatus(id, row?.checks[id])));
  return result === 'failed' || row?.imageId ? result : 'no_image';
}

export function designMethodsState(version: DesignVersion, run?: DesignRun) {
  const coverage = designCoverage(version, run);
  const missingCoverage = coverage.filter(row => !(row.rules.length || row.flows.length || row.smoke.length || row.visual.length));
  const states: Record<DesignMethodId, DesignMethodStatus> = { mece: missingCoverage.length ? 'missing' : 'passed',
    compare: 'notrun', visual: 'notrun', flow: 'notrun', human: 'notrun', smoke: 'notrun', debt: 'notrun' };
  if (run) {
    const pairs = version.screens.flatMap(screen => designVisualSlots(screen).map(slot => designComparisonStatus(version, screen, slot, run)));
    const visual = version.screens.flatMap(screen => designVisualSlots(screen).map(slot => designMethodVisualStatus(screen, slot, run)));
    states.compare = pairs.length ? designEvidenceStatus([...pairs, ...ruleEvidence(version, run, 'screenshot')]) : 'missing';
    states.visual = designEvidenceStatus(visual);
    states.flow = designEvidenceStatus((run.flows ?? []).map(flow => flow.status));
    states.human = designEvidenceStatus(ruleEvidence(version, run, 'human'));
    states.smoke = designEvidenceStatus((run.smoke ?? []).map(item => item.status));
    states.debt = Object.keys(run.issues).length || version.acceptance.some(rule => rule.how === 'measure' && !rule.probe) ? 'missing' : 'passed';
  }
  const methods = designMethods.map(([id, name, purpose, skills]) => ({
    id, name, purpose, skills, status: designMethodApplicable(version, id) ? states[id] : 'not_applicable' as const,
    reason: version.acceptancePlan?.[id]?.reason,
  }));
  const required = methods.filter(method => method.id !== 'debt' && method.status !== 'not_applicable');
  return { methods, required, coverage, blockers: required.filter(method => method.status !== 'passed') };
}

export function designVisualBreakdown(version: DesignVersion, run?: DesignRun) {
  const rows = version.screens.flatMap(screen => designVisualSlots(screen).map(slot => ({
    screen, slot, entry: run?.visual?.[designVisualKey(screen.id, slot)],
  })));
  return designVisualStandard.map(([id, name, how, criterion]) => {
    const counts: Record<DesignEvidenceStatus, number> = { passed: 0, failed: 0, missing: 0 };
    const issues: Array<{ screenId: string; screenName: string; slot: DesignSlot; evidence: string }> = [];
    for (const { screen, slot, entry } of rows) {
      const check = entry?.checks[id];
      const observed = designVisualCheckStatus(id, check);
      const status = observed === 'passed' && !entry?.imageId ? 'missing' : observed;
      counts[status]++;
      if (status === 'failed') issues.push({ screenId: screen.id, screenName: screen.name, slot, evidence: check!.evidence });
    }
    return { id, name, how, criterion, counts, issues };
  });
}
