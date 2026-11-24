import { describe, expect, it } from 'vitest';
import { designMethodsState, designRuleApplicable } from '../../src/shared/design-methods.js';
import { designSlots, type DesignEntry, type DesignRun, type DesignVersion } from '../../src/shared/design-workspace.js';

const version: DesignVersion = {
  version: 17, title: '验收回归', sourceCommit: 'a'.repeat(40), sha256: 'b'.repeat(64),
  prototypeId: 'prototype', createdAt: '2026-11-24T09:00:00Z', publisher: { id: 'designer', label: '设计' },
  acceptanceMode: 'objective',
  screens: [{ id: 'main', name: '列表', route: '#/list', viewport: 'desktop', themes: ['light'], impl: '/list' }],
  acceptance: [{ id: 'A-01', rule: '显示记录', how: 'measure', priority: 'high', slots: [designSlots[0]], screenId: 'main' }],
  rationale: '', spec: {}, tags: [], decisionIds: [], resolves: {},
};
const run: DesignRun = { id: 'RUN-1', version: 17, pullRequest: 1, commit: 'a'.repeat(40),
  createdAt: '2026-11-24T10:00:00Z', cells: [], verdict: 'needs_evidence', issues: {}, previewUrl: 'https://preview.test' };
const entry: DesignEntry = { id: 'DSN-1', projectId: 'sample', versions: [version], comments: [], runs: [run] };

