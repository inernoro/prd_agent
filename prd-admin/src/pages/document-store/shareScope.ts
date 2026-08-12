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
 * 对外分享地址（唯一来源）：恒为不可枚举的字母长链 /s/lib/{token}。
 *
 * 数字短链 /s/{seq} 是全局自增号，攻击者可以从 1 逐个试出别人的分享，
 * 统一分享体系里它只是「用户主动生成后的次级可选项」，绝不能当默认对外地址
 * （doc/debt.platform.md「分享链接安全」；网页托管 2026-06-11 已按此口径改过）。
 */
export function shareLinkUrl(origin: string, link: Pick<DocumentStoreShareLink, 'token'>): string {
  return `${origin}/s/lib/${link.token}`;
}

/** 数字短链地址；没生成过（ShortSeq<=0）返回 null，由调用方决定是否提供「生成」入口。 */
export function shareShortUrl(
  origin: string,
  link: Pick<DocumentStoreShareLink, 'shortSeq'>,
): string | null {
  return link.shortSeq && link.shortSeq > 0 ? `${origin}/s/${link.shortSeq}` : null;
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

/**
 * 弹窗打开时的默认范围：手上有正在读的文档就落「只分享这一篇」。
 * 整库公开影响面更大、场景更少，绝不能当默认（2026-07-31 用户明确要求）。
 * entryId = 从文件树某篇进来；currentEntryId = 顶栏分享时正在阅读的那篇。
 */
export function resolveInitialShareScope(
  entryId: string | undefined,
  currentEntryId: string | undefined,
): ShareScope {
  return entryId ?? currentEntryId ? 'entry' : 'store';
}

/** 一句话讲清「拿到链接的人能看到什么」——弹窗里唯一需要用户理解的事。 */
export function describeShareScope(
  scope: ShareScope,
  storeName: string,
  entryTitle: string | undefined,
): string {
  return scope === 'entry'
    ? `拿到链接的人只能看到《${entryTitle ?? '当前文档'}》这一篇，看不到知识库里的其他文档。`
    : `拿到链接的人可以浏览「${storeName}」里的全部文档。`;
}
