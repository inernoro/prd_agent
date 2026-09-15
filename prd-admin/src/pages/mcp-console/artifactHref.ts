/**
 * 产物地址能不能直接放进 `<a href>`。
 *
 * 这个地址来自**登记表里的动态接口** —— 谁登记的谁决定它是什么。`javascript:` 与
 * `data:text/html,` 在 React 18 下并不会被可靠拦住，于是「点开刚做出来的东西」就成了
 * 点开对方塞进来的一段脚本。协议相对（`//host`）也不收：它看着像站内路径，实际跟着
 * 当前页协议去了外站。
 *
 * 后端 `McpArtifactExtractor.SafeArtifactUrl` 在落库前已经拦过同一件事；这里再拦一次，
 * 是因为库里还躺着那道闸之前写下的记录，而这一行就是它们变成 href 的地方。
 */
export function safeArtifactHref(url: string | null | undefined): string | null {
  const s = (url ?? '').trim();
  if (!s) return null;
  if (s.startsWith('//')) return null;
  if (s.startsWith('/')) return s;
  if (/^https?:\/\//i.test(s)) return s;
  return null;
}
