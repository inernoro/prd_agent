import type { ApiResponse } from '@/types/api';

export type ExecutiveOverview = {
  totalUsers: number;
  activeUsers: number;
  prevActiveUsers: number;
  periodMessages: number;
  prevMessages: number;
  periodTokens: number;
  prevTokens: number;
  llmCalls: number;
  totalDefects: number;
  resolvedDefects: number;
  defectResolutionRate: number;
  periodImages: number;
  days: number;
};

export type ExecutiveTrendItem = {
  date: string;
  messages: number;
  tokens: number;
};

export type ExecutiveTeamMember = {
  userId: string;
  username: string;
  displayName: string;
  role: string;
  avatarFileName: string | null;
  lastActiveAt: string | null;
  isActive: boolean;
  messages: number;
  sessions: number;
  defectsCreated: number;
  defectsResolved: number;
  imageRuns: number;
};

export type ExecutiveAgentStat = {
  appKey: string;
  name: string;
  calls: number;
  users: number;
  tokens: number;
  avgDurationMs: number;
  llmCalls: number;
  apiCalls: number;
};

export type ExecutiveModelStat = {
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  avgDurationMs: number;
  imageCount: number;
  tokenCost: number;
  callCost: number;
  totalCost: number;
  hasPricing: boolean;
};

export type LeaderboardUser = {
  userId: string;
  username: string;
  displayName: string;
  role: string;
  avatarFileName: string | null;
  lastActiveAt: string | null;
  isActive: boolean;
};

export type LeaderboardDimension = {
  key: string;
  name: string;
  category: 'agent' | 'activity' | 'image';
  values: Record<string, number>;
  /** 口径说明（怎么算的）—— 后端单一来源，前端直接渲染 */
  description?: string;
  /** 怎么操作会让这一项 +1 */
  howToIncrease?: string;
  /** 排除了哪些异常/奇异数据 */
  anomalyNote?: string;
  /** 缺陷列专用：每个用户的提交/解决拆解 */
  subValues?: Record<string, { created: number; resolved: number }>;
};

export type ExecutiveLeaderboard = {
  users: LeaderboardUser[];
  dimensions: LeaderboardDimension[];
  totalDays: number;
};

/* ── 团队洞察（结论优先四段式） ────────────────────────────── */

export type TeamInsightKpi = {
  key: string;
  label: string;
  /** 后端算不出来时为 null —— 前端必须显示「数据不足」而不是补 0 */
  value: number | null;
  unit: string;
  prev: number | null;
  deltaPct: number | null;
  /** 该指标是越大越好还是越小越好，决定环比染色 */
  higherIsBetter: boolean;
  /** 日序列；窗口无界或过长时为空数组，前端不画 sparkline */
  series: number[];
  /** 口径说明，后端 SSOT */
  note: string;
};

export type TeamInsightAttention = {
  severity: 'critical' | 'watch';
  key: string;
  title: string;
  evidence: string;
  suggestion: string;
  linkLabel: string;
  linkTo: string;
};

export type TeamInsightMember = {
  userId: string;
  displayName: string;
  role: string;
  avatarFileName: string | null;
  output: number;
  /** 结果质量 0-100；必须有结果型信号（缺陷解决率 / 生图成功率）才计算，
   *  调用成功率只作附加项。本窗无结果型信号时为 null，不折算成 100。 */
  quality: number | null;
  quadrant: '主力产出' | '精工型' | '高量低果' | '低活跃' | '数据不足' | '样本不足';
  outputDays: number;
  llmCalls: number;
  llmErrors: number;
  cost: number;
  tokens: number;
  breakdown: {
    docs: number; sites: number; reports: number;
    imageRuns: number; imagesDone: number; imagesFailed: number;
    defectsReported: number; defectsAssigned: number;
    defectsResolved: number; defectsBacklog: number;
  };
  highlights: string[];
};

export type TeamInsightFlowNode = { name: string; value: number; unit: string; loss?: boolean };

export type TeamInsights = {
  pulse: TeamInsightKpi[];
  attention: TeamInsightAttention[];
  members: TeamInsightMember[];
  flow: { left: TeamInsightFlowNode[]; mid: TeamInsightFlowNode[]; right: TeamInsightFlowNode[] };
  meta: {
    days: number;
    from: string | null;
    to: string;
    prevFrom: string | null;
    totalMembers: number;
    /** 四象限分界阈值（产出阈值 / 质量中位），与后端判定同口径 */
    medians: { output: number; quality: number };
    /** 有结果型信号、进得了画像的人数 */
    plottedMembers: number;
    /** 入图样本 >= 3 才做四象限分型；否则象限一律为「样本不足」 */
    quadrantReliable: boolean;
    /** 模型组是否配了单价；否则成本一律算不出来，显示数据不足而非 0 */
    costAvailable: boolean;
    seriesAvailable: boolean;
    /** 明确拿不到的指标 —— 面板照实说明，不编数字 */
    unavailable: { metric: string; reason: string }[];
    sources: { metric: string; source: string }[];
  };
};

export type GetTeamInsightsContract = (days?: number) => Promise<ApiResponse<TeamInsights>>;

export type GetExecutiveOverviewContract = (days?: number) => Promise<ApiResponse<ExecutiveOverview>>;
export type GetExecutiveTrendsContract = (days?: number) => Promise<ApiResponse<ExecutiveTrendItem[]>>;
export type GetExecutiveTeamContract = (days?: number) => Promise<ApiResponse<ExecutiveTeamMember[]>>;
export type GetExecutiveAgentsContract = (days?: number) => Promise<ApiResponse<ExecutiveAgentStat[]>>;
export type GetExecutiveModelsContract = (days?: number) => Promise<ApiResponse<ExecutiveModelStat[]>>;
export type GetExecutiveLeaderboardContract = (days?: number) => Promise<ApiResponse<ExecutiveLeaderboard>>;
