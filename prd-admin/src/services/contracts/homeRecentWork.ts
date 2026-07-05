import type { ApiResponse } from '@/types/api';

/** 首页「继续上次」条目（后端 /api/home/recent-work 聚合返回） */
export type RecentWorkItemDto = {
  /** 一键回到工作现场的前端路由（如 /visual-agent/{id}） */
  route: string;
  /** 归属智能体：visual-agent | literary-agent | workflow-agent */
  agentKey: string;
  title: string;
  lastActiveAt: string;
};

export type ListRecentWorkContract = (input?: { limit?: number }) => Promise<ApiResponse<{ items: RecentWorkItemDto[] }>>;
