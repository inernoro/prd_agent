/**
 * 发送时用哪一份画布。
 *
 * setCanvas 是异步的：同一个 tick 里刚把一张图加进画布就调发送，发送闭包读到的
 * `canvas` 还是旧的，解析器在里面找不到这张图，于是**这次生成完全没有参考图**，
 * 静默退化成纯文字。首页带图进画板就是这条路（Codex PR #1476 P1）。
 *
 * 组件里的 canvasRef 救不了：它在 useEffect 里同步，同一个 tick 同样是旧值。
 * 所以调用方必须把「刚加的这一个」直接递进来，由这里合并。
 */

export type MergeableCanvasItem = { key: string };

/**
 * state 画布 + 还没刷出来的新元素。
 *
 * key 相同时以 extra 为准——它是更新的那一版（比如刚补上 assetId 的同一张图）。
 * 顺序保持 state 在前、新增在后，与 setCanvas 的追加顺序一致，
 * 免得「谁是第一张」在两条路径上给出不同答案。
 */
export function mergeSendCanvas<T extends MergeableCanvasItem>(
  stateCanvas: readonly T[],
  extra?: readonly T[] | null,
): T[] {
  if (!extra || extra.length === 0) return [...stateCanvas];
  const overrides = new Map(extra.map((item) => [item.key, item]));
  const merged = stateCanvas.map((item) => overrides.get(item.key) ?? item);
  const seen = new Set(stateCanvas.map((item) => item.key));
  for (const item of extra) {
    if (!seen.has(item.key)) merged.push(item);
  }
  return merged;
}
