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
  TeamBoard,
} from '@/services/contracts/activeTasks';

const base = '/api/active-tasks';
const adminBase = '/api/active-tasks-admin';

// ── 员工侧 ─────────────────────────────────
export const getMyActiveTasks = () => apiRequest<MyActiveTasks>(`${base}/me`);

export const createActiveTask = (body: {
  title: string;
  note?: string;
  estimateMinutes?: number;
  startNow?: boolean;
  source?: string;
  sourceRefType?: string;
  sourceRefId?: string;
}) => apiRequest<ActiveTaskDto>(base, { method: 'POST', body });

export const pasteActiveTasks = (text: string) =>
  apiRequest<{ created: number; items: ActiveTaskDto[] }>(`${base}/paste`, { method: 'POST', body: { text } });

export const updateActiveTask = (id: string, body: { title?: string; note?: string; estimateMinutes?: number }) =>
  apiRequest<ActiveTaskDto>(`${base}/${id}`, { method: 'PUT', body });

export const promoteActiveTask = (id: string) =>
  apiRequest<{ id: string; promoted: boolean }>(`${base}/${id}/promote`, { method: 'POST' });

export const startActiveTask = (id: string) =>
  apiRequest<ActiveTaskDto>(`${base}/${id}/start`, { method: 'POST' });

export const finishActiveTask = (id: string) =>
  apiRequest<{ finished: string; next: ActiveTaskDto | null }>(`${base}/${id}/finish`, { method: 'POST' });

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

// ── 老板侧 ─────────────────────────────────
export const getTeamBoard = () => apiRequest<TeamBoard>(`${adminBase}/team`);

export const getAssignableMembers = () => apiRequest<AssignableMember[]>(`${adminBase}/members`);

export const assignActiveTask = (body: {
  userId: string;
  title: string;
  note?: string;
  estimateMinutes?: number;
  urgent?: boolean;
  startNow?: boolean;
}) => apiRequest<ActiveTaskDto>(`${adminBase}/assign`, { method: 'POST', body });

export const assignActiveTasksBatch = (body: { userId: string; titles: string[]; estimateMinutes?: number }) =>
  apiRequest<{ created: number; assignedTo: string; items: ActiveTaskDto[] }>(`${adminBase}/assign-batch`, {
    method: 'POST',
    body,
  });

export const getBoardSettings = () => apiRequest<ActiveTaskBoardSettings>(`${adminBase}/settings`);

export const saveBoardSettings = (body: {
  anonymousMode?: string;
  anonymousEnabled?: boolean;
  blockedEscalateMinutes?: number;
  lowFuelThreshold?: number;
}) => apiRequest<ActiveTaskBoardSettings>(`${adminBase}/settings`, { method: 'PUT', body });

// ── 匿名侧（不带鉴权） ─────────────────────
export const getPublicBoard = () => apiRequest<PublicBoard>('/api/public/active-tasks/board', { auth: false });
