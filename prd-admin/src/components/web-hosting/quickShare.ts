import type { ShareLinkItem } from '@/services/real/webPages';

/**
 * 「一步分享」的判据。
 *
 * 背景（2026-08-25 用户反馈）：「分享页面过于复杂，分享列表又过于丑陋…用户只关心默认值
 * 并且无需两个弹窗，知识库那种分享就挺好的，垂直一个下拉框即可分享，点击高级才弹窗」。
 * 原来的路径是「点分享 → 开分享管理弹窗 → 点新建 → 再开一个 820px 的配置弹窗」，
 * 两层弹窗、十几个控件，只为了拿一条链接。
 *
 * 这里只放**判据与文案**，不碰 React 与网络：判据能被直接测（quickShare.test.ts），
 * 不必先把整个面板挂起来。
 */

export type { ShareVisibility } from './shareVisibility';
import { normalizeVisibility, type ShareVisibility } from './shareVisibility';

/**
 * 下拉面板一键生成用的默认值。
 *
 * 为什么不是配置弹窗那套默认（owner-only + 密码 + 7 天）：那套是给「先建出来自己核一遍
 * 再改档发出去」准备的，链接建出来**只有自己打开有内容**。放到一键分享上就是南辕北辙——
 * 用户点「分享」就是要发给别人，拿到一条别人打不开的链接，等于什么都没做成。
 *
 * 选 logged-in 而不是 public：默认不放给匿名访客，同时能拿到访客名单；
 * 需要发给站外的人，面板里改一下「谁能打开」就是了（就地改，不必重建）。
 * 密码默认不加：登录可见已经挡住了匿名转发，再加一道密码只是让分享者多抄一行字。
 */
export const QUICK_SHARE_DEFAULTS = {
  visibility: 'logged-in' as ShareVisibility,
  expiresInDays: 7,
};

// 短语域：下拉里每行只有一个词的宽度。语义必须与 ./shareVisibility 的 SSOT 一致——
// owner-only 放行的是「创建者 + 站点已共享团队的成员」，不是字面上的「只有我」。
export const VISIBILITY_LABEL: Record<ShareVisibility, string> = {
  'owner-only': '我和协作者',
  'logged-in': '登录的人',
  public: '任何人',
};

/** 每一档「选了它会发生什么」——面板展开时显示在选项右边，用户不必去猜三个词的差别 */
export const VISIBILITY_HINT: Record<ShareVisibility, string> = {
  'owner-only': '我和站点协作者能打开，其他人是「无权限」',
  'logged-in': '登录后可打开，能看到谁看过',
  public: '不登录也能打开，含站外的人',
};

/** 面板里可选的有效期档位。0 = 永久 */
export const EXPIRY_OPTIONS: { days: number; label: string }[] = [
  { days: 1, label: '1 天' },
  { days: 7, label: '7 天' },
  { days: 30, label: '30 天' },
  { days: 0, label: '永久' },
];

/**
 * 这条链接实际生效的可见性档。
 *
 * 存量链接没有 visibility 字段（反序列化出空串/undefined），后端的读路径把这种
 * legacy 值**按 public 处理**——不这么兼容的话，功能上线那一刻所有旧链接会被一起拒掉。
 * 所以面板也必须按 public 显示：默认成 owner-only 会告诉用户「只有你自己能打开」，
 * 而真相是任何拿到链接的人都能打开。往「更安全」的方向猜，在这里恰恰是最危险的猜法。
 */
export function resolveVisibility(link: { visibility?: string | null }): ShareVisibility {
  return normalizeVisibility(link.visibility);
}

/** 这条链接现在还打得开吗（未撤销、未过期） */
export function isLiveShareLink(link: ShareLinkItem, now: number): boolean {
  if (link.isRevoked) return false;
  if (!link.expiresAt) return true;
  const at = new Date(link.expiresAt).getTime();
  return Number.isNaN(at) ? true : at > now;
}

