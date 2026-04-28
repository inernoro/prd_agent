/**
 * Actor resolver — 从 HTTP 请求 header 推断"是谁在调"。
 *
 * 用于 activity log 的 actor 字段。原本 branches.ts 和 bridge.ts 各
 * 写了一份一模一样的实现（Bugbot Low review），统一抽成本模块避免
 * 哪天加新 header（比如新的 AI agent 鉴权方式）漏掉一个 callsite。
 *
 * 解析顺序：
 *   1. X-AI-Impersonate header → `ai:<username>`（带具体 AI agent 用户名）
 *   2. X-AI-Access-Key / X-CDS-AI-Token → `ai`（匿名 AI 调用）
 *   3. 其它（cookie 登录的真人 / 内部组件） → `user`
 *
 * 输入是 `unknown` 是因为 Express Request 的类型在前端 vs Node 上下文
 * 差异较大；本函数只关心 `req.headers` 的 shape，不依赖具体 framework。
 */

export function resolveActorFromRequest(req: unknown): string {
  const headers = (req as { headers?: Record<string, string | string[] | undefined> })
    ?.headers || {};
  const impersonate = headers['x-ai-impersonate'];
  if (typeof impersonate === 'string' && impersonate) return `ai:${impersonate}`;
  if (Array.isArray(impersonate) && impersonate[0]) return `ai:${impersonate[0]}`;
  const aiKey = headers['x-ai-access-key'] || headers['x-cds-ai-token'];
  if (aiKey) return 'ai';
  return 'user';
}
