import { Router, type Request } from 'express';
import type { CdsUser } from '../domain/auth.js';
import type { NotificationKeyRef } from '../types.js';
import type { AuthService } from '../services/auth-service.js';
import { cdsEventsBus } from '../services/cds-events-bus.js';
import { humanPrincipalId } from '../services/human-project-access.js';
import { isAuthenticatedHuman, isHumanSystemOwner } from '../services/human-auth.js';
import { hasActiveGrant } from '../services/identity.js';
import { findNotificationKey, keyNotificationRecipient, type NotificationKey } from '../services/key-notification-routing.js';
import type { StateService } from '../services/state.js';

function reference(value: unknown): NotificationKeyRef | null {
  if (!value || typeof value !== 'object') return null;
  const { kind, id, projectId } = value as Record<string, unknown>;
  if (typeof id !== 'string' || !id || id.length > 100) return null;
  if (kind === 'global' || kind === 'user') return { kind, id };
  if (kind !== 'project' || typeof projectId !== 'string' || !projectId || projectId.length > 150) return null;
  return { kind, id, projectId };
}

const actor = (req: Request): CdsUser | null =>
  isAuthenticatedHuman(req) ? (req as Request & { cdsUser?: CdsUser }).cdsUser ?? null : null;

export function createKeyNotificationOwnersRouter(deps: {
  state: StateService;
  auth: AuthService;
  systemAccount?: CdsUser;
}): Router {
  const router = Router();
  const { state, auth, systemAccount } = deps;
  const changing = new Set<string>();

  async function directory() {
    const accounts = await auth.listUsers();
    if (systemAccount) accounts.unshift(systemAccount);
    return new Map(accounts.map(account => [account.id, account]));
  }

  function eligible(account: CdsUser | undefined, ref: NotificationKeyRef, transfer: boolean): boolean {
    if (!account || account.status !== 'active') return false;
    if (account.isSystemOwner) return true;
    if (transfer && !account.isAdministrator) return false;
    return ref.kind === 'project' ? hasActiveGrant(state.getProjectGrants(), humanPrincipalId(account.id), ref.projectId) : account.isAdministrator === true;
  }

  function view(key: NotificationKey, ref: NotificationKeyRef, accounts: Map<string, CdsUser>) {
    const accountId = keyNotificationRecipient(key);
    return {
      ref, label: key.label || key.id,
      projectName: ref.kind === 'project' ? state.getProject(ref.projectId)?.name : undefined,
      issuedByAccountId: key.issuedByAccountId,
      recipientAccountId: accountId,
      recipientName: accountId ? accounts.get(accountId)?.name : undefined,
      state: key.revokedAt ? 'revoked' : accountId === undefined ? 'legacy'
        : accountId && eligible(accounts.get(accountId), ref, false) ? 'assigned' : 'handoff',
      handoff: key.notificationHandoff,
    };
  }

  router.get('/auth/key-notification-owners', async (req, res) => {
    const who = actor(req);
    if (!who) { res.status(401).json({ error: '请登录后读取 Key 通知归属' }); return; }
    const owner = isHumanSystemOwner(req);
    res.setHeader('Cache-Control', 'private, no-store');
    try {
      const accounts = await directory();
      const rows = [
        ...state.getProjects().flatMap(project => state.getAgentKeys(project.id)
          .map(key => ({ key, ref: { kind: 'project', projectId: project.id, id: key.id } as const }))),
        ...state.getGlobalAgentKeys().map(key => ({ key, ref: { kind: 'global', id: key.id } as const })),
        ...state.getUserCredentials().map(key => ({ key, ref: { kind: 'user', id: key.id } as const })),
      ];
      const keys = rows.filter(({ key }) => owner || keyNotificationRecipient(key) === who.id).map(({ key, ref }) => view(key, ref, accounts));
      res.json({
        keys,
        accounts: owner ? Array.from(accounts.values()).filter(account => account.status === 'active' && (account.isSystemOwner || account.isAdministrator))
          .map(account => ({ id: account.id, name: account.name || account.username || account.githubLogin })) : [],
      });
    } catch {
      res.status(503).json({ error: 'Key 通知归属读取失败，请重新读取' });
    }
  });

  router.post('/auth/key-notification-owners/assign', async (req, res) => {
    const who = actor(req);
    if (!who || !isHumanSystemOwner(req)) { res.status(403).json({ error: '仅系统所有者可确认通知交接' }); return; }
    res.setHeader('Cache-Control', 'private, no-store');
    const ref = reference(req.body?.ref);
    const targetId = req.body?.recipientAccountId;
    const previous = req.body?.expectedRecipientAccountId;
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    if (!ref || typeof targetId !== 'string' || (typeof previous !== 'string' && previous !== null) || reason.length < 3 || reason.length > 500) {
      res.status(400).json({ error: '请选择接收账号，并填写 3–500 字的交接原因' }); return;
    }
    const lock = JSON.stringify(ref);
    if (changing.has(lock)) { res.status(409).json({ error: '该 Key 的通知正在交接，请刷新' }); return; }
    changing.add(lock);
    try {
      const accounts = await directory();
      const key = findNotificationKey(state, ref);
      if (!key || key.revokedAt || key.issuedByAccountId === undefined) {
        res.status(409).json({ error: '该 Key 沿用历史受众或已停止使用，不能进行交接' }); return;
      }
      if (!eligible(accounts.get(targetId), ref, true)) {
        res.status(403).json({ error: '接手人需要有效的管理角色和对应的项目权限' }); return;
      }
      const current = keyNotificationRecipient(key);
      if (current !== previous) {
        res.status(409).json({ error: '通知接收关系已变化，请重新读取后确认' }); return;
      }
      if (current === targetId) { res.json({ key: view(key, ref, accounts) }); return; }
      const prior = key.notificationHandoff;
      key.notificationHandoff = { accountId: targetId, previousAccountId: previous, byAccountId: who.id, reason, at: new Date().toISOString() };
      try {
        state.save();
        await state.flush();
      } catch (error) {
        if (prior) key.notificationHandoff = prior;
        else delete key.notificationHandoff;
        try { state.save(); await state.flush(); } catch { /* back read remains required */ }
        throw error;
      }
      await auth.recordActivity({
        userId: who.id, userLogin: who.username || who.githubLogin, action: 'handoff-key-notification',
        targetType: 'key', targetId: ref.id, summary: `Key 通知交接至 ${accounts.get(targetId)?.name || targetId} · ${reason}`,
      });
      for (const request of state.listAccessRequests()) {
        const source = request.notificationKey;
        if (request.status === 'pending' && source?.kind === ref.kind && source.id === ref.id &&
            (ref.kind !== 'project' || (source.kind === 'project' && source.projectId === ref.projectId))) {
          cdsEventsBus.publish('access-request.progress', { requestId: request.id, stage: 'notification-handoff', projectId: request.projectId });
        }
      }
      res.json({ key: view(key, ref, accounts) });
    } catch {
      res.status(503).json({ error: '无法确认通知交接是否已保存，请重新读取该 Key' });
    } finally { changing.delete(lock); }
  });

  return router;
}
