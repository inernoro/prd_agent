import { Router, type Request, type Response } from 'express';
import crypto from 'node:crypto';
import type { StateService } from '../services/state.js';
import type { AuthService } from '../services/auth-service.js';
import type { CdsUser } from '../domain/auth.js';
import { isHumanSystemOwner } from '../services/human-auth.js';
import { humanPrincipalId, supportsHumanProjectGrant } from '../services/human-project-access.js';

export function createUserProjectAccessRouter(deps: { stateService: StateService; authService: AuthService }): Router {
  const router = Router();
  const { stateService: state, authService: auth } = deps;
  const handle = async (req: Request, res: Response): Promise<void> => {
    if (!isHumanSystemOwner(req)) {
      res.status(403).json({ error: '仅系统所有者可管理用户项目授权。' }); return;
    }
    try {
      const user = await auth.findUserById(req.params.id);
      if (!user) { res.status(404).json({ error: '用户不存在，请刷新用户列表。' }); return; }
      const principalId = humanPrincipalId(user.id);
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
        if (!state.getPrincipal(principalId)) state.addPrincipal({
          id: principalId, name: user.username || user.githubLogin, kind: 'human', status: 'active',
          createdAt: now, createdBy: actorLogin,
        });
        const before = current();
        const added = [...ids].filter(id => !before.some(g => g.projectId === id));
        const removed = before.filter(g => !ids.has(g.projectId));
        // No awaits between read and mutation: concurrent updates serialize in the event loop.
        for (const grant of removed) state.revokeProjectGrant(grant.id, actorLogin);
        for (const projectId of added) state.addProjectGrant({
          id: `pg_${crypto.randomBytes(6).toString('hex')}`, principalId, projectId,
          origin: 'approved', grantedAt: now, grantedBy: actorLogin,
        });
        await state.flush();
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
      res.status(500).json({ error: '项目授权读取或保存失败，请刷新后重试。' });
    }
  };
  router.get('/auth/users/:id/projects', handle);
  router.put('/auth/users/:id/projects', handle);
  return router;
}