/**
 * 这个站点当前该在面板里显示哪一条链接。
 *
 * 只认**单站点**分享：合集链接指向一堆站点，在单个站点的面板里改它的可见性会波及其他站点，
 * 那不是用户在这个入口的意图。判据与卡片上的「已分享」标记同源，两处必须是同一条口径，
 * 否则会出现「卡片说已分享、点开面板却让你重新生成」。
 *
 * 多条有效链接时取**最晚过期**的那条（永久链视为最晚）：用户在这个面板里要的是
 * 「一条能发出去的链接」，给他寿命最长的那条最符合预期；同为永久时取最近创建的。
 */
export function pickQuickShareLink(
  links: ShareLinkItem[],
  siteId: string,
  now: number = Date.now(),
): ShareLinkItem | null {
  const mine = links.filter((l) => {
    if (!isLiveShareLink(l, now)) return false;
    if (l.shareType === 'collection') return false;
    const ids = l.siteIds?.length ? l.siteIds : l.siteId ? [l.siteId] : [];
    return ids.length === 1 && ids[0] === siteId;
  });
  if (mine.length === 0) return null;

  // 永久链排在最前：先比是否相等再相减，别直接 `rank(b) - rank(a)` —— 两条永久链
  // 会算出 Infinity - Infinity = NaN，sort 拿到 NaN 的比较结果顺序就随实现而定了。
  const rank = (l: ShareLinkItem) => (l.expiresAt ? new Date(l.expiresAt).getTime() : Number.POSITIVE_INFINITY);
  return mine.slice().sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return rb - ra;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  })[0];
}

/** 对外发的地址。恒用不可枚举长链；数字短链 /s/{seq} 是高级选项，不在这里主推 */
export function quickShareUrl(origin: string, link: ShareLinkItem): string {
  return `${origin}/s/wp/${link.token}`;
}

/**
 * 有效期那一行右边显示什么。
 *
 * 「剩 0 天」是个会误导人的说法（听起来像已经废了，其实今天还能用），所以不足一天
 * 走「今天内过期」。已过期的链接不该出现在这个面板（pickQuickShareLink 已经滤掉），
 * 真出现了就如实说过期，不装作还有效。
 */
export function expiryLabel(expiresAt: string | undefined, now: number = Date.now()): string {
  if (!expiresAt) return '永不过期';
  const at = new Date(expiresAt).getTime();
  if (Number.isNaN(at)) return '永不过期';
  const ms = at - now;
  if (ms <= 0) return '已过期';
  const days = Math.floor(ms / 86400000);
  if (days < 1) return '今天内过期';
  return `${days} 天后过期`;
}

/**
 * 面板顶上那句状态话：拿到链接的人能看到什么、能看多久。
 *
 * 一句话就把这条链接的全部对外语义说完，用户不用把三行设置在脑子里拼一遍
 * （conclusion-before-numbers：先给结论，再给可改的那几行）。
 */
export function describeQuickShare(link: ShareLinkItem, now: number = Date.now()): string {
  const v = resolveVisibility(link);
  // 三档的措辞必须与 ./shareVisibility 的 SSOT 同义。owner-only 这一档尤其不能写成
  // 「只有你自己」——后端放行的是「创建者 + 站点已共享团队的成员」。上一轮改标签时
  // 漏了这一句，同一个面板于是自相矛盾：选项写「我和协作者」，上面这句写「只有你自己」。
  const who = v === 'public'
    ? '任何拿到链接的人（含未登录）'
    : v === 'owner-only'
      ? '你自己和这个站点的协作者'
      : '任何登录的人';
  const pwd = link.accessLevel === 'password' ? '，还需要输密码' : '';
  const life = link.expiresAt ? expiryLabel(link.expiresAt, now) : '永不过期';
  return `${who}都能打开这个站点${pwd}；${life}。`;
}
