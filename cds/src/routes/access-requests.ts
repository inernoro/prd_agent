/**
 * 被动授权(Passive Access Grant)— 两把钥匙的最简实现。
 *
 * 背景:agent 反复需要用户把一大堆环境变量/参数喂进来,或为了拿日志/全权访问
 * 跪求用户暴露主密钥。本模块用「请求密钥 + 授权密钥」两级凭据消灭这件事:
 *
 *   1. 请求密钥(cdsr_*,永久、单项目、低权限):agent 的默认凭据。唯一能力是
 *      「发起授权请求 + 轮询结果」。走 server.ts 的 default-deny 白名单 —— 除
 *      本文件的两个 access-requests 端点外,任何 /api/* 都不认 cdsr_,泄漏也无法越权。
 *   2. agent POST /projects/:id/access-requests 发起申请 → 右下角审批盒弹出。
 *   3. 用户「派发」(批准)→ CDS 当场签发一把全权项目 AgentKey(授权密钥,cdsp_*),
 *      明文临时挂在申请记录上。
 *   4. agent 轮询 GET /projects/:id/access-requests/:reqId 取走授权密钥(一次性,
 *      取走即清空明文)。此后 agent 凭授权密钥做接下来的所有事 —— 包括从 CDS
 *      直接拉项目环境变量/参数,用户再不用手动喂。
 *
 * 安全要点:
 *   - 请求密钥 default-deny,只能发起/轮询,不能读不能写。
 *   - 授权密钥明文只在「已批准未交付」窗口存在,交付后清空,不长期持久化明文。
 *   - 操作员审批面板永远看不到授权密钥明文(只有持请求密钥的 agent 能取一次)。
 */

import { Router } from 'express';
import { randomBytes, createHash } from 'node:crypto';
import type { StateService } from '../services/state.js';
import type { AccessRequest, AgentKey, RequestKey } from '../types.js';
import { cdsEventsBus } from '../services/cds-events-bus.js';

export interface AccessRequestsRouterDeps {
  stateService: StateService;
}

/** Audit retention: decided access requests disappear from list after 7d. */
const AUDIT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Extract the bearer/header key exactly like server.ts resolveAiSession:
 * X-AI-Access-Key (canonical) / ai-access-key (alias) / Authorization: Bearer.
 */
function extractKey(req: { headers: Record<string, unknown> }): string | undefined {
  const h = req.headers;
  const direct = (h['x-ai-access-key'] as string | undefined) || (h['ai-access-key'] as string | undefined);
  if (direct) return direct;
  const auth = h['authorization'] as string | undefined;
  if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  return undefined;
}

function newRequestId(): string {
  return randomBytes(6).toString('hex');
}

/** Strip the authorization-key plaintext before returning to operator UI. */
function publicView(r: AccessRequest): Omit<AccessRequest, 'issuedKeyPlaintext'> {
  const { issuedKeyPlaintext: _omit, ...rest } = r;
  return rest;
}

function pendingCount(stateService: StateService): number {
  return stateService.listAccessRequests().filter((r) => r.status === 'pending').length;
}

