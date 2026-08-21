/**
 * 未登录被弹去登录页时，把当前路由的 fragment 存起来，登录完再取回。
 *
 * 为什么不能把 fragment 直接塞进 `?returnUrl=`：
 * 有些 fragment 里装的正是**不该出现在 query 里的东西**——跨实例同步的授权回跳
 * 是 `#code=...&state=...`，那个一次性授权码之所以走 fragment，就是因为 fragment
 * 不会被浏览器发给服务器、不会进 access log、不会随 Referer 外泄。把它挪进
 * `returnUrl` 等于把这层保护亲手拆掉：登录页会带着这个 query 发同源请求，
 * SSO 路径还会把 returnUrl 拼进外部重定向地址，于是它一路进日志、进第三方。
 *
 * 所以这里存的是**值**，URL 上只留一个不含语义的引用键。键每次新生成，
 * 两个标签页同时被弹去登录也不会互相覆盖。
 */
const PREFIX = 'auth:return-fragment:';

/** 存下 fragment（含开头的 `#`），返回放进 URL 的引用键；没东西可存时返回空串。 */
export function stashReturnFragment(fragment: string): string {
  if (!fragment || fragment === '#') return '';
  const key = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    sessionStorage.setItem(PREFIX + key, fragment);
  } catch {
    // 存不下（隐私模式 / 配额）就退化成「登录后回到那一页但没有 fragment」，
    // 页面会提示重新发起——比把授权码泄进 query 好。
    return '';
  }
  return key;
}

/** 取回并立即删除。取不到返回空串。 */
export function takeReturnFragment(key: string): string {
  if (!key) return '';
  try {
    const value = sessionStorage.getItem(PREFIX + key) || '';
    sessionStorage.removeItem(PREFIX + key);
    return value;
  } catch {
    return '';
  }
}
