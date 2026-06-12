import type { ApiResponse } from '@/types/api';

export type TeamActivityItem = {
  id: string;
  actorId: string;
  actorName?: string | null;
  actorAvatarFileName?: string | null;
  module: string;
  moduleLabel: string;
  action: string;
  actionLabel: string;
  targetId?: string | null;
  targetTitle?: string | null;
  targetUrl?: string | null;
  createdAt: string;
};

export type TeamActivityListData = {
  items: TeamActivityItem[];
  total: number;
  page: number;
  pageSize: number;
};

export type GetTeamActivityParams = {
  page?: number;
  pageSize?: number;
  userId?: string;
  module?: string;
  from?: string;
  to?: string;
};

export type ActivityModuleOption = {
  key: string;
  label: string;
};

export type TeamActivityModuleStat = {
  key: string;
  label: string;
  count: number;
};

export type TeamActivityActorStat = {
  actorId: string;
  actorName?: string | null;
  actorAvatarFileName?: string | null;
  count: number;
};

export type TeamActivityActionStat = {
  action: string;
  label: string;
  module: string;
  count: number;
};

export type TeamActivityStatsData = {
  total: number;
  /** 同长度上一时间窗的总量（今天 vs 昨天 / 本周 vs 上周）；范围为「全部」时为 null */
  previousTotal?: number | null;
  activeMembers: number;
  modules: TeamActivityModuleStat[];
  actors: TeamActivityActorStat[];
  /** 动作类型分布 Top 10（标签来自白名单注册表） */
  actions: TeamActivityActionStat[];
  /** 24 桶 UTC 小时直方图（基于最近样本），前端按本地时区旋转后渲染 */
  hourlyUtc: number[];
  /** 小时直方图是否因数据量过大而采样（其余统计为精确值） */
  sampled: boolean;
};

export type GetTeamActivityStatsParams = Omit<GetTeamActivityParams, 'page' | 'pageSize'>;

export type TeamActivityModulesData = {
  items: ActivityModuleOption[];
};

export type GetTeamActivityLogsContract = (
  params?: GetTeamActivityParams
) => Promise<ApiResponse<TeamActivityListData>>;

export type GetTeamActivityModulesContract = () => Promise<ApiResponse<TeamActivityModulesData>>;

export type GetTeamActivityStatsContract = (
  params?: GetTeamActivityStatsParams
) => Promise<ApiResponse<TeamActivityStatsData>>;
