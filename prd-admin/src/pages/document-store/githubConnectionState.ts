/**
 * GitHub 连接状态的判据（纯函数，便于单测）。
 *
 * 后端的连接状态接口只回答「这个用户名下有没有存过 token」，不校验 token 还能不能用——
 * 校验一次就要多打一次 GitHub。代价是：token 被撤销 / 过期 / 换了账号之后，
 * 状态仍是「已连接」，向导会跳过第一步直奔选仓库，然后每一步都报错。
 * 所以凡是「连接本身坏了」的错误码，界面都必须给出重连出口，否则用户卡死在中间。
 */

/** 意味着「这条连接已经不能用了」的后端错误码 */
const CONNECTION_BROKEN_CODES = new Set([
  'GITHUB_TOKEN_EXPIRED',
  'GITHUB_NOT_CONNECTED',
]);

export function isGitHubConnectionBroken(code?: string | null): boolean {
  return code != null && CONNECTION_BROKEN_CODES.has(code);
}

/** 连接坏掉时给用户的一句话：说清发生了什么 + 下一步做什么 */
export function connectionBrokenHint(code?: string | null): string | null {
  if (!isGitHubConnectionBroken(code)) return null;
  return code === 'GITHUB_NOT_CONNECTED'
    ? '这个账号还没有连接 GitHub，重新授权一次即可继续。'
    : '保存的 GitHub 授权已失效（可能已过期或被撤销），重新授权一次即可继续。';
}
