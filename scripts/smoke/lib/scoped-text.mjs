/**
 * 每日验收的「读一块 DOM 的文本」判据。
 *
 * 单独成模块不是为了复用，是为了**能被真的执行**：它原先长在 daily-acceptance.mjs 里，
 * 而那个脚本一 import 就会起浏览器，于是守卫只能扫源码字面量——扫不出「它到底跑不跑得起来」。
 * 2026-08-29 f3dcff1 的柯里化闭包就是这么绿着进 main 的。
 *
 * 这个函数会被 page.evaluate **序列化成源码**丢进浏览器执行，所以有一条硬约束：
 * 只许引用自己的参数和浏览器全局（document），不许引用任何模块作用域的东西——
 * 闭包不会跟着序列化过去，引用了就是运行时 ReferenceError。
 *
 * 参数写成一个数组而不是两个形参，是因为 page.evaluate 只传一个 arg。
 */
export function readScoped([sel, n]) {
  const root = sel ? document.querySelector(sel) : document.body;
  if (!root) return null;
  const t = root.innerText.replace(/\s+/g, '');
  return { chars: t.length, hit: n ? t.includes(n) : false };
}
