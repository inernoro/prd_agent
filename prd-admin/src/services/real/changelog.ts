import { apiRequest } from '@/services/real/apiClient';
import { api } from '@/services/api';
import type { ApiResponse } from '@/types/api';

// ============ Types（与后端 ChangelogController DTO 对齐） ============

export type ChangelogChangeType = 'feat' | 'fix' | 'refactor' | 'perf' | 'docs' | 'chore' | string;

export interface ChangelogEntry {
  type: ChangelogChangeType;
  module: string;
  description: string;
}

export interface ChangelogFragment {
  fileName: string;
  /** YYYY-MM-DD */
  date: string;
  entries: ChangelogEntry[];
}

export interface CurrentWeekView {
  /** YYYY-MM-DD（最早待发布碎片日期；无碎片时为今天） */
  weekStart: string;
  /** YYYY-MM-DD（最新待发布碎片日期；无碎片时为今天） */
  weekEnd: string;
  dataSourceAvailable: boolean;
  /** 数据来源："local" / "github" / "none" */
  source: 'local' | 'github' | 'none';
  /** ISO 8601 拉取时间 */
  fetchedAt: string;
  /** 全量日期组数（=碎片文件数），不受 daysLimit 影响，用于 chip 计数 */
  totalDays?: number;
  /** 全量 entries 总数，不受 daysLimit 影响，用于 chip 计数 */
  totalEntries?: number;
  /** 本次响应跳过的日期组数（用于 loadMore 续接） */
  daysOffset?: number;
  /** 是否还有更多日期组 */
  hasMore?: boolean;
  fragments: ChangelogFragment[];
}

export interface ChangelogDay {
  /** YYYY-MM-DD */
  date: string;
  /** 该日期最晚一次 GitHub commit 的 ISO 8601 UTC 时间（仅 github 源可用） */
  commitTimeUtc?: string | null;
  entries: ChangelogEntry[];
}

export interface ChangelogRelease {
  /** "未发布" / "1.7.0" / ... */
  version: string;
  /** YYYY-MM-DD（未发布版为 null） */
  releaseDate: string | null;
  /** 该 CHANGELOG 版本块的全部表格条目数，不受前端类型筛选影响 */
  entryCount?: number;
  /** "changelog-unreleased-block" / "changelog-release-block" */
  sourceScope?: string;
  /** "用户更新项" 高亮（仅已发布版本可能有） */
  highlights: string[];
  /** true 时 days 是空数组（summary 模式），需调 releaseByVersion 端点拉详情 */
  entriesOmitted?: boolean;
  days: ChangelogDay[];
}

export interface ReleasesView {
  dataSourceAvailable: boolean;
  source: 'local' | 'github' | 'none';
  fetchedAt: string;
  /** 版本总数，用于 chip 计数 */
  totalReleases?: number;
  /** 所有版本 entries 总数，用于 chip 计数（summary 模式下仍准确） */
  totalEntries?: number;
  releases: ChangelogRelease[];
}

export interface GitHubCoAuthor {
  name: string;
  matchedUsername?: string | null;
  matchedDisplayName?: string | null;
}

export interface GitHubLinkedDefect {
  traceId: string;
  defectId: string;
  defectNo?: string | null;
  defectTitle?: string | null;
  reporterName?: string | null;
  isSubmittedByMe?: boolean;
  fixStatus: string;
  publishStatus: 'unknown' | 'pending' | 'published' | string;
  previewUrl?: string | null;
  visualReportUrl?: string | null;
  knowledgeBaseUrl?: string | null;
  pullRequestNumber?: number | null;
  pullRequestUrl?: string | null;
  commitSha: string;
}

export interface GitHubLogEntry {
  sha: string;
  shortSha: string;
  message: string;
  authorName: string;
  authorAvatarUrl?: string | null;
  commitTimeUtc: string;
  htmlUrl: string;
  /** 彩蛋：GitHub 作者名匹配到的系统用户登录名（去数字 + 颠倒容忍 + 通用后缀剥离），null=未匹配 */
  matchedUsername?: string | null;
  /** 彩蛋：匹配到的系统用户显示名（为空时后端回退登录名），null=未匹配 */
  matchedDisplayName?: string | null;
  /** Co-authored-by 联合作者（已剔除与主作者同人），每位同样带系统用户匹配结果 */
  coAuthors?: GitHubCoAuthor[];
  /** 与该 commit 关联的缺陷修复记录 */
  linkedDefects?: GitHubLinkedDefect[];
}

export interface GitHubLogsView {
  dataSourceAvailable: boolean;
  source: 'local' | 'github' | 'none';
  fetchedAt: string;
  /** 「最近一周」窗口内的 commit 总数（列表数据上限） */
  totalCount?: number;
  /** 仓库全历史提交总数（不限窗口），null=暂未统计成功，展示时降级用 totalCount */
  repoTotalCommitCount?: number | null;
  hasMore?: boolean;
  /** 下一页 cursor，传给 before 参数取下一批 */
  nextCursor?: string | null;
  logs: GitHubLogEntry[];
}

export interface GitHubPendingReviewEntry {
  number: number;
  title: string;
  authorName: string;
  authorAvatarUrl?: string | null;
  headBranch: string;
  baseBranch: string;
  headSha: string;
  shortSha: string;
  isDraft: boolean;
  createdAtUtc: string;
  updatedAtUtc: string;
  htmlUrl: string;
}

