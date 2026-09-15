/**
 * GitHub 连接状态的判据（纯函数，便于单测）。
 *
 * 状态接口的 connected 只回答「这个用户名下有没有存过 token」；它为真时后端会再真打一次
 * GitHub，把「现在还认不认」放进 usable 三态（2026-09-15 前只有 connected，于是 token 被撤销后
 * 界面照样显示已连接、直奔选仓库，然后每一步都报错）。
 *
 * 两条判据因此并存，管的是不同时刻：usable 管**进门时**该停在哪一步；
 * 错误码管**进门之后**任一请求把连接判死时的重连出口。都不能省。
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

/**
 * 拿到连接状态后，向导该停在「连接」这一步还是直接跳到「选仓库」。
 *
 * 判据看两件事，缺一不可：**存过连接**，而且它**现在还认**。
 * 只看 connected 就会出现：用户在 GitHub 那边撤销了授权，向导照样跳到选仓库，
 * 然后仓库列表报 401——错误发生在第二步，而该修的事在第一步。
 *
 * unknown 一律放行：那是「没问出结论」（网络抖动、限额），把它当失效会把正常连接挡在门外。
 */
export function shouldResumeAtRepoStep(status: {
  connected: boolean;
  usable?: 'usable' | 'revoked' | 'unknown' | null;
}): boolean {
  if (!status.connected) return false;
  return status.usable !== 'revoked';
}

/** 连接记录还在、但 GitHub 已经不认了——这一句要摆在「连接」那一步上 */
export function revokedConnectionHint(status: {
  connected: boolean;
  usable?: 'usable' | 'revoked' | 'unknown' | null;
}): string | null {
  if (!status.connected || status.usable !== 'revoked') return null;
  return 'GitHub 上的授权已被撤销或失效，本地还留着一条旧记录。重新授权一次即可继续。';
}

/**
 * 「换个账号」那一步要不要说出当前连的是谁。
 *
 * 只有在旧连接**此刻还真的有效**时才说——这句话的全文是「当前连接的是 X，它现在仍然有效」，
 * 用来安抚用户「授权成功才会替换，失败也不会把你现在的连接弄丢」。
 * 但走到这一步的另一条路是「授权已被撤销 → 点重新连接」，那条路上旧连接恰恰已经失效，
 * 再说它仍然有效就是自相矛盾（2026-09-15 Codex review P2）。
 */
export function replacingLoginLabel(
  status: { connected: boolean; usable?: 'usable' | 'revoked' | 'unknown' | null; login?: string | null } | null,
  switchingAccount: boolean,
): string | null {
  if (!switchingAccount || !status?.connected) return null;
  if (status.usable === 'revoked') return null;
  return status.login ?? null;
}
