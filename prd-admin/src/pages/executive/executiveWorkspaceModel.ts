import type { ExecutiveWorkspaceMember, TeamInsights } from '@/services/contracts/executive';

/** 兼容旧响应：只展示实际返回的人，不给缺失成员补姓名或零指标。 */
export function executiveWorkspaceModel(data: TeamInsights) {
  const members: ExecutiveWorkspaceMember[] = data.workspace?.members ?? data.members.map(member => ({
    userId: member.userId, displayName: member.displayName, role: member.role,
    avatarFileName: member.avatarFileName, hasActivity: true,
    llmCalls: member.llmCalls, llmErrors: member.llmErrors, pricedCalls: null,
    docs: member.breakdown.docs, sites: member.breakdown.sites, reports: member.breakdown.reports,
    imagesDone: member.breakdown.imagesDone, imagesFailed: member.breakdown.imagesFailed,
    defectsResolved: member.breakdown.defectsResolved, defectsBacklog: member.breakdown.defectsBacklog,
    tokens: member.tokens, cost: member.cost, outputSeries: [],
  }));
  const byId = new Map(members.map(member => [member.userId, member]));
  const groups = data.workspace?.groups ?? [{
    id: '__known__', name: '有记录成员', userIds: members.map(member => member.userId),
    totalMembers: members.length, activeMembers: members.length,
  }];
  return { members, byId, groups };
}

export type MemberRecordState = 'record' | 'failed' | 'backlog' | 'none';
export const MEMBER_STATE_REGISTRY = {
  record: { label: '本窗有产出或模型调用', short: '有记录' },
  failed: { label: '本窗有失败记录', short: '有失败记录' },
  backlog: { label: '当前有缺陷积压', short: '有积压' },
  none: { label: '本窗暂无产出或模型调用', short: '暂无产出/调用' },
} satisfies Record<MemberRecordState, { label: string; short: string }>;

export function memberRecordState(member: ExecutiveWorkspaceMember): MemberRecordState {
  if (member.imagesFailed > 0 || member.llmErrors > 0) return 'failed';
  if (member.defectsBacklog > 0) return 'backlog';
  return member.hasActivity ? 'record' : 'none';
}

/** 折线从零起算，所有点使用同一尺度；不把恒定零值画成有波动的趋势。 */
export function workspaceSparkline(values: number[], width = 180, height = 30) {
  if (values.length < 2 || values.some(value => !Number.isFinite(value) || value < 0)) return '';
  const maximum = Math.max(...values);
  if (maximum === 0) return '';
  return values.map((value, index) => `${index ? 'L' : 'M'}${(index / (values.length - 1) * width).toFixed(2)},${(height - 2 - value / maximum * (height - 4)).toFixed(2)}`).join(' ');
}
