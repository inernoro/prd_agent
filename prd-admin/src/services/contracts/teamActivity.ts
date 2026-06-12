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

export type TeamActivityModulesData = {
  items: ActivityModuleOption[];
};

export type GetTeamActivityLogsContract = (
  params?: GetTeamActivityParams
) => Promise<ApiResponse<TeamActivityListData>>;

export type GetTeamActivityModulesContract = () => Promise<ApiResponse<TeamActivityModulesData>>;
