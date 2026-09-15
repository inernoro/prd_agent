/**
 * 活动任务清单 —— API 封装。
 *
 * 注意 apiRequest 内部会自己 JSON.stringify，调用方传原始对象（见 AGENTS.md 规则 #7）。
 */
import { apiRequest } from './apiClient';
import type {
  ActiveTaskBoardSettings,
  ActiveTaskDto,
  ActiveTaskHistory,
  AssignableMember,
  MyActiveTasks,
  PublicBoard,
  KnowledgeStoreRef,
  SuggestPerson,
  SuggestionInbox,
  TaskSuggestion,
  TeamBoard,
} from '@/services/contracts/activeTasks';

const base = '/api/active-tasks';
const adminBase = '/api/active-tasks-admin';

// ── 员工侧 ─────────────────────────────────
export const getMyActiveTasks = () => apiRequest<MyActiveTasks>(`${base}/me`);

export const createActiveTask = (body: {
  title: string;
  note?: string;
  dueAt?: string | null;
  startNow?: boolean;
  source?: string;
  sourceRefType?: string;
  sourceRefId?: string;
  /** 只服务撤销删除：把那条放回它原来待着的位置，而不是排到队尾 */
  orderKey?: number;
}) => apiRequest<ActiveTaskDto>(base, { method: 'POST', body });

export const pasteActiveTasks = (text: string) =>
  apiRequest<{ created: number; items: ActiveTaskDto[] }>(`${base}/paste`, { method: 'POST', body: { text } });

export const updateActiveTask = (
  id: string,
  body: { title?: string; note?: string; dueAt?: string | null; clearDue?: boolean; closingNote?: string },
) => apiRequest<ActiveTaskDto>(`${base}/${id}`, { method: 'PUT', body });

export const promoteActiveTask = (id: string) =>
  apiRequest<{ id: string; promoted: boolean }>(`${base}/${id}/promote`, { method: 'POST' });

/** 拖拽排序：把 id 挪到 beforeId 前面；beforeId 为空 = 挪到队尾 */
export const reorderActiveTask = (id: string, beforeId: string | null) =>
  apiRequest<{ id: string; order: string[] }>(`${base}/${id}/reorder`, {
    method: 'POST',
    body: { beforeId },
  });

export const startActiveTask = (id: string) =>
  apiRequest<ActiveTaskDto>(`${base}/${id}/start`, { method: 'POST' });

/** 结案。closingNote 是「做成了什么样」那句话，选填但界面上是唯一的输入。 */
export const finishActiveTask = (id: string, closingNote?: string) =>
  apiRequest<{ finished: string; next: ActiveTaskDto | null }>(`${base}/${id}/finish`, {
    method: 'POST',
    body: { closingNote },
  });

/** 撤销结案 —— 点圆圈变成一下就完成，就必须能一下就反悔 */
export const reopenActiveTask = (id: string) =>
  apiRequest<ActiveTaskDto>(`${base}/${id}/reopen`, { method: 'POST' });

export const blockActiveTask = (id: string, blockedOn: string) =>
  apiRequest<{ id: string; blocked: boolean }>(`${base}/${id}/block`, { method: 'POST', body: { blockedOn } });

export const unblockActiveTask = (id: string) =>
  apiRequest<{ id: string; blocked: boolean }>(`${base}/${id}/unblock`, { method: 'POST' });

export const dropActiveTask = (id: string, reason?: string) =>
  apiRequest<{ id: string; dropped: boolean }>(`${base}/${id}/drop`, { method: 'POST', body: { reason } });

export const deleteActiveTask = (id: string) =>
  apiRequest<{ id: string; deleted: boolean }>(`${base}/${id}`, { method: 'DELETE' });

export const getActiveTaskHistory = (days = 14, userId?: string) =>
  apiRequest<ActiveTaskHistory>(
    `${base}/history?days=${days}${userId ? `&userId=${encodeURIComponent(userId)}` : ''}`,
  );

// ── 管理侧 ─────────────────────────────────
export const getTeamBoard = () => apiRequest<TeamBoard>(`${adminBase}/team`);

export const getAssignableMembers = () => apiRequest<AssignableMember[]>(`${adminBase}/members`);

export const assignActiveTask = (body: {
  userId: string;
  title: string;
  note?: string;
  dueAt?: string | null;
  urgent?: boolean;
  startNow?: boolean;
}) => apiRequest<ActiveTaskDto>(`${adminBase}/assign`, { method: 'POST', body });

export const assignActiveTasksBatch = (body: { userId: string; titles: string[]; dueAt?: string | null }) =>
  apiRequest<{ created: number; assignedTo: string; items: ActiveTaskDto[] }>(`${adminBase}/assign-batch`, {
    method: 'POST',
    body,
  });

export const getBoardSettings = () => apiRequest<ActiveTaskBoardSettings>(`${adminBase}/settings`);

export const saveBoardSettings = (body: {
  anonymousMode?: string;
  anonymousEnabled?: boolean;
  blockedEscalateMinutes?: number;
  heavyStackThreshold?: number;
}) => apiRequest<ActiveTaskBoardSettings>(`${adminBase}/settings`, { method: 'PUT', body });

// ── 匿名侧（不带鉴权） ─────────────────────
export const getPublicBoard = () => apiRequest<PublicBoard>('/api/public/active-tasks/board', { auth: false });

// ── 建议 ───────────────────────────────────
const sugBase = '/api/active-tasks/suggestions';

export const getSuggestionInbox = () => apiRequest<SuggestionInbox>(sugBase);

export const createSuggestion = (body: { targetUserId: string; text: string }) =>
  apiRequest<TaskSuggestion>(sugBase, { method: 'POST', body });

export const dismissSuggestion = (id: string) =>
  apiRequest<{ id: string; dismissed: boolean }>(`${sugBase}/${id}/dismiss`, { method: 'POST' });

export const getSuggestPeople = () => apiRequest<SuggestPerson[]>(`${sugBase}/people`);

export const getKnowledgeStores = () => apiRequest<KnowledgeStoreRef[]>(`${sugBase}/knowledge-stores`);

export const markSuggestionsAbsorbed = (body: { suggestionIds: string[]; taskIds: string[] }) =>
  apiRequest<{ marked: number }>(`${sugBase}/mark-absorbed`, { method: 'POST', body });

/** 记下这条建议被拿去涌现了，长出了哪棵树（回溯用） */
export const linkSuggestionEmergence = (id: string, treeId: string) =>
  apiRequest<{ id: string; treeId: string }>(`${sugBase}/${id}/emergence`, { method: 'POST', body: { treeId } });

/** 两条 SSE 的地址 —— 走 useSseStream，不走 apiRequest */
export const ACTIVE_TASK_IMPORT_STREAM = '/api/active-tasks/import/stream';
export const ACTIVE_TASK_ABSORB_STREAM = `${sugBase}/absorb-stream`;
