/**
 * 「整页刷新时那一束光」的一次性闸门。
 *
 * 用户要的是 iPhone 那种唤醒：一束光从左上斜着扫下来，页面跟着被点亮，
 * **而且只在整页刷新时发生**——在应用内点来点去回到这一页不该再放一遍，
 * 那会从「唤醒」退化成「每次进来都闪一下」，很快就烦人。
 *
 * 实现上不需要读 performance navigation，也不需要写 storage：
 * ES 模块在一个 document 里只会被实例化一次，所以模块作用域的这个布尔量
 * 天然就是「每次整页加载一次」。SPA 路由切换不会重新求值这个模块，
 * 于是第二次进页面拿到的就是 false。硬刷新会重建整个 document，它又变回 true。
 *
 * 这也意味着它**不可测试于跨用例之间**（模块状态会在同一个测试文件里留存），
 * 所以导出 resetWakeForTest 给测试显式复位——不这么做的话，
 * 第二个用例会拿到被第一个用例消费掉的 false，测出一个假绿。
 */
let pending = true;

/**
 * 取走这一次唤醒机会。第一次调用返回 true，之后一律 false。
 *
 * 命名用 consume 而不是 shouldPlay：它有副作用，读一次就没了。
 * 叫 shouldPlay 会让调用方以为可以随便读，然后在 render 里读两次就再也不播。
 */
export function consumeWakeOnce(): boolean {
  if (!pending) return false;
  pending = false;
  return true;
}

/** 仅供测试复位模块状态。 */
export function resetWakeForTest(): void {
  pending = true;
}
