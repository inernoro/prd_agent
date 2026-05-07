/**
 * Actor resolver — 从 HTTP 请求 header 推断"是谁在调"。
 *
 * 用于 activity log 的 actor 字段。原本 branches.ts 和 bridge.ts 各
 * 写了一份一模一样的实现（Bugbot Low review），统一抽成本模块避免
 * 哪天加新 header（比如新的 AI agent 鉴权方式）漏掉一个 callsite。
 *
 * 解析顺序：
 *   1. X-CDS-Trigger header → `system:<value>`(`webhook` / `slash-command` / `system`)
 *      用户反馈 2026-05-07：项目活动日志一律显示 'user',分不出 webhook 自动 vs
 *      用户手动。新增此 header 让内部 dispatch(github-webhook 触发的 deploy /
 *      stop / slash command 内部 HTTP)能自标"我是 webhook 来的"。
 *   2. X-AI-Impersonate header → `ai:<username>`（带具体 AI agent 用户名）
 *   3. X-AI-Access-Key / X-CDS-AI-Token → `ai`（匿名 AI 调用）
 *   4. 其它（cookie 登录的真人 / 内部组件） → `user`
 *
 * 输入是 `unknown` 是因为 Express Request 的类型在前端 vs Node 上下文
 * 差异较大；本函数只关心 `req.headers` 的 shape，不依赖具体 framework。
 */

export function resolveActorFromRequest(req: unknown): string {
  const headers = (req as { headers?: Record<string, string | string[] | undefined> })
    ?.headers || {};
  // 1. X-CDS-Trigger 优先 — 内部 HTTP 自调(webhook/slash command 触发的
  //    localhost POST)用此 header 自标,前端能区分手动 vs 自动。
  const trigger = headers['x-cds-trigger'];
  if (typeof trigger === 'string' && trigger) return `system:${trigger.toLowerCase()}`;
  if (Array.isArray(trigger) && trigger[0]) return `system:${String(trigger[0]).toLowerCase()}`;
  const impersonate = headers['x-ai-impersonate'];
  if (typeof impersonate === 'string' && impersonate) return `ai:${impersonate}`;
  if (Array.isArray(impersonate) && impersonate[0]) return `ai:${impersonate[0]}`;
  const aiKey = headers['x-ai-access-key'] || headers['x-cds-ai-token'];
  if (aiKey) return 'ai';
  return 'user';
}
