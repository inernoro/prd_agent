import { Router, type Request, type Response } from 'express';
import crypto from 'node:crypto';
import type { StateService } from '../services/state.js';
import type { AuthService } from '../services/auth-service.js';
import type { CdsUser } from '../domain/auth.js';
import { isHumanSystemOwner } from '../services/human-auth.js';
import { humanPrincipalId, supportsHumanProjectGrant, beginHumanProjectGrantUpdate, isHumanProjectGrantUpdatePending } from '../services/human-project-access.js';

export function createUserProjectAccessRouter(deps: { stateService: StateService; authService: AuthService }): Router {
  const router = Router();
  const { stateService: state, authService: auth } = deps;
  const handle = async (req: Request, res: Response): Promise<void> => {
    if (!isHumanSystemOwner(req)) {
      res.status(403).json({ error: '仅系统所有者可管理用户项目授权。' }); return;
    }
    let finishUpdate: (() => void) | undefined;
    let durable = false;
    let recoveryUncertain = false;
    try {
      const user = await auth.findUserById(req.params.id);
      if (!user) { res.status(404).json({ error: '用户不存在，请刷新用户列表。' }); return; }
      const principalId = humanPrincipalId(user.id);
      if (isHumanProjectGrantUpdatePending(state, principalId)) {
        res.status(409).json({ error: '此账号的项目授权正在保存，请稍后刷新并重试。' }); return;
      }
      const current = () => state.getProjectGrants().filter(g => g.principalId === principalId && !g.revokedAt);
      if (req.method === 'PUT') {
        if (user.isSystemOwner) {
          res.status(400).json({ error: '系统所有者始终可访问全部项目，无需逐项授权。' }); return;
        }
        const input = req.body?.projectIds;
        if (!Array.isArray(input) || input.some(id => typeof id !== 'string' || !supportsHumanProjectGrant(state.getProject(id)))) {
          res.status(400).json({ error: '请选择可操作分支的项目；共享服务暂不支持账号项目授权。' }); return;
        }
        const ids = new Set<string>(input.map(id => state.getProject(id)!.id));
        const actor = (req as typeof req & { cdsUser: CdsUser }).cdsUser;
        const actorLogin = actor.username || actor.githubLogin;
        const now = new Date().toISOString();
        finishUpdate = beginHumanProjectGrantUpdate(state, principalId);
        if (!finishUpdate) { res.status(409).json({ error: '此账号的项目授权正在保存，请稍后刷新并重试。' }); return; }
        const priorPrincipal = state.getPrincipal(principalId);
        const priorGrantIds = new Set(state.getProjectGrants().filter(g => g.principalId === principalId).map(g => g.id));
        const priorCredentialIds = new Set(state.getUserCredentials().filter(c => c.principalId === principalId).map(c => c.id));
        const before = current();
        const added = [...ids].filter(id => !before.some(g => g.projectId === id));
        const removed = before.filter(g => !ids.has(g.projectId));
        const removedBefore = removed.map(grant => ({ grant, revokedAt: grant.revokedAt, revokedBy: grant.revokedBy }));
        const createdIds = new Set<string>();
        let createdPrincipal: typeof priorPrincipal;
        try {
          if (!priorPrincipal) {
            createdPrincipal = { id: principalId, name: user.username || user.githubLogin, kind: 'human', status: 'active',
              createdAt: now, createdBy: actorLogin };
            state.addPrincipal(createdPrincipal);
          }
          for (const grant of removed) state.revokeProjectGrant(grant.id, actorLogin);
          for (const projectId of added) {
            const id = `pg_${crypto.randomBytes(6).toString('hex')}`;
            createdIds.add(id);
            state.addProjectGrant({ id, principalId, projectId, origin: 'approved', grantedAt: now, grantedBy: actorLogin });
          }
          await state.flush();
          durable = true;
        } catch (error) {
          // Restore only this replacement, never rewind another principal or
          // overwrite independent grants added while the backing store awaited.
          const grants = state.getProjectGrants();
          for (let index = grants.length - 1; index >= 0; index--) {
            if (createdIds.has(grants[index].id)) grants.splice(index, 1);
          }
          for (const prior of removedBefore) {
            if (prior.revokedAt === undefined) delete prior.grant.revokedAt; else prior.grant.revokedAt = prior.revokedAt;
            if (prior.revokedBy === undefined) delete prior.grant.revokedBy; else prior.grant.revokedBy = prior.revokedBy;
          }
          const independentlyUsed = grants.some(g => g.principalId === principalId && !priorGrantIds.has(g.id))
            || state.getUserCredentials().some(c => c.principalId === principalId && !priorCredentialIds.has(c.id));
          if (createdPrincipal && !independentlyUsed && createdPrincipal.status === 'active') {
            const principals = state.getPrincipals();
            const index = principals.indexOf(createdPrincipal);
            if (index >= 0) principals.splice(index, 1);
          }
          // As with existing state-store compensation, memory is restored even
          // if the backing store stays down; enqueue the restored snapshot too.
          try { state.save(); await state.flush(); } catch { recoveryUncertain = true; }
          throw error;
        }
        for (const [action, projectIds] of [['grant-project', added], ['revoke-project', removed.map(g => g.projectId)]] as const) {
          for (const projectId of projectIds) await auth.recordActivity({
            userId: actor.id, userLogin: actorLogin, action, targetType: 'user', targetId: user.id,
            summary: `${action === 'grant-project' ? '授权' : '撤销'}账号 ${user.username || user.githubLogin} 的项目 ${state.getProject(projectId)?.name || projectId}`,
            ip: req.ip || null,
          });
        }
      }
      const active = new Set(current().map(g => g.projectId));
      res.json({ userId: user.id, allProjects: user.isSystemOwner, projects: state.getProjects().filter(supportsHumanProjectGrant).map(p => ({
        id: p.id, name: p.aliasName || p.name, authorized: user.isSystemOwner || active.has(p.id),
      })) });
    } catch (err) {
      console.error('[user-project-access] update failed:', err instanceof Error ? err.message : 'unknown');
      res.status(500).json({ error: durable
        ? '项目授权已保存，但后续处理失败，请刷新确认当前授权。'
        : recoveryUncertain
          ? '授权存储发生故障，内存修改已回退，但持久化状态无法确认。请恢复存储后核对授权再重试。'
          : req.method === 'PUT'
            ? '项目授权保存失败，本次修改未生效，请刷新后重试。'
            : '项目授权读取失败，请刷新后重试。' });
    } finally {
      finishUpdate?.();
    }
  };
  router.get('/auth/users/:id/projects', handle);
  router.put('/auth/users/:id/projects', handle);
  return router;
}
