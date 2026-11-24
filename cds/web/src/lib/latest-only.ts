/**
 * 「只认最新那次请求的结果」。
 *
 * 治的是同一个组件实例被复用时的**慢响应覆盖**：从 `/settings/A#backup` 切到
 * `/settings/B#backup`，React Router 复用同一个组件，A 的请求还在飞；A 慢一点回来，
 * 它的 `setData` 就落在 B 的后面，于是 B 的设置页上摆着 A 的备份目标、目录和失败详情
 * ——而页面上没有任何东西提示这不是它的（Codex review 第八轮 P2）。
 *
 * 单独成一个模块是为了**能被真跑一遍**：这个仓库的 web 测试没有 DOM 环境，
 * 组件里的竞态断言不出来；判定抽出来之后，用例可以按真实时序跑两次请求，
 * 断言只有最新那次的结果被采纳，而不是去源码里找某个字符串在不在（形状 4）。
 *
 * 用法：
 *
 * ```ts
 * const latest = createLatestOnly();
 * async function refresh() {
 *   const isCurrent = latest.begin();
 *   const body = await fetchSomething();
 *   if (!isCurrent()) return;   // 已经切走了，这份结果作废
 *   setData(body);
 * }
 * ```
 */
export interface LatestOnly {
  /** 开一次新请求，返回「此刻它还是最新的那次吗」。 */
  begin: () => () => boolean;
}

export function createLatestOnly(): LatestOnly {
  let seq = 0;
  return {
    begin() {
      const mine = ++seq;
      return () => mine === seq;
    },
  };
}
