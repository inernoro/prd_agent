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
  /** YYYY-MM-DD（周一） */
  weekStart: string;
  /** YYYY-MM-DD（周日） */
  weekEnd: string;
  dataSourceAvailable: boolean;
  /** 数据来源："local" / "github" / "none" */
  source: 'local' | 'github' | 'none';
  /** ISO 8601 拉取时间 */
  fetchedAt: string;
  fragments: ChangelogFragment[];
}

export interface ChangelogDay {
  /** YYYY-MM-DD */
  date: string;
  entries: ChangelogEntry[];
}

export interface ChangelogRelease {
  /** "未发布" / "1.7.0" / ... */
  version: string;
  /** YYYY-MM-DD（未发布版为 null） */
  releaseDate: string | null;
  /** "用户更新项" 高亮（仅已发布版本可能有） */
  highlights: string[];
  days: ChangelogDay[];
}

export interface ReleasesView {
  dataSourceAvailable: boolean;
  source: 'local' | 'github' | 'none';
  fetchedAt: string;
  releases: ChangelogRelease[];
}

// ============ API Calls ============

/**
 * 获取本周更新（基于 changelogs/*.md 碎片，按日期倒序）
 * @param force 绕过服务端缓存（GitHub 路径意味着触发真实拉取）
 */
export async function getCurrentWeekChangelog(force = false): Promise<ApiResponse<CurrentWeekView>> {
  return await apiRequest<CurrentWeekView>(api.changelog.currentWeek(force), { method: 'GET' });
}

/**
 * 获取历史发布（基于 CHANGELOG.md，按版本倒序）
 * @param force 绕过服务端缓存
 */
export async function getChangelogReleases(limit = 20, force = false): Promise<ApiResponse<ReleasesView>> {
  return await apiRequest<ReleasesView>(api.changelog.releases(limit, force), { method: 'GET' });
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