describe('objective design methods', () => {
  it('enables only the baseline checks and keeps old plans readable', () => {
    const objective = designMethodsState(version, undefined, entry);
    expect(objective.required.map(method => method.id)).toEqual(['mece', 'compare', 'visual', 'regress']);
    expect(objective.methods.find(method => method.id === 'flow')?.status).toBe('disabled');
    expect(objective.methods.find(method => method.id === 'regress')?.status).toBe('passed');
    const old = designMethodsState({ ...version, acceptanceMode: undefined });
    expect(old.methods.map(method => method.id)).toEqual(['mece', 'compare', 'visual', 'flow', 'human', 'smoke', 'debt']);
    expect(old.required).toHaveLength(6);
  });

  it('recognizes the objective plan in a pre-mode-marker snapshot', () => {
    const snapshot = {
      ...version,
      acceptanceMode: undefined,
      acceptancePlan: { flow: { enabled: true }, human: { enabled: true } },
    } as unknown as DesignVersion;

    const state = designMethodsState(snapshot);
    expect(state.objective).toBe(true);
    expect(state.required.map(method => method.id)).toEqual(['mece', 'compare', 'visual', 'regress', 'flow', 'human']);
    expect(state.methods.find(method => method.id === 'smoke')?.status).toBe('disabled');
  });

  it.each([
    { applicable: true },
    { applicable: true, enabled: false },
  ])('preserves the legacy mode for an applicability declaration %o', flow => {
    const state = designMethodsState({
      ...version,
      acceptanceMode: undefined,
      acceptancePlan: { flow, smoke: { applicable: false, reason: '没有冒烟入口' } },
    });

    expect(state.objective).toBe(false);
    expect(state.required.map(method => method.id)).toEqual(['mece', 'compare', 'visual', 'flow', 'human']);
    expect(state.methods.find(method => method.id === 'smoke')?.status).toBe('not_applicable');
  });

  it('derives each flow step and keeps a requested method blocked until there is evidence', () => {
    const enabled = { ...entry, enabledMethods: { 17: ['flow' as const] } };
    expect(designMethodsState(version, run, enabled).blockers.map(method => method.id)).toContain('flow');
    const execution: DesignRun = { ...run, flows: [{ id: 'F-3', title: '筛选', dimension: 'correctness', by: '测试', at: run.createdAt,
      status: 'passed', role: '成员', steps: [
        { action: '打开列表', expected: '有列表', actual: '看到列表', status: 'passed' },
        { action: '切换筛选', expected: '按条件展示', actual: '未执行', status: 'missing' },
      ] }] };
    const summary = designMethodsState(version, execution, enabled);
    expect(summary.methods.find(method => method.id === 'flow')).toMatchObject({ status: 'missing', progress: { total: 2, done: 1, passed: 1, failed: 0 } });
    expect(summary.blockers.map(method => method.id)).toContain('flow');
  });

  it('reads pre-existing empty steps and smoke rows as pending evidence', () => {
    const enabled: DesignEntry = { ...entry, enabledMethods: { 17: ['flow', 'smoke'] } };
    const method = { id: 'M-1', title: '查看筛选', dimension: 'correctness' as const, by: '测试', at: run.createdAt, status: 'missing' as const };
    const former = { ...run, flows: [{ ...method, role: '成员', steps: [{ action: '打开', expected: '显示列表', status: 'missing' }] }],
      smoke: [{ ...method, path: '/list', target: 'page', expected: '有列表' }] } as DesignRun;
    const { methods } = designMethodsState(version, former, enabled);
    expect(methods.filter(row => row.id === 'flow' || row.id === 'smoke').map(row => row.progress?.done)).toEqual([0, 0]);
  });

  it('does not infer risk coverage from names and verifies rule links', () => {
    const withoutMap = designMethodsState(version, run, entry);
    expect(withoutMap.methods[0]).toMatchObject({ id: 'mece', status: 'notrun', progress: { total: 6, done: 0 } });
    const covered = designMethodsState(version, { ...run, coverage: {
      correctness: { dimension: 'correctness', risk: '查询结果错位', ruleIds: ['A-01'] },
      compatibility: { dimension: 'compatibility', risk: '浏览器兼容', ruleIds: ['A-missing'] },
      operations: { dimension: 'operations', risk: '独立部署', ruleIds: [], reason: '此例无独立部署入口' },
    } }, entry);
    expect(covered.methods[0]).toMatchObject({ status: 'missing', progress: { total: 6, done: 2 } });
    expect(covered.coverage.find(row => row.id === 'compatibility')?.risks[0].status).toBe('missing');
    expect(covered.coverage.find(row => row.id === 'operations')?.risks[0].status).toBe('not_applicable');
  });

  it('does not claim coverage from an unselected rule or a declaration from a later run', () => {
    const manual = { ...version.acceptance[0], id: 'A-02', how: 'human' as const };
    const release = { ...version, acceptance: [...version.acceptance, manual],
      risks: [{ dimension: 'security' as const, risk: '权限误发', ruleIds: [manual.id] }] };
    const enabled: DesignEntry = { ...entry, enabledMethods: { 17: ['human'] } };
    const signedBeforeEnable: DesignRun = { ...run, enabledMethods: [], signed: { by: '测试', at: run.createdAt, verdict: 'passed' } };
    const status = (e: DesignEntry, r: DesignRun) => designMethodsState(release, r, e).coverage.find(row => row.id === 'security')?.risks[0].status;
    expect(status(entry, run)).toBe('missing');
    expect(status(enabled, run)).toBe('passed');
    expect(status(enabled, signedBeforeEnable)).toBe('missing');
    expect(designRuleApplicable(release, manual, enabled, signedBeforeEnable)).toBe(false);
  });

  it('keeps scoped known defects mandatory across fresh runs without retroactively changing a signed run', () => {
    const project: DesignEntry = { ...entry, knownIssues: [
      { id: 'K-01', problem: '滚动条重叠', sources: [{ kind: 'defect', ref: 'BUG-1', count: 2 }],
        how: '测量', check: '横向宽度不大于容器', screenIds: ['main'], at: run.createdAt, by: '评审' },
      { id: 'K-02', problem: '其他模块加载慢', sources: [{ kind: 'ticket', ref: 'BUG-2', count: 1 }],
        how: '计时', check: '1 秒内', screenIds: ['other'], at: run.createdAt, by: '评审' },
      { id: 'K-03', problem: '后发现的缺陷', sources: [{ kind: 'feedback', ref: 'FDB-3', count: 1 }],
        how: '目测', check: '高亮定位', screenIds: [], at: '2026-11-25T10:00:00Z', by: '评审' },
    ] };
    const results = { 'K-01': { status: 'passed' as const, evidence: '窗口宽 1024，文档宽 1024', by: '评审', at: run.createdAt } };
    const find = (value: DesignRun) => designMethodsState(version, value, project).methods.find(method => method.id === 'regress');
    expect(find({ ...run, regress: results })).toMatchObject({ status: 'missing', progress: { total: 2, done: 1 } });
    expect(find({ ...run, regress: results, signed: { by: '评审', at: '2026-11-24T15:00:00Z', verdict: 'passed' } }))
      .toMatchObject({ status: 'passed', progress: { total: 1, done: 1 } });
    expect(find({ ...run, id: 'RUN-2' })).toMatchObject({ status: 'notrun', progress: { total: 2, done: 0 } });
  });
});
