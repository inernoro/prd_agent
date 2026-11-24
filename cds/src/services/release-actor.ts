import { establishAgentOperationContext } from './agent-operation-context.js';

/** 发布责任人只来自认证中间件，客户端声明的用户名 / trigger 不构成身份。 */
export function resolveReleaseActorFromRequest(request: unknown): string {
  // 保留对话上下文采集能力；声明上下文与认证责任人使用不同信任口径。
  establishAgentOperationContext(request);
  const req = request as {
    cdsUser?: { id?: string; name?: string | null; username?: string | null; githubLogin?: string };
    cdsProjectKey?: { projectId: string; keyId: string };
  } | null;
  if (req?.cdsUser?.id) {
    const user = req.cdsUser;
    const label = user.name || user.username || user.githubLogin || user.id;
    return `user:${encodeURIComponent(clean(user.id!))}:${encodeURIComponent(clean(label!))}`;
  }
  if (req?.cdsProjectKey?.keyId) return `ai:key:${clean(req.cdsProjectKey.keyId)}`;
  return 'unknown';
}
function clean(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200);
}
