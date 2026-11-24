import { apiDownload, apiRequest } from '@/services/real/apiClient';
import { buildApiUrl } from '@/services/real/webPages';
import type { ApiResponse } from '@/types/api';

/**
 * 风格目录与真实样张（OpenDesign 设计系统快照，后端 DesignSystemsController）。
 *
 * 样张接口与网页生成的其它接口同样要登录（Bearer 头），而 iframe 的 src 带不上请求头——
 * 所以样张走「带鉴权取回 HTML → iframe srcdoc」：取回用 apiDownload（与其它下载同一套鉴权、
 * 会话续期与人话报错），渲染交给 sandbox="" 的 iframe。
 */

export type DesignSystemSampleFormat = 'page' | 'slides';

export interface DesignSystemSwatches {
  bg: string;
  fg: string;
  accent: string;
}

export interface DesignSystemItem {
  id: string;
  name: string;
  category: string;
  /** DESIGN.md 开头的一句话；没有就是 manifest 的 description。原文（多为英文），不做翻译。 */
  summary: string;
  /** 取自该设计系统 tokens.css 的 :root（--bg / --fg / --accent 原值，可能是 #hex 或 oklch() 等）。 */
  swatches: DesignSystemSwatches;
  fonts: { display: string; body: string };
  /** 后端给出的样张地址（不含查询串）。 */
  sampleUrl: string;
}

export interface DesignSystemCategory {
  name: string;
  count: number;
}

export interface DesignSystemCatalog {
  engine: { name: string; version: string; image: string; generatedAt: string };
  count: number;
  /** 按数量从多到少排好的分类表，分组展示直接照这个顺序。 */
  categories: DesignSystemCategory[];
  items: DesignSystemItem[];
}

export interface DesignSystemSampleOptions {
  /** 样张大标题；后端负责转义与截到 60 字，这里只去掉首尾空白。 */
  title?: string;
  format?: DesignSystemSampleFormat;
}

const CATALOG_PATH = '/api/design-artifacts/design-systems';

export async function listDesignSystems(): Promise<ApiResponse<DesignSystemCatalog>> {
  return apiRequest<DesignSystemCatalog>(CATALOG_PATH);
}

/** 样张的 API 路径（含查询串）。所有样张地址都从这一个函数出来。 */
export function designSystemSamplePath(designSystemId: string, options: DesignSystemSampleOptions = {}): string {
  const query = new URLSearchParams();
  const title = options.title?.trim();
  if (title) query.set('title', title);
  if (options.format && options.format !== 'page') query.set('format', options.format);
  const search = query.toString();
  return `${CATALOG_PATH}/${encodeURIComponent(designSystemId)}/sample${search ? `?${search}` : ''}`;
}

/** 样张的完整地址，与 buildApiUrl 同一套基址（后端与前端分开部署时指向后端域）。 */
export function designSystemSampleUrl(designSystemId: string, options: DesignSystemSampleOptions = {}): string {
  return buildApiUrl(designSystemSamplePath(designSystemId, options));
}

const sampleCache = new Map<string, Promise<string>>();

/**
 * 取回样张 HTML（带鉴权）。同一地址并发只发一次、成功后在本页会话内复用；失败不缓存，下次重试会真的重新请求。
 * 失败抛出的 Error.message 是人话原因（未知风格、没有权限、网络中断……），可以直接展示。
 */
export function loadDesignSystemSample(designSystemId: string, options: DesignSystemSampleOptions = {}): Promise<string> {
  const path = designSystemSamplePath(designSystemId, options);
  const cached = sampleCache.get(path);
  if (cached) return cached;
  const pending = apiDownload(path, 'sample.html')
    .then((file) => file.blob.text())
    .catch((error: unknown) => {
      sampleCache.delete(path);
      throw error instanceof Error ? error : new Error('样张没有取回来，请稍后重试。');
    });
  sampleCache.set(path, pending);
  return pending;
}

/** 仅测试用：清空样张缓存。 */
export function resetDesignSystemSampleCache(): void {
  sampleCache.clear();
}
