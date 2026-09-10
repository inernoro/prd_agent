/**
 * 公共藏书阁 —— 个人进度与团队看板的服务端接口。
 *
 * 契约要点（对照 apiClient.ts 的 apiRequest 签名，别凭记忆写）：
 *  - body 传原始对象，apiRequest 内部会 JSON.stringify，调用方再 stringify 就双重序列化，后端 400
 *  - 返回是 ApiResponse<T> = { success, data, error }，判断用 res.success 不是 res.ok
 *  - 错误是对象，取 res.error?.message，不是字符串
 */
import { apiRequest } from './apiClient';

export interface ServerExamResult {
  volumeId: string;
  correct: number;
  total: number;
  passed: boolean;
  takenAt: string;
}

export interface BookshelfProgressDto {
  readBookIds: string[];
  examResults: Record<string, ServerExamResult>;
  updatedAt: string | null;
}

export interface TeamMemberRow {
  userId: string;
  /** 查不到用户时后端返回 null，前端显示「未知成员」，不编造名字 */
  displayName: string | null;
  readCount: number;
  passedCount: number;
  passedVolumeIds: string[];
  updatedAt: string;
}

export interface BookshelfTeamDto {
  members: TeamMemberRow[];
  memberCount: number;
  /** 卷 id → 通关人数。看板真正的用处：一眼看出全队哪一卷最薄弱 */
  passedByVolume: Record<string, number>;
}

export function getMyBookshelfProgress() {
  return apiRequest<BookshelfProgressDto>('/api/bookshelf/progress');
}

export function saveMyBookshelfProgress(payload: {
  readBookIds: string[];
  examResults: Record<string, { correct: number; total: number; passed: boolean }>;
}) {
  return apiRequest<BookshelfProgressDto>('/api/bookshelf/progress', {
    method: 'PUT',
    body: payload,
  });
}

export function getBookshelfTeamBoard() {
  return apiRequest<BookshelfTeamDto>('/api/bookshelf/team');
}
