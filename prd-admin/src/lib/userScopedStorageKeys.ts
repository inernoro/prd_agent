/**
 * 存在 localStorage 里、且**属于某一个人**的持久化键。
 *
 * 为什么要单独一份清单：这类数据的登出清理不能挂在各自 store 的模块副作用上。
 * 藏书阁踩过——`registerLogoutReset` 写在 `bookshelfStore.ts` 里，而那个 store
 * 只有懒加载路由 `BookshelfPage` 被打开时才求值。于是这条真实路径一路裸奔：
 *
 *   A 上次用过藏书阁（数据已落盘）→ 关掉浏览器 → 重开应用 →
 *   在别的页面登出（从没进过 /bookshelf，store 从没被求值，回调从没注册）→
 *   B 登录 → B 看到的是 A 的已读、笔记与成绩
 *
 * 同一个洞修到第三次才找对地方：前两次修的都是「登出时清 store」，
 * 而问题是**那段清理代码本身没被加载**（`predicate-and-wiring-discipline`
 * 形状 2 的一个变体——链路建好了，但它挂在一条不一定会走到的路上）。
 *
 * 所以清理必须由**一定会被加载**的那一侧发起：authStore 在 logout 里调
 * `clearUserScopedStorage()`，与 `clearAllOfflineEdits()` 同一个位置、同一个道理。
 *
 * 加新的 per-user 持久化 store 时，把它的 persist name 加进这张表。
 */
export const USER_SCOPED_STORAGE_KEYS = [
  /** 藏书阁进度：已读书目、一句话心得、结业考成绩 */
  'bookshelf-progress',
] as const;

/**
 * 登出时清掉上面那些键。
 *
 * 不依赖任何 store 是否已经被求值——这正是它存在的理由。
 * 已经加载过的 store 另有 `registerLogoutReset` 把内存态一并复位，两者互补：
 * 那条管「这个标签页里的内存」，这条管「这台设备的盘」。
 */
export function clearUserScopedStorage(): void {
  for (const key of USER_SCOPED_STORAGE_KEYS) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* 隐私模式 / 禁用存储：读写都可能抛，清不掉也不该让登出失败 */
    }
  }
}
