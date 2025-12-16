import { ok, type ApiResponse } from '@/types/api';
import type {
  AdminGroup,
  AdminGroupMember,
  AdminMessage,
  GetAdminGroupGapsContract,
  GetAdminGroupMembersContract,
  GetAdminGroupMessagesContract,
  GetAdminGroupsContract,
  GetAdminGroupsParams,
  PagedResult,
  RegenerateAdminGroupInviteContract,
  RemoveAdminGroupMemberContract,
  UpdateAdminGapStatusContract,
  UpdateAdminGroupContract,
  DeleteAdminGroupContract,
  GenerateAdminGapSummaryContract,
} from '@/services/contracts/adminGroups';

function nowIso() {
  return new Date().toISOString();
}

function demoGroups(): AdminGroup[] {
  const now = nowIso();
  return Array.from({ length: 12 }).map((_, i) => ({
    groupId: `g-${i + 1}`,
    groupName: `群组 ${i + 1}`,
    owner: { userId: `u-${i + 1}`, username: `pm_${i + 1}`, displayName: `产品${i + 1}`, role: 'PM' },
    memberCount: 3 + (i % 6),
    prdTitleSnapshot: i % 2 === 0 ? `PRD 标题示例 ${i + 1}` : null,
    prdTokenEstimateSnapshot: i % 2 === 0 ? 12345 + i : null,
    prdCharCountSnapshot: i % 2 === 0 ? 88000 + i * 100 : null,
    inviteCode: `INV-ABCD00${i + 1}`,
    inviteExpireAt: i % 3 === 0 ? now : null,
    maxMembers: 20,
    createdAt: now,
    lastMessageAt: now,
    messageCount: 100 + i * 7,
    pendingGapCount: i % 3,
  }));
}

export const getAdminGroupsMock: GetAdminGroupsContract = async (params: GetAdminGroupsParams): Promise<ApiResponse<PagedResult<AdminGroup>>> => {
  const all = demoGroups();
  const s = (params.search ?? '').trim().toLowerCase();
  let filtered = all;
  if (s) {
    filtered = filtered.filter((g) => g.groupName.toLowerCase().includes(s) || g.groupId.toLowerCase().includes(s) || g.owner?.username.toLowerCase().includes(s));
  }
  if (params.inviteStatus === 'expired') filtered = filtered.filter((g) => !!g.inviteExpireAt);
  if (params.inviteStatus === 'valid') filtered = filtered.filter((g) => !g.inviteExpireAt);

  const page = params.page ?? 1;
  const pageSize = params.pageSize ?? 20;
  const start = (page - 1) * pageSize;
  const items = filtered.slice(start, start + pageSize);
  return ok({ items, total: filtered.length, page, pageSize });
};

export const getAdminGroupMembersMock: GetAdminGroupMembersContract = async (groupId: string) => {
  const now = nowIso();
  const members: AdminGroupMember[] = [
    { userId: 'u-owner', username: 'pm_owner', displayName: '产品负责人', role: 'PM', joinedAt: now, isOwner: true },
    { userId: 'u-dev', username: 'dev', displayName: '开发', role: 'DEV', joinedAt: now, isOwner: false },
    { userId: 'u-qa', username: 'qa', displayName: '测试', role: 'QA', joinedAt: now, isOwner: false },
  ];
  void groupId;
  return ok(members);
};

export const removeAdminGroupMemberMock: RemoveAdminGroupMemberContract = async () => {
  return ok(true);
};

export const regenerateAdminGroupInviteMock: RegenerateAdminGroupInviteContract = async (groupId: string) => {
  void groupId;
  return ok({ inviteCode: 'INV-NEW12345', inviteLink: 'prdagent://join/INV-NEW12345', inviteExpireAt: null });
};

export const updateAdminGroupMock: UpdateAdminGroupContract = async () => ok(true);
export const deleteAdminGroupMock: DeleteAdminGroupContract = async () => ok(true);

export const getAdminGroupGapsMock: GetAdminGroupGapsContract = async (groupId: string) => {
  void groupId;
  return ok({
    items: [
      { gapId: 'gap-1', question: '退款流程没有说明', gapType: 'flowmissing', askedAt: nowIso(), status: 'pending', askedBy: { userId: 'u-qa', displayName: '测试', role: 'QA' } },
      { gapId: 'gap-2', question: '输入长度上限未定义', gapType: 'boundaryundefined', askedAt: nowIso(), status: 'resolved', askedBy: { userId: 'u-dev', displayName: '开发', role: 'DEV' } },
    ],
    total: 2,
    page: 1,
    pageSize: 20,
  });
};

export const updateAdminGapStatusMock: UpdateAdminGapStatusContract = async () => ok(true);
export const generateAdminGapSummaryMock: GenerateAdminGapSummaryContract = async () =>
  ok({ report: '示例缺口汇总报告（mock）', generatedAt: nowIso(), totalGaps: 2 });

export const getAdminGroupMessagesMock: GetAdminGroupMessagesContract = async (groupId: string, params) => {
  void groupId;
  const now = nowIso();
  const all: AdminMessage[] = [
    { id: 'm-1', groupId: 'g-1', sessionId: 's-1', senderId: 'u-dev', role: 'User', content: '这个接口的入参有哪些？', timestamp: now, tokenUsage: null },
    { id: 'm-2', groupId: 'g-1', sessionId: 's-1', role: 'Assistant', content: '根据PRD文档，入参包括...（示例）', timestamp: now, tokenUsage: { input: 512, output: 233 } },
  ];
  const q = (params.q ?? '').trim();
  const filtered = q ? all.filter((m) => m.content.includes(q)) : all;
  const page = params.page ?? 1;
  const pageSize = params.pageSize ?? 20;
  const start = (page - 1) * pageSize;
  return ok({ items: filtered.slice(start, start + pageSize), total: filtered.length, page, pageSize });
};


