/**
 * 「整页刷新时那一束光」的一次性闸门。
 *
 * 用户要的是 iPhone 那种唤醒：一束光从左上斜着扫下来，页面跟着被点亮，
 * **而且只在整页刷新时发生**——在应用内点来点去回到这一页不该再放一遍，
 * 那会从「唤醒」退化成「每次进来都闪一下」，很快就烦人。
 *
 * 上一版只有一个模块作用域的布尔量，注释里写着「ES 模块在一个 document 里只会被
 * 实例化一次，所以它天然就是每次整页加载一次」。这句话本身没错，错在它证明的是
 * **每个 document 一次**，而不是**这次加载是不是刷新到了这一页**——两者不是一回事：
 * 文档在 `/` 打开、用户点进 `/visual-agent`，是这个 document 里第一次消费，
 * 于是一次普通的 SPA 跳转放出了「整页刷新」才该有的动画（Codex PR #1476 P2）。
 * 从编辑器深链返回列表页同理。判据纪律形状 1：判据比它该管的范围窄——
 * 「一生一次」不等于「来源是刷新」。
 *
 * 现在多问一句来源：这个 document **最初加载的就是当前这一页**吗？
 * - 刷新 / 直接输地址 / 深链进来 → 初始 URL 就是本页 → 放。
 * - 从别的路由 SPA 跳进来 → 初始 URL 是别处 → 不放。
 * 来源取自 PerformanceNavigationTiming 的 `name`（它是**文档**的 URL，
 * pushState 不会改写它），所以 SPA 改了地址栏也骗不过它。
 *
 * 取不到这个来源（浏览器不支持 / 被禁用）时**不放**：宁可少一个装饰动画，
 * 也不要在普通跳转里放一个「刚刚刷新过」的假信号（no-rootless-tree：不假装知道）。
 *
 * 模块状态会在同一个测试文件里留存，所以导出 resetWakeForTest 给测试显式复位——
 * 不这么做的话，第二个用例会拿到被第一个用例消费掉的 false，测出一个假绿。
 */
let pending = true;

/** 去掉结尾斜杠，`/visual-agent/` 与 `/visual-agent` 是同一页。 */
function normalizePath(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

/**
 * 本 document **最初**加载的那个路径；取不到返回 null。
 *
 * 注意不能退而用模块求值时的 `location.pathname`：这个模块跟着页面 chunk 懒加载，
 * SPA 跳转过来时它才第一次求值，那时地址栏早已是目标页——量到的是「跳转后」，
 * 正是要区分的那两种情况里错的那一种（判据纪律形状 6：读到的不是真正生效的那个值）。
 */
function initialDocumentPath(): string | null {
  try {
    if (typeof window === 'undefined' || typeof performance?.getEntriesByType !== 'function') return null;
    const [nav] = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[];
    if (!nav?.name) return null;
    return normalizePath(new URL(nav.name, window.location.origin).pathname);
  } catch {
    return null;
  }
}

/**
 * 取走这一次唤醒机会。只有「本 document 最初加载的就是当前这一页」且尚未用掉时返回 true。
 *
 * 命名用 consume 而不是 shouldPlay：它有副作用，读一次就没了。
 * 叫 shouldPlay 会让调用方以为可以随便读，然后在 render 里读两次就再也不播。
 *
 * 来源不匹配时**不消费**那次机会——反正后续都是 SPA 跳转、都不会匹配，
 * 消不消费行为一样；不消费能让「机会」与「真的放了一次」保持一一对应。
 */
export function consumeWakeOnce(): boolean {
  if (!pending) return false;
  const initial = initialDocumentPath();
  if (initial === null) return false;
  if (initial !== normalizePath(window.location.pathname)) return false;
  pending = false;
  return true;
}

/** 仅供测试复位模块状态。 */
export function resetWakeForTest(): void {
  pending = true;
}
