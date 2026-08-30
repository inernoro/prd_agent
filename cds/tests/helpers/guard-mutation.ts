/**
 * 红用例的正确形状。
 *
 * 事故（2026-08-30，Codex 在 PR #1454 指出）：本仓库多处「红用例」写成
 *
 *     const regressed = source.replace('修好的写法', '坏写法');
 *     expect(regressed).not.toContain('修好的写法');
 *
 * 这证明不了任何事。**生产代码一旦已经退化、源码里本就没有那段「修好的写法」，
 * `replace` 就是空操作，`not.toContain` 照样通过**——红用例在最该报警的那一刻
 * 反而是绿的。它只断言了「字符串替换函数能替换字符串」。
 *
 * 这是 predicate-and-wiring-discipline 形状 4 的一个变种：不是反向锁死 bug，
 * 而是一条**永远不会红的红用例**。仓库规则写着「一个不会红的证据比没有证据更糟」，
 * 因为它会让下一个人以为这件事已经验过了。
 *
 * 正确形状要满足两条：
 *   1. 变异必须**真的发生**（空操作即报错，说明锚点错了或代码已退化）；
 *   2. 必须把**同一个守卫谓词**分别跑在真源码与变异源码上，
 *      断言前者通过、后者抛错——而不是对着替换结果做字符串断言。
 */

/**
 * 做一次必定生效的文本变异。空操作直接抛：那意味着锚点找不到，
 * 要么守卫的断言已经和源码漂开，要么生产代码已经退化——两种都该当场报出来。
 */
export function mutate(source: string, from: string | RegExp, to: string): string {
  const out = source.replace(from as string, to);
  if (out === source) {
    throw new Error(
      `红用例的变异是空操作：源码里找不到锚点 ${JSON.stringify(String(from)).slice(0, 120)}。`
      + '这说明守卫锚点已漂移，或生产代码已经退化——无论哪种，这条红用例都不再证明任何事。',
    );
  }
  return out;
}

/**
 * 把同一个守卫谓词分别跑在真源码与变异源码上。
 *
 * @param guard 守卫谓词。断言失败时抛错（vitest 的 expect 即是如此）。
 * @param realSource 真实源码——守卫必须通过。
 * @param mutatedSource 变异后的源码——守卫必须失败。
 */
export function expectGuardRedOnMutation(
  guard: (source: string) => void,
  realSource: string,
  mutatedSource: string,
): void {
  if (mutatedSource === realSource) {
    throw new Error('变异源码与真源码相同，这条红用例是空转的。');
  }

  // 真源码上守卫必须通过：不通过说明守卫本身坏了，不是被守的东西坏了。
  guard(realSource);

  // 变异源码上守卫必须失败：不失败说明它没在测你以为它在测的东西。
  let threw = false;
  try {
    guard(mutatedSource);
  } catch {
    threw = true;
  }
  if (!threw) {
    throw new Error(
      '守卫在被变异的源码上仍然通过——它没在测你以为它在测的东西。'
      + '（predicate-and-wiring-discipline：用例不变红 = 判据是空的）',
    );
  }
}
