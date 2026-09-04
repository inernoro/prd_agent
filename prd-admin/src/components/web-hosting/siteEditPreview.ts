import type { HostedSiteRevision } from '@/services/real/webPages';

export function activeSiteEditRunStorageKey(siteId: string) {
  return `web-hosting-edit-active-run-v1:${siteId}`;
}

export function revisionLabel(item: Pick<HostedSiteRevision, 'isCurrent' | 'status' | 'source'>) {
  if (item.isCurrent) return '当前线上版本';
  if (item.status === 'draft') return '未发布草稿';
  if (item.source === 'rollback') return '回退发布版本';
  if (item.source === 'baseline') return '历史线上版本';
  return '已发布版本';
}

/**
 * 模型流开头可能先吐代码围栏或解释碎片。只有完整页面起点出现后才交给 iframe，
 * 避免把模型说明文字当网页正文闪给用户。
 */
export function previewableEditHtml(raw: string) {
  const normalized = raw.toLowerCase();
  const doctype = normalized.indexOf('<!doctype');
  const html = normalized.indexOf('<html');
  const start = doctype >= 0 ? doctype : html;
  if (start < 0) return '';
  return raw.slice(start).replace(/```\s*$/u, '').trim();
}