export interface GitHubPendingReviewView {
  dataSourceAvailable: boolean;
  source: 'github' | 'none';
  fetchedAt: string;
  totalCount?: number;
  items: GitHubPendingReviewEntry[];
}

// ============ API Calls ============

/**
 * 获取待发布更新（基于全部 changelogs/*.md 碎片，按日期倒序）
 * 支持瀑布式分页：daysLimit + daysOffset
 */
export async function getCurrentWeekChangelog(opts: {
  daysLimit?: number;
  daysOffset?: number;
  force?: boolean;
} = {}): Promise<ApiResponse<CurrentWeekView>> {
  return await apiRequest<CurrentWeekView>(api.changelog.currentWeek(opts), { method: 'GET' });
}

/**
 * 获取历史发布（基于 CHANGELOG.md，按版本倒序）
 * summary=true 时只返回元数据 + entryCount（首屏极轻），详情靠 getChangelogReleaseByVersion
 */
export async function getChangelogReleases(opts: {
  limit?: number;
  summary?: boolean;
  force?: boolean;
} = {}): Promise<ApiResponse<ReleasesView>> {
  return await apiRequest<ReleasesView>(api.changelog.releases(opts), { method: 'GET' });
}

/**
 * 获取单个版本的完整 entries（按需懒加载，配合 summary 模式使用）
 */
export async function getChangelogReleaseByVersion(
  version: string,
  force = false,
): Promise<ApiResponse<ChangelogRelease>> {
  return await apiRequest<ChangelogRelease>(api.changelog.releaseByVersion(version, force), { method: 'GET' });
}

/**
 * 获取 GitHub 日志（优先本地 git log，失败时回退 GitHub commits API）
 * 支持 cursor 分页：before=<sha>
 */
export async function getChangelogGitHubLogs(opts: {
  limit?: number;
  before?: string;
  force?: boolean;
} = {}): Promise<ApiResponse<GitHubLogsView>> {
  return await apiRequest<GitHubLogsView>(api.changelog.githubLogs(opts), { method: 'GET' });
}

/**
 * 获取 GitHub 待审核提交（open PR），用于展示尚未 merge、不会出现在 commits 列表里的修复分支。
 */
export async function getChangelogGitHubPendingReview(opts: {
  limit?: number;
  force?: boolean;
} = {}): Promise<ApiResponse<GitHubPendingReviewView>> {
  return await apiRequest<GitHubPendingReviewView>(api.changelog.githubPendingReview(opts), { method: 'GET' });
}

export type ChangelogAiSummarySubtab = 'releases' | 'fragments' | 'github_logs' | 'github_pending_review';

export interface ChangelogAiSummaryDto {
  title: string;
  headline: string;
  bullets: string[];
  stats: string[];
  insight: string;
  /** 网关溯源（AppCallerCode） */
  thinkingTrace: string;
  generatedAt: number;
}

/**
 * 更新中心「AI 总结」：服务端经 ILlmGateway 调用，AppCallerCode 为 prd-admin.changelog.ai-summary::chat
 */
export async function postChangelogAiSummary(body: {
  subtab: ChangelogAiSummarySubtab;
  typeFilter?: string | null;
}): Promise<ApiResponse<ChangelogAiSummaryDto>> {
  return await apiRequest<ChangelogAiSummaryDto>(api.changelog.aiSummary(), {
    method: 'POST',
    body: {
      subtab: body.subtab,
      typeFilter: body.typeFilter ?? null,
    },
  });
}

// ============ Report Sources（周报来源配置，全员共享） ============

export interface ChangelogReportSource {
  id: string;
  name: string;
  storeId: string;
  prefix: string;
  description?: string | null;
  sortOrder: number;
  createdBy: string;
  updatedBy: string;
  /** ISO 8601 */
  createdAt: string;
  /** ISO 8601 */
  updatedAt: string;
}

export interface ChangelogReportSourceUpsert {
  name: string;
  storeId: string;
  prefix?: string;
  description?: string | null;
  sortOrder?: number;
}

/** 列出所有周报来源（按 sortOrder 排序） */
export async function listChangelogReportSources(): Promise<ApiResponse<ChangelogReportSource[]>> {
  return await apiRequest<ChangelogReportSource[]>(api.changelog.sources.list(), { method: 'GET' });
}

/** 创建周报来源 */
export async function createChangelogReportSource(
  body: ChangelogReportSourceUpsert,
): Promise<ApiResponse<ChangelogReportSource>> {
  return await apiRequest<ChangelogReportSource>(api.changelog.sources.create(), {
    method: 'POST',
    body,
  });
}

/** 更新周报来源 */
export async function updateChangelogReportSource(
  id: string,
  body: ChangelogReportSourceUpsert,
): Promise<ApiResponse<ChangelogReportSource>> {
  return await apiRequest<ChangelogReportSource>(api.changelog.sources.update(id), {
    method: 'PUT',
    body,
  });
}

/** 删除周报来源 */
export async function deleteChangelogReportSource(id: string): Promise<ApiResponse<{ id: string }>> {
  return await apiRequest<{ id: string }>(api.changelog.sources.delete(id), {
    method: 'DELETE',
  });
}
