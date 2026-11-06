/** 原账号/原项目的批准式设备交接；无身份时只收申请，不猜归属、不增Grant。 */
import { Router, type Request, type Response } from 'express';
import { createHash, randomBytes, timingSafeEqual, createCipheriv, createDecipheriv } from 'node:crypto';
import type { StateService } from '../services/state.js';
import type { AuthService } from '../services/auth-service.js';
import type { IdentityConnection, UserCredential, AgentKey } from '../types.js';
import { bootstrapRepository } from '../services/bootstrap-target.js';
import { isHumanSystemOwner } from '../services/human-auth.js';
import { humanPrincipalId, isHumanProjectGrantUpdatePending } from '../services/human-project-access.js';
import { hasActiveGrant, credentialUsability, daysFromNow, USER_CREDENTIAL_TTL_DAYS, PROJECT_CREDENTIAL_TTL_DAYS } from '../services/identity.js';
import { principalRecoveryBlock, recoveryMessage } from '../services/access-recovery.js';
import { mintUserCredentialPlaintext, mintProjectCredentialPlaintext } from './identity.js';

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const id = (prefix: string) => prefix + randomBytes(12).toString('hex');
const live = (r: IdentityConnection) => Date.parse(r.expiresAt) > Date.now();
function encrypt(payload: object, token: string, requestId: string): NonNullable<IdentityConnection['envelope']> {
  const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update('cds-identity-envelope-v1\0').update(token).digest(), iv);
  cipher.setAAD(Buffer.from(requestId));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final()]);
  return { iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), ciphertext: ciphertext.toString('hex') };
}
function decrypt(r: IdentityConnection, token: string): object {
  const e = r.envelope!; const cipher = createDecipheriv('aes-256-gcm', createHash('sha256').update('cds-identity-envelope-v1\0').update(token).digest(), Buffer.from(e.iv, 'hex'));
  cipher.setAAD(Buffer.from(r.id)); cipher.setAuthTag(Buffer.from(e.tag, 'hex'));
  return JSON.parse(Buffer.concat([cipher.update(Buffer.from(e.ciphertext, 'hex')), cipher.final()]).toString());
}

