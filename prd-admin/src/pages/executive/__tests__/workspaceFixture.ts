import type { ExecutiveWorkspaceMember, TeamInsights } from '@/services/contracts/executive';
export function workspaceFixture(): TeamInsights {
  const member = (userId: string, displayName: string, hasActivity: boolean): ExecutiveWorkspaceMember => ({
    userId, displayName, role: 'DEV', avatarFileName: null, hasActivity,
    llmCalls: hasActivity ? 12 : 0, llmErrors: 0, pricedCalls: 0,
    docs: hasActivity ? 3 : 0, sites: 0, reports: 0,
    imagesDone: 0, imagesFailed: 0, defectsResolved: 0, defectsBacklog: 0,
    tokens: hasActivity ? 120 : 0, cost: 0, outputSeries: hasActivity ? [0, 2, 1] : [0, 0, 0],
  });
  return {
    headline: { text: '本窗 1 位成员有可统计产出', tone: 'neutral', basis: '窗口内文档创建记录', points: [], attentionCount: 1, criticalCount: 1 },
    pulse: [], members: [],
    attention: [{ key: 'defects-backlog', severity: 'critical', title: '2 个缺陷超过 7 天未关闭', evidence: '当前快照中有 2 个未关闭缺陷', suggestion: '确认负责人', linkLabel: '打开积压清单', linkTo: '/defect-agent' }],
    flow: { left: [], mid: [{ name: '视觉创作', value: 18, unit: '次', hint: '平台调用方统计' }], right: [] },
    meta: { days: 0, from: null, to: '2026-11-15T00:00:00Z', prevFrom: null, prevTo: null,
      totalMembers: 2, medians: { output: 0, quality: 0 }, benchmarks: { docs: 0, sites: 0, imageRuns: 0, reports: 0, defectsResolved: 0, llmCalls: 0 },
      quadrantCounts: {}, plottedMembers: 0, quadrantReliable: false, costAvailable: false, seriesAvailable: true, sources: [], unavailable: [{ metric: '采用率', reason: '未记录采用信号' }] },
    workspace: {
      summary: [{ key: 'members', label: '有产出或调用', value: 1, unit: '人', note: '人工账号口径' }, { key: 'calls', label: '模型调用', value: 12, unit: '次', note: '人工账号口径' }],
      groups: [{ id: 'real-team', name: '真实协作组', userIds: ['u1', 'u2'], totalMembers: 2, activeMembers: 1 }],
      members: [member('u1', '林测试', true), member('u2', '陈测试', false)],
      seriesFrom: '2026-11-13T00:00:00Z', seriesTo: '2026-11-15T00:00:00Z', seriesLabel: '11/13 至 11/15 的每日产出件数', groupNote: '当前团队关系，成员可能重复归属', costCoverage: { pricedCalls: 0, totalCalls: 12 },
    },
  };
}
