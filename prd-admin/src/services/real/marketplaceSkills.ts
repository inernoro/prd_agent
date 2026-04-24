import { apiRequest } from './apiClient';
import { api } from '@/services/api';
import { useAuthStore } from '@/stores/authStore';
import type { ApiResponse } from '@/types/api';
import type {
  DeleteMarketplaceSkillContract,
  FavoriteMarketplaceSkillContract,
  ForkMarketplaceSkillContract,
  GetMarketplaceSkillTagsContract,
  ListMarketplaceSkillsContract,
  ListMyFavoriteSkillsContract,
  MarketplaceSkillDto,
  UnfavoriteMarketplaceSkillContract,
  UploadMarketplaceSkillContract,
} from '@/services/contracts/marketplaceSkills';

/**
 * 列出海鲜市场公开的技能包
 */
export const listMarketplaceSkillsReal: ListMarketplaceSkillsContract = async (input) => {
  const params = new URLSearchParams();
  if (input.keyword) params.append('keyword', input.keyword);
  if (input.sort) params.append('sort', input.sort);
  if (input.tag) params.append('tag', input.tag);
  const qs = params.toString();
  const url = qs ? `${api.marketplaceSkills.list()}?${qs}` : api.marketplaceSkills.list();
  return await apiRequest(url, { method: 'GET' });
};

/**
 * 聚合所有公开技能标签（按使用频次降序）
 */
export const getMarketplaceSkillTagsReal: GetMarketplaceSkillTagsContract = async () => {
  return await apiRequest(api.marketplaceSkills.tags(), { method: 'GET' });
};

/**
 * 当前用户收藏的技能列表（供"我的空间 → 我收藏的技能"消费）
 */
export const listMyFavoriteSkillsReal: ListMyFavoriteSkillsContract = async () => {
  return await apiRequest(api.marketplaceSkills.favorites(), { method: 'GET' });
};

/**
 * 上传 zip 技能包。走 FormData，不走 apiRequest（后者会把 body JSON 序列化）。
 */
export const uploadMarketplaceSkillReal: UploadMarketplaceSkillContract = async (input) => {
  const token = useAuthStore.getState().token;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const fd = new FormData();
  fd.append('file', input.file);
  if (input.title) fd.append('title', input.title);
  if (input.description) fd.append('description', input.description);
  if (input.iconEmoji) fd.append('iconEmoji', input.iconEmoji);
  if (input.tags && input.tags.length > 0) {
    fd.append('tagsJson', JSON.stringify(input.tags));
  }
  if (input.coverImage) fd.append('coverImage', input.coverImage);
  if (input.previewSource) fd.append('previewSource', input.previewSource);
  if (input.previewUrl) fd.append('previewUrl', input.previewUrl);
  if (input.previewHostedSiteId) fd.append('previewHostedSiteId', input.previewHostedSiteId);

  const rawBase = ((import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '').trim().replace(/\/+$/, '');
  const url = rawBase ? `${rawBase}${api.marketplaceSkills.upload()}` : api.marketplaceSkills.upload();
  const res = await fetch(url, { method: 'POST', headers, body: fd });
  const text = await res.text();
  try {
    return JSON.parse(text) as ApiResponse<{ item: MarketplaceSkillDto }>;
  } catch {
    return {
      success: false,
      data: null as never,
      error: { code: 'INVALID_FORMAT', message: `响应解析失败（HTTP ${res.status}）` },
    };
  }
};

/**
 * 「拿来吧」：计数 +1 并返回 zip 下载 URL。
 * 本函数同时触发浏览器下载，让海鲜市场的通用 Fork 按钮"即点即下"。
 */
export const forkMarketplaceSkillReal: ForkMarketplaceSkillContract = async (input) => {
  const res = await apiRequest<{ downloadUrl: string; fileName: string; item: MarketplaceSkillDto }>(
    api.marketplaceSkills.fork(encodeURIComponent(input.id)),
    { method: 'POST', body: {} },
  );
  if (res.success && res.data?.downloadUrl) {
    // 触发浏览器下载：新开窗口，浏览器按 Content-Disposition 或 URL 自行保存
    try {
      const a = document.createElement('a');
      a.href = res.data.downloadUrl;
      a.download = res.data.fileName || 'skill.zip';
      a.rel = 'noopener noreferrer';
      a.target = '_blank';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch {
      // 降级：直接打开
      window.open(res.data.downloadUrl, '_blank', 'noopener,noreferrer');
    }
  }
  return res;
};

export const favoriteMarketplaceSkillReal: FavoriteMarketplaceSkillContract = async (input) => {
  return await apiRequest(api.marketplaceSkills.favorite(encodeURIComponent(input.id)), {
    method: 'POST',
    body: {},
  });
};

export const unfavoriteMarketplaceSkillReal: UnfavoriteMarketplaceSkillContract = async (input) => {
  return await apiRequest(api.marketplaceSkills.unfavorite(encodeURIComponent(input.id)), {
    method: 'POST',
    body: {},
  });
};

export const deleteMarketplaceSkillReal: DeleteMarketplaceSkillContract = async (input) => {
  return await apiRequest(api.marketplaceSkills.byId(encodeURIComponent(input.id)), {
    method: 'DELETE',
    emptyResponseData: { deleted: true },
  });
};
