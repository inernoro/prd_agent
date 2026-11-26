import { designProgramEvidenceRequired, type DesignEntry, type DesignRule, type DesignRun, type DesignScreen, type DesignSlot, type DesignVersion } from './design-workspace.js';
import {
  designSceneCoverage, designVisualCheckStatus, designVisualKey, designVisualReference, designVisualRowForSlot, designVisualSlots,
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
export const designObjectiveMethods = [
  ...designMethods.slice(0, 3),
  ['regress', '历史易错', '以前出现过的问题这次是否复查通过', 'acceptance-test-design · flow-trace'],
  ...designMethods.slice(3),
] as const;
export type DesignMethodId = typeof designObjectiveMethods[number][0];
export type DesignAcceptancePlan = Partial<Record<DesignMethodId, { applicable?: boolean; enabled?: boolean; reason?: string }>>;
export type DesignMethodSetting = { enabled: boolean; by: { id: string; label: string }; at: string; reason?: string };
export type DesignMethodSettings = Partial<Record<DesignMethodId, DesignMethodSetting>>;
export type DesignEvidenceStatus = 'passed' | 'failed' | 'missing';
export type DesignMethodStatus = DesignEvidenceStatus | 'notrun' | 'not_applicable' | 'disabled';

type DesignIssueSource = { kind: 'defect' | 'ticket' | 'feedback'; ref: string; count: number };
export type DesignKnownIssue = { id: string; problem: string; sources: DesignIssueSource[]; how: string; check: string;
  screenIds: string[]; at: string; by: string };
export type DesignRegression = { status: DesignEvidenceStatus; evidence: string; by: string; at: string };
export type DesignCoverageRecord = { dimension: DesignDimension; risk: string; ruleIds: string[]; reason?: string; by?: string; at?: string };

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
  return designObjectivePlanEnabled(version) || version.acceptancePlan !== undefined
    || version.delivery?.files.some(file => file.path === '设计文档/验收手段.md') === true;
}

export function designObjectivePlanEnabled(version: DesignVersion) {
  return version.acceptanceMode === 'objective'
    || version.screens.some(screen => screen.id === 'dsn-accept-regress')
    // Early method plans stored an explicit enabled state before the acceptance mode was added.
    || Object.values(version.acceptancePlan ?? {}).some(method => typeof method?.enabled === 'boolean' && method.applicable === undefined);
}

const defaults = new Set<DesignMethodId>(['mece', 'compare', 'visual', 'regress']);

function designMethodSetting(version: DesignVersion, method: DesignMethodId, entry?: DesignEntry, run?: DesignRun) {
  const settings = run?.signed ? run.methodSettings : entry?.methodSettings?.[version.version];
  return settings?.[method];
}

function designMethodChoice(version: DesignVersion, method: DesignMethodId, entry?: DesignEntry, run?: DesignRun) {
  const setting = designMethodSetting(version, method, entry, run);
  if (setting) return setting.enabled ? 'enabled' : 'disabled';
  if (method === 'regress' && designKnownIssues(entry, version, run).length) return 'enabled';
  const plan = version.acceptancePlan?.[method];
  if (plan?.applicable === false) return 'not_applicable';
  if (!designObjectivePlanEnabled(version)) return 'enabled';
  const enabledByReview = run?.signed && run.enabledMethods ? run.enabledMethods : entry?.enabledMethods?.[version.version];
  if (enabledByReview?.includes(method)) return 'enabled';
  const enabled = plan?.enabled ?? plan?.applicable ?? defaults.has(method);
  return enabled ? 'enabled' : 'disabled';
}

export function designMethodApplicable(version: DesignVersion, method: DesignMethodId, entry?: DesignEntry, run?: DesignRun) {
  return designMethodChoice(version, method, entry, run) === 'enabled';
}

export function designRuleApplicable(version: DesignVersion, rule: DesignRule, entry?: DesignEntry, run?: DesignRun) {
  const programRule = designProgramEvidenceRequired(version)
    && (rule.id === 'A-70' && rule.expected?.includes('iPhone Safari')
      || rule.id === 'A-71' && rule.expected?.includes('证据只认程序产生'));
  return !designObjectivePlanEnabled(version) || rule.how === 'measure'
    || Boolean(programRule)
    || designMethodApplicable(version, rule.how === 'human' ? 'human' : 'compare', entry, run);
}

export function designMeasurementGap(version: DesignVersion, rule: DesignRule) {
  return rule.how === 'measure' && !rule.probe
    && (!designObjectivePlanEnabled(version) || !/检查\s*[:：]/u.test(rule.expected ?? ''));
}

export function designKnownIssues(entry: DesignEntry | undefined, version: DesignVersion, run?: DesignRun) {
  return (entry?.knownIssues ?? []).filter(issue => (!run?.signed || Object.hasOwn(run.regress ?? {}, issue.id))
    && (!issue.screenIds?.length || issue.screenIds.some(id => version.screens.some(screen => screen.id === id))));
}

