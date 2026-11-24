/**
 * 取「这个请求真正来自谁」。
 *
 * Express 的 `req.ip` 在 nginx 后面恒等于本机代理地址（生产链路见
 * `cds/exec_cds.sh` 生成的配置，且本应用没有开 `trust proxy`）。任何按来源
 * 分桶的逻辑——限流、审计、封禁——若直接用它，所有外部调用方会被并成同一个桶：
 * 一个人打满配额，其他人全部吃 429。
 *
 * 取值顺序与 server.ts / forwarder 一直以来的口径一致：Cloudflare 头优先，
 * 其次 X-Forwarded-For 的第一跳，最后才退回 socket 地址。
 *
 * 注意这几个头是客户端可伪造的：它们**只配用来分桶**（把不同来源分开），
 * 不足以当身份或鉴权依据。
 */
export function clientAddressOf(req: {
  headers: Record<string, unknown>;
  ip?: string;
  socket?: { remoteAddress?: string };
}): string {
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf.trim()) return cf.trim();
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string') {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.ip || req.socket?.remoteAddress || 'unknown';
}
