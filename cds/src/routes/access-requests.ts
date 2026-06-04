/**
 * 被动授权(Passive Access Grant)— 最短路径,用户只点一次「批准」。
 *
 * 链路(用户只碰 1 处):
 *   1. Agent 需要权限时,直接 POST /api/projects/:id/access-requests 发起申请。
 *      **无需任何预置密钥**(免密 + 按项目限量防刷);接口当场返回一个一次性
 *      「轮询票据」(pollToken)只给发起方。
 *   2. 右下角弹「授权申请」→ 用户点**批准**(唯一动作)→ CDS 当场签发一把
 *      全权项目 AgentKey(授权密钥),明文临时挂在申请记录上。
 *   3. Agent 凭 pollToken 轮询 GET .../:reqId 取走授权密钥(一次性,取走即清空),
 *      之后凭它做接下来的所有事(含直接从 CDS 读项目环境变量)。
 *
 * 安全:
 *   - 发起是免密的,但**只能创建一条 pending 申请**——不读不写不签发。按项目设
 *     pending 上限挡刷量;真正的密钥签发 100% 由用户亲手点批准,免密发起泄漏顶多
 *     是右下角多几条待批申请(骚扰),绝不会泄露任何密钥。
 *   - pollToken 只在发起响应里返回一次,攻击者拿不到 → 取不走别人批准的密钥。
 *   - 授权密钥明文只交付发起方一次,操作员审批面板永远看不到。
 */

import { Router } from 'express';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import type { StateService } from '../services/state.js';
import type { AccessRequest, AgentKey } from '../types.js';
import { cdsEventsBus } from '../services/cds-events-bus.js';

export interface AccessRequestsRouterDeps {
  stateService: StateService;
}

/** Audit retention: decided access requests disappear from list after 7d. */
const AUDIT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** 免密发起的防刷上限:同一项目最多这么多条待批申请。 */
const MAX_PENDING_PER_PROJECT = 10;

