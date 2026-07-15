import type { ApiResponse } from '@/types/api';

/** 首页「继续上次」条目（后端 /api/home/recent-work 聚合返回） */
export type RecentWorkItemDto = {
  /** 一键回到工作现场的前端路由（如 /visual-agent/{id}） */
  route: string;
  /** 归属智能体：visual-agent | literary-agent | workflow-agent */
  agentKey: string;
  title: string;
  lastActiveAt: string;
  /** 诚实进度 0..1——仅带状态机的实体有（当前只有缺陷）,null/缺省则不画进度条 */
  progress?: number | null;
  /** 进度标签（如「验收中」）,可独立于 progress 存在（如「已驳回」） */
  progressLabel?: string | null;
};

export type ListRecentWorkContract = (input?: { limit?: number }) => Promise<ApiResponse<{ items: RecentWorkItemDto[] }>>;
