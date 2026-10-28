/** 排队重派专用进程能力：只认实际回环连接、短时签名和协调器当前领取。 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request, RequestHandler } from 'express';
import { BranchOperationCoordinator, pendingDeployBody, pendingDeployRoute, type PendingWebhookDeploy } from './branch-operation-coordinator.js';
import { isLoopbackAddress } from './self-check-auth.js';

const SCHEME = 'CDS-Pending-Replay ';
const TTL_MS = 30_000;
const META = ['x-cds-internal', 'x-cds-trigger', 'x-cds-request-id', 'x-cds-source-project-id', 'x-cds-source-branch-id'] as const;

function metadata(pending: PendingWebhookDeploy, projectId: string): Record<string, string> {
  return { 'x-cds-internal': '1', 'x-cds-trigger': pending.request.trigger,
    'x-cds-request-id': pending.request.requestId || pending.operationId,
    'x-cds-source-project-id': projectId, 'x-cds-source-branch-id': pending.branchId };
}
function finiteBody(body: unknown): body is { commitSha?: string; pendingReplay: { operationId: string; generation: number } } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const value = body as Record<string, unknown>;
  if (Object.keys(value).some(key => key !== 'commitSha' && key !== 'pendingReplay')) return false;
  if ('commitSha' in value && (typeof value.commitSha !== 'string' || value.commitSha.length > 40)) return false;
  const identity = value.pendingReplay as Record<string, unknown> | undefined;
  return Boolean(identity && typeof identity === 'object' && !Array.isArray(identity)
    && Object.keys(identity).length === 2 && typeof identity.operationId === 'string'
    && identity.operationId.length > 0 && identity.operationId.length <= 64
    && Number.isSafeInteger(identity.generation) && Number(identity.generation) > 0);
}

export interface InternalPendingReplayAuth {
  headersFor(url: string, pending: PendingWebhookDeploy, projectId: string): Record<string, string>;
  middleware(deps: { coordinator?: BranchOperationCoordinator; projectForBranch: (branchId: string) => string | undefined }):
    { gate: RequestHandler; isTrusted: (req: Request) => boolean };
}

export function createInternalPendingReplayAuth(): InternalPendingReplayAuth {
  const key = randomBytes(32); // 不落盘、不返回、不使用用户/项目凭据；重启即失效。
  const sign = (issued: number, port: number, route: string, body: string, headers: Record<string, string>) =>
    createHmac('sha256', key).update(JSON.stringify([issued, port, route, body, ...META.map(name => headers[name])])).digest('hex');
  return {
    headersFor(url: string, pending: PendingWebhookDeploy, projectId: string): Record<string, string> {
      const target = new URL(url);
      const route = pendingDeployRoute(pending);
      if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || !target.port
        || target.username || target.password || target.search || target.hash || target.pathname !== route
        || !['deploy', 'deploy-profile'].includes(pending.request.kind)
        || (pending.request.projectId || 'default') !== projectId) throw new Error('排队重派地址或项目不匹配');
      const issued = Date.now(); const headers = metadata(pending, projectId);
      return { ...headers, 'content-type': 'application/json',
        authorization: SCHEME + issued + '.' + sign(issued, Number(target.port), route, JSON.stringify(pendingDeployBody(pending)), headers) };
    },
    middleware(deps: { coordinator?: BranchOperationCoordinator; projectForBranch: (branchId: string) => string | undefined }) {
      const trusted = new WeakSet<Request>();
      const gate: RequestHandler = (req, res, next) => {
        const authorization = req.headers.authorization;
        if (typeof authorization !== 'string' || !authorization.startsWith(SCHEME)) return next();
        const deny = () => { res.status(401).json({ error: 'invalid_pending_replay' }); };
        const match = /^CDS-Pending-Replay (\d{13})\.([a-f0-9]{64})$/.exec(authorization);
        if (!match || req.method !== 'POST' || !isLoopbackAddress(req.socket.remoteAddress)
          || !req.socket.localPort || !finiteBody(req.body)) return deny();
        const issued = Number(match[1]); const age = Date.now() - issued;
        if (age < 0 || age > TTL_MS) return deny();
        const pending = deps.coordinator?.getClaimedPendingReplay(req.body.pendingReplay);
        if (!pending) return deny();
        const projectId = deps.projectForBranch(pending.branchId);
        if (!projectId || projectId !== (pending.request.projectId || 'default')) return deny();
        const route = pendingDeployRoute(pending);
        if (req.originalUrl !== route) return deny(); // 包括 query/一次性选项，一概不允许扩大原范围。
        const body = pendingDeployBody(pending);
        if (req.body.commitSha !== body.commitSha) return deny();
        const headers = metadata(pending, projectId);
        if (META.some(name => req.headers[name] !== headers[name])) return deny();
        const expected = sign(issued, req.socket.localPort, route, JSON.stringify(body), headers);
        if (!timingSafeEqual(Buffer.from(match[2], 'hex'), Buffer.from(expected, 'hex'))) return deny();
        trusted.add(req); return next();
      };
      return { gate, isTrusted: (req: Request) => trusted.has(req) };
    },
  };
}

/** 两个真实 pending 派发器与 server 共用本进程的唯一能力。 */
export const internalPendingReplayAuth = createInternalPendingReplayAuth();
