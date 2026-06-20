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

export type BehaviorInsight = {
  kind: 'api-error' | 'slow-endpoint' | 'long-dwell' | 'quick-exit' | 'route-oscillation' | string;
  kindLabel: string;
  /** 洞察对象：路由 / METHOD path / 路由对 */
  target: string;
  userCount: number;
  eventCount: number;
  metric: string;
  suggestion: string;
  evidence: string[];
  /** 处理状态：confirmed / resolved / ignored；null = 待处理 */
  status?: string | null;
  /** 转缺陷后的关联缺陷 */
  defectId?: string | null;
  defectTitle?: string | null;
  /** 转产品需求后的关联需求（VOC 痛点流转需求池） */
  requirementId?: string | null;
  requirementNo?: string | null;
  /** 标记 resolved 时的坏请求基线（报错+慢请求数快照）；仅报错/慢请求类有值 */
  resolvedBadCount?: number | null;
  /** 复测回落百分比：(当前坏请求-基线)/基线×100；负数=回落（好），正数=复发（坏）；null=无基线 */
  reboundPct?: number | null;
};

export type TeamActivityInsightsData = {
  items: BehaviorInsight[];
  /** 被忽略而隐藏的洞察数 */
  ignoredCount: number;
  /** 窗口内的行为事件数（路由级信号采集量） */
  behaviorEventCount: number;
  /** 路由级信号采集起点；null 表示尚无任何采集数据 */
  trackedSince?: string | null;
  windowFrom: string;
  windowTo: string;
};

export type GetTeamActivityInsightsParams = {
  from?: string;
  to?: string;
  includeIgnored?: boolean;
};

export type SetInsightStateParams = {
  kind: string;
  target: string;
  status: 'confirmed' | 'resolved' | 'ignored' | 'open';
  defectId?: string;
  defectTitle?: string;
  /** 标记 resolved 时上报当前坏请求数（报错+慢请求），作为复测回落对比基线 */
  badCount?: number;
};

export type SetTeamActivityInsightStateContract = (
  params: SetInsightStateParams
) => Promise<ApiResponse<{ fingerprint: string; status: string | null }>>;

export type InsightToRequirementParams = {
  kind: string;
  target: string;
  title?: string;
  description?: string;
  /** 落入哪个产品的需求池（必填） */
  productId: string;
};

export type InsightToRequirementResult = {
  fingerprint: string;
  requirementId: string;
  requirementNo: string;
  productId: string;
  alreadyExists: boolean;
};

export type InsightToRequirementContract = (
  params: InsightToRequirementParams
) => Promise<ApiResponse<InsightToRequirementResult>>;

export type GetTeamActivityInsightsContract = (
  params?: GetTeamActivityInsightsParams
) => Promise<ApiResponse<TeamActivityInsightsData>>;

/** 体验全景热力图：一个端点叶子（面积=访问量，颜色=健康） */
export type ExperienceMapLeaf = {
  /** 与 BehaviorInsight.target 同口径（METHOD 归一化路径），用于点击下钻联动 */
  target: string;
  label: string;
  method: string;
  value: number;
  status: 'ok' | 'slow' | 'error' | string;
  metric: string;
  errorRate: number;
  slowRate: number;
  topErrorCode?: string | null;
  /** 环比上一等长窗口的坏请求(报错+慢)突增百分比；仅痛点且坏请求达阈值时有值，否则 null */
  burstPct?: number | null;
};

/** 体验全景热力图：一个模块分区 */
export type ExperienceMapGroup = {
  key: string;
  label: string;
  value: number;
  errorLeaves: number;
  slowLeaves: number;
  leaves: ExperienceMapLeaf[];
};

export type TeamActivityExperienceMapData = {
  groups: ExperienceMapGroup[];
  totalRequests: number;
  windowFrom: string;
  windowTo: string;
};

export type GetTeamActivityExperienceMapParams = {
  from?: string;
  to?: string;
};

export type GetTeamActivityExperienceMapContract = (
  params?: GetTeamActivityExperienceMapParams
) => Promise<ApiResponse<TeamActivityExperienceMapData>>;

/** 端点下钻：错误码分布的一项 */
export type EndpointDetailCode = {
  code: string;
  n: number;
};

/** 端点下钻：一条真实请求样本 */
export type EndpointDetailSample = {
  statusCode: number;
  durationMs?: number | null;
  /** 复刻请求的 curl（不含密钥；body 已剔除提示词），缺失时为 METHOD + path */
  curl: string;
  requestBody?: string | null;
  occurredAt: string;
};

export type TeamActivityEndpointDetailData = {
  /** 与 BehaviorInsight.target 同口径（METHOD 归一化路径） */
  target: string;
  method: string;
  /** 归一化路径（:id 折叠后） */
  path: string;
  label: string;
  module: string;
  count: number;
  errorCount: number;
  slowCount: number;
  avgSlowSec: number;
  codes: EndpointDetailCode[];
  samples: EndpointDetailSample[];
  windowFrom: string;
  windowTo: string;
};

export type GetTeamActivityEndpointDetailParams = {
  target: string;
  from?: string;
  to?: string;
};

export type GetTeamActivityEndpointDetailContract = (
  params: GetTeamActivityEndpointDetailParams
) => Promise<ApiResponse<TeamActivityEndpointDetailData>>;