export function designCoverage(version: DesignVersion, run?: DesignRun, entry?: DesignEntry) {
  const flows = designMethodApplicable(version, 'flow', entry, run) ? run?.flows ?? [] : [];
  const smoke = designMethodApplicable(version, 'smoke', entry, run) ? run?.smoke ?? [] : [];
  const hasScreens = version.screens.some(screen => designVisualSlots(screen).length);
  const visual = hasScreens ? designVisualStandard.filter(([id]) =>
    designMethodApplicable(version, 'visual', entry, run) || id === 'V-01' && designMethodApplicable(version, 'compare', entry, run)) : [];
  const ruleIds = new Set(version.acceptance.filter(rule => designRuleApplicable(version, rule, entry, run)).map(rule => rule.id));
  return (Object.entries(designDimensions) as [DesignDimension, string][]).map(([id, name]) => {
    const rules = version.acceptance.filter(rule => rule.dimension === id);
    const confirmed = run?.coverage?.[id];
    const declared = version.risks?.filter(risk => risk.dimension === id) ?? [];
    const records: DesignCoverageRecord[] = declared.length ? declared.map(risk =>
      confirmed?.risk === risk.risk && !confirmed.reason ? confirmed : risk)
      : confirmed ? [confirmed] : rules.length ? rules.map(rule => ({ dimension: id, risk: rule.rule, ruleIds: [rule.id] }))
        : [{ dimension: id, risk: '', ruleIds: [] }];
    const risks = records.map(risk => {
      const status = risk.ruleIds.length && risk.ruleIds.every(ref => ruleIds.has(ref)) ? 'passed'
        : !risk.ruleIds.length && risk.reason?.trim() ? 'not_applicable' : 'missing';
      return { ...risk, status } as const;
    });
    return { id, name, rules, risks, flows: flows.filter(flow => flow.dimension === id),
      smoke: smoke.filter(item => item.dimension === id), visual: visual.filter(([check]) => visualDimensions[check] === id) };
  });
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

export function designMethodVisualStatus(screen: DesignScreen, slot: DesignSlot, run?: DesignRun,
  sceneCoverage?: ReturnType<typeof designSceneCoverage>): DesignVisualStatus {
  if (!run) return 'unverified';
  const row = designVisualRowForSlot(screen, slot, run, sceneCoverage);
  const result = designEvidenceStatus(designVisualStandard.map(([id]) => designVisualCheckStatus(id, row?.checks[id])));
  return result === 'failed' || row?.imageId ? result : 'no_image';
}

function designMethodProgress(items: readonly (string | undefined)[]) {
  const passed = items.filter(item => item === 'passed' || item === 'not_applicable').length;
  const failed = items.filter(item => item === 'failed').length;
  return { total: items.length, passed, failed, done: passed + failed };
}

function comparisonEvidence(version: DesignVersion, screen: DesignScreen, slot: DesignSlot, run?: DesignRun) {
  const comparison = designComparisonStatus(version, screen, slot, run);
  const rules = version.acceptance.filter(rule => rule.how === 'screenshot' && rule.screenId === screen.id && rule.slots.includes(slot));
  return designEvidenceStatus([comparison, ...rules.map(rule => run?.cells.find(cell => cell.itemId === rule.id && cell.slot === slot)?.status ?? 'missing')]);
}

function objectiveProgress(version: DesignVersion, run: DesignRun | undefined, entry: DesignEntry | undefined,
  coverage: ReturnType<typeof designCoverage>) {
  const pairs = version.screens.flatMap(screen => designVisualSlots(screen).map(slot => comparisonEvidence(version, screen, slot, run)));
  const visual = designVisualBreakdown(version, run).map(({ counts }) =>
    counts.missing ? 'missing' : counts.failed ? 'failed' : counts.passed ? 'passed' : 'missing');
  const human = version.acceptance.filter(rule => rule.how === 'human').flatMap(rule => rule.slots.map(slot =>
    run?.cells.find(cell => cell.itemId === rule.id && cell.slot === slot)?.status));
  const gaps = version.acceptance.filter(rule => designMeasurementGap(version, rule) || run?.issues[rule.id]);
  const items: Record<DesignMethodId, Array<string | undefined>> = {
    mece: coverage.flatMap(dimension => dimension.risks.map(risk => risk.status)),
    compare: pairs,
    visual,
    regress: designKnownIssues(entry, version, run).map(issue => {
      const result = run?.regress?.[issue.id];
      return result?.evidence?.trim() ? result.status : 'missing';
    }),
    flow: (run?.flows ?? []).flatMap(flow => flow.steps.map(step => step.actual?.trim() ? step.status : 'missing')),
    human,
    smoke: (run?.smoke ?? []).map(item => item.actual?.trim() ? item.status : 'missing'),
    debt: gaps.map(rule => run?.issues[rule.id]?.pending === false ? 'passed' : 'missing'),
  };
  return items;
}

export function designMethodsState(version: DesignVersion, run?: DesignRun, entry?: DesignEntry) {
  const coverage = designCoverage(version, run, entry);
  const objective = designObjectivePlanEnabled(version);
  const items = objective ? objectiveProgress(version, run, entry, coverage) : undefined;
  const missingCoverage = coverage.filter(row => !(row.rules.length || row.flows.length || row.smoke.length || row.visual.length));
  const states: Record<DesignMethodId, DesignMethodStatus> = { mece: missingCoverage.length ? 'missing' : 'passed',
    compare: 'notrun', visual: 'notrun', regress: 'notrun', flow: 'notrun', human: 'notrun', smoke: 'notrun', debt: 'notrun' };
  if (run && !objective) {
    const sceneCoverage = designSceneCoverage(version, run);
    const pairs = version.screens.flatMap(screen => designVisualSlots(screen).map(slot => designComparisonStatus(version, screen, slot, run)));
    const visual = version.screens.flatMap(screen => designVisualSlots(screen).map(slot => designMethodVisualStatus(screen, slot, run, sceneCoverage)));
    states.compare = pairs.length ? designEvidenceStatus([...pairs, ...ruleEvidence(version, run, 'screenshot')]) : 'missing';
    states.visual = designEvidenceStatus(visual);
    const history = designKnownIssues(entry, version, run);
    if (history.length) states.regress = designEvidenceStatus(history.map(issue => {
      const result = run.regress?.[issue.id];
      return result?.evidence?.trim() ? result.status : 'missing';
    }));
    states.flow = designEvidenceStatus((run.flows ?? []).map(flow => flow.status));
    states.human = designEvidenceStatus(ruleEvidence(version, run, 'human'));
    states.smoke = designEvidenceStatus((run.smoke ?? []).map(item => item.status));
    states.debt = Object.keys(run.issues).length || version.acceptance.some(rule => rule.how === 'measure' && !rule.probe) ? 'missing' : 'passed';
  }
  const catalog = designObjectiveMethods.map(([id, name, purpose, skills]) => {
    const choice = designMethodChoice(version, id, entry, run);
    const progress = items ? designMethodProgress(items[id]) : undefined;
    let status: DesignMethodStatus = choice === 'enabled' ? states[id] : choice;
    if (choice === 'enabled' && progress) {
      const complete = progress.total > 0 && progress.total === progress.done;
      const noChecksNeeded = !progress.total && (id === 'regress' || id === 'debt');
      status = progress.failed ? 'failed' : complete || noChecksNeeded ? 'passed' : progress.done ? 'missing' : 'notrun';
    }
    const setting = designMethodSetting(version, id, entry, run);
    return { id, name, purpose, skills, status, progress, setting, reason: setting?.reason ?? version.acceptancePlan?.[id]?.reason };
  });
  // The full catalog is visible even on revisions governed by the earlier acceptance contract.
  const methods = objective ? catalog : catalog.filter(method => method.id !== 'regress');
  const displayMethods = catalog.map(method => {
    const awaitingRun = !run || method.id === 'flow' && !run.flows?.length || method.id === 'smoke' && !run.smoke?.length;
    const status = awaitingRun && (method.status === 'passed' || method.status === 'missing') ? 'notrun'
      : method.id === 'mece' && method.status === 'passed' && version.acceptance.some(rule => !rule.dimension) ? 'missing'
      : method.status;
    return { ...method, status, progress: awaitingRun ? undefined : method.progress };
  });
  const required = methods.filter(method => method.id !== 'debt' && method.status !== 'not_applicable' && method.status !== 'disabled');
  return { methods, displayMethods, required, coverage, objective, blockers: required.filter(method => method.status !== 'passed') };
}

export function designVisualBreakdown(version: DesignVersion, run?: DesignRun) {
  const sceneCoverage = designSceneCoverage(version, run);
  const rows = version.screens.flatMap(screen => designVisualSlots(screen).map(slot => ({
    screen, slot, entry: designVisualRowForSlot(screen, slot, run, sceneCoverage),
  })));
  return designVisualStandard.map(([id, name, how, criterion]) => {
    const counts: Record<DesignEvidenceStatus, number> = { passed: 0, failed: 0, missing: 0 };
    const issues: Array<{ screenId: string; screenName: string; slot: DesignSlot; evidence: string }> = [];
    const results = rows.map(({ screen, slot, entry }) => {
      const check = entry?.checks[id];
      const observed = designVisualCheckStatus(id, check);
      const status: DesignEvidenceStatus = observed === 'passed' && !entry?.imageId ? 'missing' : observed;
      counts[status]++;
      if (status === 'failed') issues.push({ screenId: screen.id, screenName: screen.name, slot, evidence: check!.evidence });
      return { screenId: screen.id, screenName: screen.name, slot, status, evidence: check?.evidence, imageId: entry?.imageId };
    });
    return { id, name, how, criterion, counts, issues, results };
  });
}
