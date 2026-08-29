/**
 * 分享可见性三档的**唯一**文案与语义来源。
 *
 * 为什么要单独一份：这份 label 在改造前被抄成了四份（quickShare / SharePreviewPane /
 * SiteContextPanel / SharesWorkspace），四处各写一遍就是 predicate-and-wiring-discipline
 * 形状 3——其中三份把 owner-only 写成「仅我可见」，而后端 `EnforceShareVisibilityAsync`
 * 对这一档放行的是「创建者 + 该站点已共享团队的成员」。文案与实际放行范围不一致，
 * 分享者会以为发出去的链接同事打不开。
 *
 * 这里只改文案让它说实话，不改后端放行范围：把 owner-only 收紧成真正的「只有我」，
 * 会让存量链接对协作者当场失效，那是产品语义变更，不在本次改造范围内。
 */

export type ShareVisibility = 'owner-only' | 'logged-in' | 'public';

/** 下拉与徽章上的短标签。必须与 ACCESS_HINT 描述的放行范围一致。 */
export const VISIBILITY_LABEL: Record<ShareVisibility, string> = {
  'owner-only': '仅我和协作者',
  'logged-in': '登录可见',
  public: '公开',
};

/** 「谁能打开」的一句话说明，用于 title / 副文案。 */
export const VISIBILITY_ACCESS_HINT: Record<ShareVisibility, string> = {
  'owner-only': '我自己，以及这个站点已共享团队里的成员。团队外的人登录了也打不开。',
  'logged-in': '任何登录本平台的人都能打开。',
  public: '任何拿到链接的人都能打开，不需要登录。',
};

/**
 * 任意字符串 → 实际生效的可见性档。
 *
 * 存量链接没有 visibility 字段（反序列化出空串/undefined），后端读路径把这种 legacy 值
 * **按 public 处理**——不这么兼容，功能上线那一刻所有旧链接会被一起拒掉。所以界面也必须
 * 按 public 显示：默认成 owner-only 会告诉用户「只有你能打开」，而真相是任何人都能打开。
 * 往「更安全」的方向猜，在这里恰恰是最危险的猜法。
 *
 * 这条判据只许有这一份：改造前它被抄成了三处，其中一处的兜底写成了 owner-only。
 */
export function normalizeVisibility(value: string | null | undefined): ShareVisibility {
  if (value === 'owner-only' || value === 'logged-in' || value === 'public') return value;
  return 'public';
}

/** 短标签，输入是任意存量字符串。 */
export function visibilityLabelOf(value: string | null | undefined): string {
  return VISIBILITY_LABEL[normalizeVisibility(value)];
}