export function createIdentityConnectionsRouter({ stateService: state, authService: auth }: {
  stateService: StateService; authService: AuthService;
}): Router {
  const router = Router(); const issuing = new Set<string>(); const deciding = new Set<string>();
  const owner = (req: Request, res: Response): boolean => {
    if (isHumanSystemOwner(req)) return true;
    res.status(403).json({ error: 'human_owner_required', message: '请系统所有者登录后核对原账号与原项目。' }); return false;
  };
  const actor = (req: Request) => (req as Request & { cdsUser?: { username?: string; githubLogin?: string } }).cdsUser?.username
    || (req as Request & { cdsUser?: { githubLogin?: string } }).cdsUser?.githubLogin || 'owner';
  function ticket(req: Request, res: Response): { r: IdentityConnection; token: string } | undefined {
    const r = state.getIdentityConnections().find(x => x.id === req.params.id);
    const token = typeof req.headers['x-poll-token'] === 'string' ? req.headers['x-poll-token'] : '';
    if (!r || !token || !timingSafeEqual(Buffer.from(hash(token), 'hex'), Buffer.from(r.pollTokenHash, 'hex'))) {
      res.status(403).json({ error: 'invalid_poll_ticket', message: '接入票据无效，请让原Agent重新发起。' }); return;
    }
    if (!live(r)) { res.status(410).json({ error: 'request_expired', message: '接入申请已过期，未扩大任何权限，请重新发起。' }); return; }
    return { r, token };
  }
  const candidates = (r: IdentityConnection) => state.getProjects().filter(p => bootstrapRepository(p.gitRepoUrl) === r.repository
    && (!r.projectHint || p.id === r.projectHint || p.slug === r.projectHint));
  async function block(r: IdentityConnection): Promise<string | undefined> {
    const user = r.userId && await auth.findUserById(r.userId);
    if (!user || user.status !== 'active') return 'account-disabled';
    if (!r.projectId || !candidates(r).some(p => p.id === r.projectId)) return 'project-changed';
    const principalId = humanPrincipalId(user.id);
    return principalRecoveryBlock(state, principalId, r.projectId)
      || (!hasActiveGrant(state.getProjectGrants(), principalId, r.projectId) ? 'project-access-revoked' : undefined);
  }

  router.post('/identity-connections', (req, res) => {
    const repository = bootstrapRepository(req.body?.repository);
    if (!repository) { res.status(400).json({ error: 'repository_required', message: '请让Agent自动读取原仓库origin，不需要你填写编号。' }); return; }
    const active = state.getIdentityConnections().filter(live);
    if (active.length >= 100 || active.filter(r => r.status === 'pending').length >= 32
      || active.filter(r => r.repository === repository && r.status === 'pending').length >= 3) {
      res.status(429).json({ error: 'too_many_pending', message: '接入申请过多，请管理员先处理已有申请。' }); return;
    }
    const token = randomBytes(32).toString('base64url'); const now = Date.now();
    const r: IdentityConnection = { id: id('ic_'), repository, agentName: String(req.body?.agentName || 'Agent').slice(0, 100),
      ...(typeof req.body?.projectId === 'string' ? { projectHint: req.body.projectId.slice(0, 100) } : {}),
      pollTokenHash: hash(token), status: 'pending', createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 15 * 60_000).toISOString() };
    state.addIdentityConnection(r);
    res.status(201).json({ requestId: r.id, pollToken: token, status: 'pending' });
  });

  router.get('/identity-connections/:id', async (req, res, next) => {
    const found = ticket(req, res); if (!found) return;
    const { r, token } = found;
    try {
      if (deciding.has(r.id)) { res.json({ status: 'pending' }); return; }
      if (r.status !== 'approved') { res.json({ status: r.status }); return; }
      const blocked = await block(r);
      if (blocked) { res.json({ status: 'blocked', message: recoveryMessage(blocked as Parameters<typeof recoveryMessage>[0]) }); return; }
      if (issuing.has(r.id)) { res.json({ status: 'pending' }); return; }
      issuing.add(r.id);
      try {
        if (r.status !== 'approved' || !live(r)) { res.json({ status: r.status }); return; }
        if (!r.envelope && r.userCredentialId) { res.status(409).json({ error: 'delivery_closed' }); return; }
        if (!r.envelope) {
          const principalId = r.principalId!; const project = state.getProject(r.projectId!)!;
          const userPlain = mintUserCredentialPlaintext(); const projectPlain = mintProjectCredentialPlaintext(project.slug);
          const user: UserCredential = { id: id('uc_'), principalId, projectIds: [project.id], hash: hash(userPlain),
            createdAt: new Date().toISOString(), createdBy: r.decidedBy, expiresAt: daysFromNow(USER_CREDENTIAL_TTL_DAYS), issuedCount: 1 };
          const key: AgentKey = { id: id(''), principalId, hash: hash(projectPlain), scope: 'rw', label: `设备接入 ${r.agentName}`,
            createdAt: new Date().toISOString(), createdBy: r.decidedBy, expiresAt: daysFromNow(PROJECT_CREDENTIAL_TTL_DAYS), issuedByCredentialId: user.id };
          const envelope = encrypt({ userCredential: userPlain, authorizationKey: projectPlain,
            projectId: project.id, projectName: project.aliasName || project.name, projectSlug: project.slug }, token, r.id);
          try {
            state.addUserCredential(user); state.addAgentKey(project.id, key);
            state.updateIdentityConnection(r.id, { userCredentialId: user.id, projectCredentialId: key.id, envelope });
            await state.flush();
          } catch (error) {
            state.revokeUserCredential(user.id, 'connection-storage-failed'); state.revokeAgentKey(project.id, key.id);
            state.updateIdentityConnection(r.id, { status: 'rejected', envelope: undefined });
            throw error;
          }
        }
        const paused = await block(r);
        if (!live(r)) { res.status(410).json({ error: 'request_expired' }); return; }
        const user = state.getUserCredentials().find(c => c.id === r.userCredentialId);
        const key = state.getAgentKeys(r.projectId!).find(k => k.id === r.projectCredentialId);
        if (paused) { res.json({ status: 'blocked', message: '原访问权限已暂停，请管理员恢复后原命令会继续。' }); return; }
        if (!user || !key || !credentialUsability(user, state.getPrincipal(r.principalId!), Date.now(), true).usable
          || !credentialUsability(key, state.getPrincipal(r.principalId!), Date.now(), true).usable) {
          res.status(409).json({ error: 'issued_credential_revoked', message: '这次交接凭据已被撤销，请重新核对申请。' }); return;
        }
        res.json({ status: 'approved', ...decrypt(r, token) });
      } finally { issuing.delete(r.id); }
    } catch (error) { next(error); }
  });
  router.post('/identity-connections/:id/ack', async (req, res, next) => {
    const found = ticket(req, res); if (!found) return;
    if (issuing.has(found.r.id)) { res.status(409).json({ error: 'delivery_in_progress' }); return; }
    if (!['approved', 'delivered'].includes(found.r.status) || !found.r.userCredentialId) {
      res.status(409).json({ error: 'not_issued' }); return;
    }
    try {
      state.updateIdentityConnection(found.r.id, { status: 'delivered', envelope: undefined }); await state.flush();
      res.json({ delivered: true });
    } catch (error) { next(error); }
  });

  router.get('/identity/connections', async (req, res, next) => {
    if (!owner(req, res)) return;
    try {
      const users = (await auth.listUsers()).filter(u => !u.isSystemOwner).map(u => ({ id: u.id, name: u.name || u.username || u.githubLogin,
        status: u.status, projectIds: state.getProjectGrants().filter(g => g.principalId === humanPrincipalId(u.id) && !g.revokedAt).map(g => g.projectId) }));
      res.json({ users, requests: state.getIdentityConnections().filter(live).map(r => ({ id: r.id, agentName: r.agentName,
        repository: r.repository, status: r.status, createdAt: r.createdAt, expiresAt: r.expiresAt,
        projectId: r.projectId, userId: r.userId, decidedBy: r.decidedBy,
        candidates: candidates(r).map(p => ({ id: p.id, name: p.aliasName || p.name, repository: p.gitRepoUrl })) })),
        unclaimed: state.getAllAgentKeysWithProject().filter(k => !k.principalId && !k.revokedAt && credentialUsability(k, undefined).usable)
          .map(k => ({ id: k.id, projectId: k.projectId, projectName: k.projectName, label: k.label, scope: k.scope, createdAt: k.createdAt })) });
    } catch (error) { next(error); }
  });
  router.post('/identity/connections/:id/approve', async (req, res, next) => {
    if (!owner(req, res)) return;
    const r = state.getIdentityConnections().find(r => r.id === req.params.id);
    if (!r || !live(r) || r.status !== 'pending' || deciding.has(r.id)) { res.status(409).json({ error: 'request_unavailable', message: '申请已处理或过期，请刷新。' }); return; }
    const project = candidates(r).find(p => p.id === req.body?.projectId);
    if (!project) { res.status(409).json({ error: 'repository_mismatch', message: '所选项目不属于申请仓库，未签发任何凭据。' }); return; }
    deciding.add(r.id);
    try {
      const selected = { ...r, userId: String(req.body?.userId || ''), projectId: project.id };
      const blocked = await block(selected);
      if (r.status !== 'pending' || !live(r)) { res.status(409).json({ error: 'request_unavailable' }); return; }
      if (blocked) { res.status(409).json({ error: blocked, message: '请先在用户管理恢复该账号对原项目的授权，再批准接入。' }); return; }
      state.updateIdentityConnection(r.id, { status: 'approved', userId: selected.userId, principalId: humanPrincipalId(selected.userId),
        projectId: project.id, decidedAt: new Date().toISOString(), decidedBy: actor(req) });
      await state.flush(); res.json({ approved: true });
    } catch (error) {
      // 先恢复内存中的授权决定；存储本身故障时仍把原错误交给统一处理器。
      Object.assign(r, { status: 'pending', userId: undefined, principalId: undefined, projectId: undefined, decidedAt: undefined, decidedBy: undefined });
      try { state.save(); } catch { /* 原错误仍由 next 处理，故障期间不会签发。 */ }
      next(error);
    } finally { deciding.delete(r.id); }
  });
  router.post('/identity/connections/:id/reject', async (req, res, next) => {
    if (!owner(req, res)) return;
    const r = state.getIdentityConnections().find(r => r.id === req.params.id);
    if (!r || r.status !== 'pending') { res.status(409).json({ error: 'request_unavailable' }); return; }
    try { state.updateIdentityConnection(r.id, { status: 'rejected', decidedAt: new Date().toISOString(), decidedBy: actor(req) });
      await state.flush(); res.json({ rejected: true }); } catch (error) { next(error); }
  });
  router.post('/identity/legacy-credentials/:projectId/:keyId/claim', async (req, res, next) => {
    if (!owner(req, res)) return;
    try {
      const userId = String(req.body?.userId || ''); const user = await auth.findUserById(userId); const principalId = humanPrincipalId(userId);
      const key = state.getAgentKeys(req.params.projectId).find(k => k.id === req.params.keyId);
      if (!user || user.status !== 'active' || !key || key.principalId || key.revokedAt || !credentialUsability(key, undefined).usable
        || isHumanProjectGrantUpdatePending(state, principalId) || state.getPrincipal(principalId)?.status !== 'active'
        || !hasActiveGrant(state.getProjectGrants(), principalId, req.params.projectId)) {
        res.status(409).json({ error: 'claim_not_allowed', message: '仅可把有效未归属凭据绑定给已获此项目授权的正常账号；已撤销或已有归属不能认领。' }); return;
      }
      const before = { ...key };
      key.principalId = principalId; key.claimedAt = new Date().toISOString(); key.claimedBy = actor(req);
      key.expiresAt = key.expiresAt || daysFromNow(PROJECT_CREDENTIAL_TTL_DAYS);
      try { state.save(); await state.flush(); } catch (error) {
        for (const field of ['principalId', 'claimedAt', 'claimedBy', 'expiresAt'] as const) {
          if (before[field] === undefined) delete key[field]; else key[field] = before[field];
        }
        try { state.save(); } catch { /* 保留原存储错误。 */ }
        throw error;
      }
      res.json({ claimed: true, projectId: req.params.projectId, keyId: key.id, userId, claimedBy: key.claimedBy, claimedAt: key.claimedAt });
    } catch (error) { next(error); }
  });
  return router;
}
