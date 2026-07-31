/**
 * 编辑一条自动发布规则时，如何写回 actions 数组（纯函数，可单测）。
 *
 * `PATCH /api/scheduled-jobs/:id` 把 actions **当权威全量**：传什么就是什么。
 * 而发布中心的自动发布页只列出「含有本目标 release 动作」的任务——那个任务完全
 * 可能同时还挂着 HTTP 回调、命令、或发往另一个环境的 release 动作。直接提交
 * 单元素数组，一次「把间隔从 30 分钟改成 60 分钟」就会把兄弟动作全删掉，
 * 而且没有任何提示（Codex review P2，2026-07-29）。
 */

export interface JobActionLike {
  id?: string;
  type: 'http' | 'command' | 'release';
  targetId?: string;
}

/**
 * 用 `next` 替换掉「本目标的那条 release 动作」，其余原样保留。
 *
 * - 新建（没有既有动作）→ 只有这一条；
 * - 匹配到 → 就地替换，沿用原 id（id 是任务内的稳定标识，换掉等于删旧增新）；
 * - 匹配不到（本目标的动作被别处删了）→ 追加，绝不静默丢弃用户刚填的内容；
 * - 只替换**第一条**匹配：同一目标出现两条 release 动作属于异常数据，
 *   全替会把它们合成一条，反而掩盖问题。
 */
export function mergeReleaseAction<Action extends JobActionLike>(
  existing: ReadonlyArray<Action> | undefined,
  targetId: string,
  next: Action,
): Action[] {
  if (!existing?.length) return [next];

  let replaced = false;
  const merged = existing.map((item) => {
    if (replaced || item.type !== 'release' || item.targetId !== targetId) return item;
    replaced = true;
    return { ...next, ...(item.id ? { id: item.id } : {}) };
  });

  return replaced ? merged : [...merged, next];
}