export function createAccessRequestsRouter(deps: AccessRequestsRouterDeps): Router {
  const { stateService } = deps;
  const router = Router();

  // ───────────────────────────────────────────────────────────────────────
  // 请求密钥管理(操作员鉴权,走 server.ts 全局中间件 cookie / 全权 key)
  // ───────────────────────────────────────────────────────────────────────

  // 签发一把永久请求密钥。明文只在响应里出现一次。
  router.post('/projects/:id/request-keys', (req, res) => {
    const project = stateService.getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: 'project_not_found', message: `Project '${req.params.id}' does not exist.` });
      return;
    }
    const body = (req.body || {}) as { label?: string };
    const now = new Date();
    const defaultLabel = '请求密钥 签发于 ' + now.toISOString().replace('T', ' ').slice(0, 16);
    const label = typeof body.label === 'string' && body.label.trim()
      ? body.label.trim().slice(0, 100)
      : defaultLabel;

    // 明文 cdsr_<slugHead12>_<base64url 32 bytes>,前缀区别于全权 cdsp_。
    const slugHead = project.slug.slice(0, 12).toLowerCase();
    const suffix = randomBytes(32).toString('base64url');
    const plaintext = `cdsr_${slugHead}_${suffix}`;
    const hash = createHash('sha256').update(plaintext).digest('hex');
    const keyId = randomBytes(4).toString('hex');
    const ghUser = (req as unknown as { cdsUser?: { login?: string } }).cdsUser;

    const entry: RequestKey = {
      id: keyId,
      label,
      hash,
      createdAt: now.toISOString(),
      createdBy: ghUser?.login || undefined,
    };
    try {
      stateService.addRequestKey(project.id, entry);
    } catch (err) {
      res.status(500).json({ error: 'state_save_failed', message: (err as Error).message });
      return;
    }
    res.status(201).json({ keyId, plaintext });
  });

  router.get('/projects/:id/request-keys', (req, res) => {
    const project = stateService.getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: 'project_not_found', message: `Project '${req.params.id}' does not exist.` });
      return;
    }
    res.json({
      keys: stateService.getRequestKeys(project.id).map((e) => ({
        id: e.id,
        label: e.label,
        createdAt: e.createdAt,
        createdBy: e.createdBy,
        lastUsedAt: e.lastUsedAt,
        revokedAt: e.revokedAt,
        status: e.revokedAt ? 'revoked' : 'active',
      })),
    });
  });

  router.delete('/projects/:id/request-keys/:keyId', (req, res) => {
    const project = stateService.getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: 'project_not_found', message: `Project '${req.params.id}' does not exist.` });
      return;
    }
    const ok = stateService.revokeRequestKey(project.id, req.params.keyId);
    if (!ok) {
      res.status(404).json({ error: 'key_not_found', message: `Request key '${req.params.keyId}' not found.` });
      return;
    }
    res.json({ ok: true, keyId: req.params.keyId });
  });

  // ───────────────────────────────────────────────────────────────────────
  // agent 通道:发起 / 轮询(请求密钥自校验,default-deny 已在 server.ts 放行)
  // ───────────────────────────────────────────────────────────────────────

  // 用请求密钥校验:必须是有效 cdsr_ 且归属本 project。返回 keyId 或发送错误响应。
  function authRequestKey(req: import('express').Request, res: import('express').Response, projectId: string): string | null {
    const key = extractKey(req as unknown as { headers: Record<string, unknown> });
    if (!key || !key.startsWith('cdsr_')) {
      res.status(401).json({ error: 'request_key_required', message: '该端点只接受请求密钥(cdsr_*)。' });
      return null;
    }
    const match = stateService.findRequestKeyForAuth(key);
    if (!match) {
      res.status(401).json({ error: 'request_key_invalid', message: '请求密钥无效或已吊销。' });
      return null;
    }
    if (match.projectId !== projectId) {
      res.status(403).json({ error: 'request_key_project_mismatch', message: '请求密钥不属于该项目。' });
      return null;
    }
    stateService.touchRequestKeyLastUsed(match.projectId, match.keyId);
    return match.keyId;
  }

  // 发起授权申请。
  router.post('/projects/:id/access-requests', (req, res) => {
    const project = stateService.getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: 'project_not_found', message: `Project '${req.params.id}' does not exist.` });
      return;
    }
    if (!authRequestKey(req, res, project.id)) return;

    const body = (req.body || {}) as { agentName?: string; purpose?: string };
    const agentName = typeof body.agentName === 'string' && body.agentName.trim()
      ? body.agentName.trim().slice(0, 100) : 'AI Agent';
    const purpose = typeof body.purpose === 'string' && body.purpose.trim()
      ? body.purpose.trim().slice(0, 500) : '请求项目授权密钥(全权访问)。';

    const item: AccessRequest = {
      id: newRequestId(),
      projectId: project.id,
      agentName,
      purpose,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    stateService.addAccessRequest(item);
    cdsEventsBus.publish('access-request.created', {
      requestId: item.id, projectId: project.id, agentName, purpose, pendingCount: pendingCount(stateService),
    });
    res.status(201).json({ requestId: item.id, status: 'pending' });
  });

  // 轮询授权结果。批准后一次性交付授权密钥明文。
  router.get('/projects/:id/access-requests/:reqId', (req, res) => {
    const project = stateService.getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: 'project_not_found', message: `Project '${req.params.id}' does not exist.` });
      return;
    }
    if (!authRequestKey(req, res, project.id)) return;

    const item = stateService.getAccessRequest(req.params.reqId);
    if (!item || item.projectId !== project.id) {
      res.status(404).json({ error: 'request_not_found', message: `Access request '${req.params.reqId}' not found.` });
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
      // 一次性交付:清空明文 + 落交付时间。
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

  // 批准:当场签发一把全权项目 AgentKey(授权密钥),明文挂记录上待 agent 取走一次。
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
    // 签发授权密钥 = 全权项目 AgentKey(cdsp_*),与 POST /projects/:id/agent-keys 同格式。
    const now = new Date();
    const slugHead = project.slug.slice(0, 12).toLowerCase();
    const suffix = randomBytes(32).toString('base64url');
    const plaintext = `cdsp_${slugHead}_${suffix}`;
    const hash = createHash('sha256').update(plaintext).digest('hex');
    const keyId = randomBytes(4).toString('hex');
    const decidedBy = decider(req);
    const keyEntry: AgentKey = {
      id: keyId,
      label: `授权密钥 (申请 ${item.id} · ${item.agentName})`,
      hash,
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
