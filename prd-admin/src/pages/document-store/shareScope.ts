import type { DocumentStoreShareLink } from '@/services/contracts/documentStore';

/** 分享范围：整个知识库 / 只分享某一篇文档 */
export type ShareScope = 'store' | 'entry';

/** 链接是否仍然生效（没撤销、没过期）。撤销与过期都会让链接立刻打不开。 */
export function isLiveShareLink(link: DocumentStoreShareLink, now = Date.now()): boolean {
  if (link.isRevoked) return false;
  if (!link.expiresAt) return true;
  const at = new Date(link.expiresAt).getTime();
  return Number.isNaN(at) ? true : at > now;
}

/**
 * 取出「当前范围」内仍然生效的链接。
 * targetEntryId 为空 = 整库范围，只认 entryId 为空的链接；
 * 非空 = 单篇范围，只认指向这一篇的链接。
 *
 * 判据必须带范围：早先弹窗把整库链接和单篇链接混在一个列表里，用户以为自己在分享一篇，
 * 看到的却是整库链接，于是「分享单篇结果整库暴露」（2026-07-31 用户反馈）。
 */
export function pickScopeShareLinks(
  links: DocumentStoreShareLink[],
  targetEntryId: string | undefined,
  now = Date.now(),
): DocumentStoreShareLink[] {
  return links.filter(l => isLiveShareLink(l, now)
    && (targetEntryId ? l.entryId === targetEntryId : !l.entryId));
}

/**
 * 把新建/复用得到的链接并回列表：同 id 视为同一条，替换而非追加。
 *
 * 后端对同一 (知识库, 创建者, 范围) 会复用已有链接并原样返回，前端若无脑 prepend，
 * 列表里就会出现两行 id 相同、短链相同的重复卡片（React key 也会撞）。
 */
export function upsertShareLink(
  links: DocumentStoreShareLink[],
  created: DocumentStoreShareLink,
): DocumentStoreShareLink[] {
  return [created, ...links.filter(l => l.id !== created.id)];
}