function newRequestId(): string {
  return randomBytes(6).toString('hex');
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** Extract the poll token from header X-Poll-Token or ?token= query. */
function extractPollToken(req: import('express').Request): string {
  const h = req.headers['x-poll-token'];
  if (typeof h === 'string' && h) return h;
  const q = req.query.token;
  return typeof q === 'string' ? q : '';
}

/** Strip the authorization-key plaintext + poll-token hash before returning to operator UI. */
function publicView(r: AccessRequest): Omit<AccessRequest, 'issuedKeyPlaintext' | 'pollTokenHash'> {
  const { issuedKeyPlaintext: _k, pollTokenHash: _t, ...rest } = r;
  return rest;
}

function pendingCount(stateService: StateService): number {
  return stateService.listAccessRequests().filter((r) => r.status === 'pending').length;
}

export function createAccessRequestsRouter(deps: AccessRequestsRouterDeps): Router {
  const { stateService } = deps;
  const router = Router();

  // ───────────────────────────────────────────────────────────────────────
  // Agent 通道:发起 / 轮询(免密,server.ts 已把这两个路径放行为 public)
  // ───────────────────────────────────────────────────────────────────────

  // 发起授权申请(免密 + 按项目限量)。返回一次性 pollToken。
  router.post('/projects/:id/access-requests', (req, res) => {
    const project = stateService.getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: 'project_not_found', message: `Project '${req.params.id}' does not exist.` });
      return;
    }
    if (stateService.countPendingAccessRequests(project.id) >= MAX_PENDING_PER_PROJECT) {
      res.status(429).json({
        error: 'too_many_pending',
        message: `项目 '${project.id}' 已有 ${MAX_PENDING_PER_PROJECT} 条待批授权申请,请先在 CDS 右下角处理。`,
      });
      return;
    }

    const body = (req.body || {}) as { agentName?: string; purpose?: string };
    const agentName = typeof body.agentName === 'string' && body.agentName.trim()
      ? body.agentName.trim().slice(0, 100) : 'AI Agent';
    const purpose = typeof body.purpose === 'string' && body.purpose.trim()
      ? body.purpose.trim().slice(0, 500) : '请求项目授权密钥(全权访问)。';

    const pollToken = randomBytes(24).toString('base64url');
    const item: AccessRequest = {
      id: newRequestId(),
      projectId: project.id,
      pollTokenHash: sha256(pollToken),
      agentName,
      purpose,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    stateService.addAccessRequest(item);
    cdsEventsBus.publish('access-request.created', {
      requestId: item.id, projectId: project.id, agentName, purpose, pendingCount: pendingCount(stateService),
    });
    res.status(201).json({ requestId: item.id, pollToken, status: 'pending' });
  });

  // 轮询授权结果(凭 pollToken)。批准后一次性交付授权密钥明文。
  router.get('/projects/:id/access-requests/:reqId', (req, res) => {
    // 用 getProject 把 slug/id 都解析成 project.id 再比对 —— 发起时存的是
    // project.id,调用方可能用 slug 轮询,直接字面比对会误判 404。
    const project = stateService.getProject(req.params.id);
    const item = stateService.getAccessRequest(req.params.reqId);
    if (!project || !item || item.projectId !== project.id) {
      res.status(404).json({ error: 'request_not_found', message: `Access request '${req.params.reqId}' not found.` });
      return;
    }
    // 校验 pollToken(timing-safe)——只有发起方持有。
    const token = extractPollToken(req);
    const tokenHash = token ? sha256(token) : '';
    const ok = tokenHash.length === item.pollTokenHash.length
      && timingSafeEqual(Buffer.from(tokenHash, 'hex'), Buffer.from(item.pollTokenHash, 'hex'));
    if (!ok) {
      res.status(403).json({ error: 'poll_token_invalid', message: '轮询票据无效。' });
      return;
    }

    if (item.status === 'pending') {
      res.json({ status: 'pending' });
      return;
    }
    if (item.status === 'rejected') {
      res.json({ status: 'rejected', rejectReason: item.rejectReason || null });
      return;
    }
    // approved
    if (item.issuedKeyPlaintext && !item.deliveredAt) {
      const authorizationKey = item.issuedKeyPlaintext;
      stateService.updateAccessRequest(item.id, { issuedKeyPlaintext: undefined, deliveredAt: new Date().toISOString() });
      res.json({ status: 'approved', authorizationKey });
      return;
    }
    res.json({ status: 'approved', delivered: true });
  });

  // ───────────────────────────────────────────────────────────────────────
  // 操作员通道:列表 / 批准 / 拒绝(走全局中间件 cookie / 全权 key 鉴权)
  // ───────────────────────────────────────────────────────────────────────

  router.get('/access-requests', (_req, res) => {
    const decidedCount = stateService.listAccessRequests().filter((r) => r.status !== 'pending').length;
    if (decidedCount > 20) stateService.pruneAccessRequests(AUDIT_RETENTION_MS);
    const list = stateService.listAccessRequests().map(publicView);
    res.json({ requests: list, pendingCount: list.filter((r) => r.status === 'pending').length });
  });

  function decider(req: import('express').Request): string {
    const gh = (req as unknown as { cdsUser?: { login?: string } }).cdsUser;
    if (gh?.login) return gh.login;
    if ((req as unknown as { _cdsCookieAuth?: boolean })._cdsCookieAuth) return 'cookie';
    return 'operator';
  }

  // 批准:当场签发一把全权项目 AgentKey(授权密钥),明文挂记录上待发起方取走一次。
  router.post('/access-requests/:reqId/approve', (req, res) => {
    const item = stateService.getAccessRequest(req.params.reqId);
    if (!item) {
      res.status(404).json({ error: 'request_not_found', message: `Access request '${req.params.reqId}' not found.` });
      return;
    }
    if (item.status !== 'pending') {
      res.status(409).json({ error: 'already_decided', message: `Access request already ${item.status}.` });
      return;
    }
    const project = stateService.getProject(item.projectId);
    if (!project) {
      res.status(404).json({ error: 'project_not_found', message: `Project '${item.projectId}' no longer exists.` });
      return;
    }
    // 授权密钥 = 全权项目 AgentKey(cdsp_*),与 POST /projects/:id/agent-keys 同格式。
    const now = new Date();
    const slugHead = project.slug.slice(0, 12).toLowerCase();
    const suffix = randomBytes(32).toString('base64url');
    const plaintext = `cdsp_${slugHead}_${suffix}`;
    const keyId = randomBytes(4).toString('hex');
    const decidedBy = decider(req);
    const keyEntry: AgentKey = {
      id: keyId,
      label: `授权密钥 (申请 ${item.id} · ${item.agentName})`,
      hash: sha256(plaintext),
      scope: 'rw',
      createdAt: now.toISOString(),
      createdBy: decidedBy === 'cookie' || decidedBy === 'operator' ? undefined : decidedBy,
    };
    try {
      stateService.addAgentKey(project.id, keyEntry);
      stateService.updateAccessRequest(item.id, {
        status: 'approved',
        decidedAt: now.toISOString(),
        decidedBy,
        issuedKeyId: keyId,
        issuedKeyPlaintext: plaintext,
      });
    } catch (err) {
      res.status(500).json({ error: 'state_save_failed', message: (err as Error).message });
      return;
    }
    cdsEventsBus.publish('access-request.decided', {
      requestId: item.id, projectId: project.id, status: 'approved', pendingCount: pendingCount(stateService),
    });
    res.json({ approved: true, requestId: item.id });
  });

  router.post('/access-requests/:reqId/reject', (req, res) => {
    const item = stateService.getAccessRequest(req.params.reqId);
    if (!item) {
      res.status(404).json({ error: 'request_not_found', message: `Access request '${req.params.reqId}' not found.` });
      return;
    }
    if (item.status !== 'pending') {
      res.status(409).json({ error: 'already_decided', message: `Access request already ${item.status}.` });
      return;
    }
    const body = (req.body || {}) as { reason?: string };
    const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim().slice(0, 300) : undefined;
    stateService.updateAccessRequest(item.id, {
      status: 'rejected',
      decidedAt: new Date().toISOString(),
      decidedBy: decider(req),
      rejectReason: reason,
    });
    cdsEventsBus.publish('access-request.decided', {
      requestId: item.id, projectId: item.projectId, status: 'rejected', pendingCount: pendingCount(stateService),
    });
    res.json({ rejected: true, requestId: item.id });
  });

  return router;
}
