import type { Request, Response, NextFunction } from 'express';
import type { StateService } from '../services/state.js';
import { canHumanAccessProject, isScopedHuman, humanPrincipalId, isHumanProjectGrantUpdatePending } from '../services/human-project-access.js';

/** Members enter only project-scoped product routes. Unknown/system routes fail closed. */
export function createHumanProjectAccessMiddleware(state: StateService) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!isScopedHuman(req) || !/^\/api\//i.test(req.path)) { next(); return; }
    res.locals.cdsScopedHuman = true;
    res.locals.cdsHumanRequest = req;
    const path = req.path.replace(/\/+$/, '').toLowerCase();
    const method = req.method.toUpperCase();
    const deny = () => res.status(403).json({
      error: 'human_project_forbidden',
      message: '你没有此项目或系统操作的权限，请联系系统所有者分配项目授权。',
    });
    if ((method === 'GET' && ['/api/me', '/api/auth/status', '/api/auth/activity'].includes(path))
      || (method === 'POST' && ['/api/auth/logout', '/api/logout', '/api/auth/change-password', '/api/auth/sso/logout'].includes(path))) {
      next(); return;
    }
    const user = (req as Request & { cdsUser?: { id: string } }).cdsUser;
    if (user && isHumanProjectGrantUpdatePending(state, humanPrincipalId(user.id))) {
      res.status(409).json({ error: '项目授权正在保存，请稍后刷新再试。' }); return;
    }
    // Preserve case of identifiers and decode exactly once, as Express does.
    let segments: string[];
    try { segments = req.path.replace(/\/+$/, '').split('/').slice(2).map(decodeURIComponent); }
    catch { res.status(400).json({ error: '项目地址无效，请重新从项目列表进入。' }); return; }
    const [kind, id, action] = segments;
    const checkProject = (value: unknown): boolean => {
      if (typeof value !== 'string' || !value) return false;
      const project = state.getProject(value);
      if (!project || !canHumanAccessProject(req, state, project.id)) return false;
      return true;
    };
    const guardStream = (projectId: string): void => {
      const write = res.write.bind(res);
      res.write = ((chunk: unknown, encoding?: unknown, callback?: unknown) => {
        if (!canHumanAccessProject(req, state, projectId)) { res.end(); return false; }
        return write(chunk as string, encoding as BufferEncoding, callback as (error: Error | null | undefined) => void);
      }) as Response['write'];
    };
    // Every explicit source/destination must be authorized, including body/query overrides.
    for (const value of [req.query.project, req.query.projectId, req.body?.projectId, req.body?.sourceProjectId, req.body?.targetProjectId]) {
      if (value !== undefined && !checkProject(value)) { deny(); return; }
    }
    for (const value of [req.body?.sourceBranchId, req.body?.targetBranchId]) {
      if (value === undefined) continue;
      const source = typeof value === 'string' ? state.getBranch(value) : undefined;
      if (!source || !checkProject(source.projectId || 'default')) { deny(); return; }
    }
    if (kind?.toLowerCase() === 'config' && method === 'GET' && !id) { next(); return; }
    if (kind?.toLowerCase() === 'deployment-runs' && method === 'GET') {
      if (!id) {
        if (!checkProject(req.query.project || req.query.projectId)) { deny(); return; }
      } else {
        const run = state.getDeploymentRun(id);
        if (!run || !checkProject(run.projectId)
          || (action && !/^(stream|diagnosis)$/i.test(action))) { deny(); return; }
        guardStream(run.projectId);
      }
      next(); return;
    }
    if (kind?.toLowerCase() === 'projects') {
      if (!id && method === 'GET') { next(); return; }
      // Credentials and cross-project migration remain system-owner actions.
      if (!id || /^(agent-keys|migration|migrate|github)$/i.test(action || '') || !checkProject(id)) { deny(); return; }
      // Project settings/creation/deletion require the owner; members operate its branches.
      if (method !== 'GET') { deny(); return; }
      // Raw compose, storage, status-page tokens and Agent/system read routes
      // can contain credentials even for an otherwise authorized project.
      if (action && !/^(preview-mode|branch-groups)$/i.test(action)) { deny(); return; }
      next(); return;
    }
    if (kind?.toLowerCase() === 'branches') {
      if ((!id || id.toLowerCase() === 'stream') && method === 'GET') {
        if ((req.query.live === 'true' || req.query.live === '1') && !req.query.project) { deny(); return; }
        next(); return;
      }
      if (!id && method === 'POST' && typeof req.body?.projectId === 'string') { next(); return; }
      const branch = id ? state.getBranch(id) : undefined;
      if (!branch || !checkProject(branch.projectId || 'default')) { deny(); return; }
      if (action === 'copy-config-from') {
        const source = state.getBranch(segments[3]);
        if (!source || !checkProject(source.projectId || 'default')) { deny(); return; }
      }
      // Machine credentials cannot be minted by a member to outlive revoked human access.
      if (/agent-key|credential/i.test(action || '') || /^(container-env|container-exec)$/i.test(action || '')) { deny(); return; }
      // Live Docker chunks and historical archives may contain owner-unmasked
      // credentials. Keep these raw read paths owner-only; masked snapshots remain available.
      if (/^(container-logs-stream|container-log-archives)$/i.test(action || '')) { deny(); return; }
      if (req.query.unmask === '1' || req.query.unmask === 'true') { deny(); return; }
      // Grants do not allow arbitrary container commands, global domain claims or secrets edits.
      const branchWrite = (!action && (method === 'PATCH' || method === 'DELETE'))
        || (method === 'POST' && /^(pull|deploy|stop|restart|smoke|container-logs|checkout|unpin|reset|force-rebuild|verify-runtime)$/i.test(action || ''));
      if (method !== 'GET' && !branchWrite) { deny(); return; }
      // A stream may stay open through revocation. Recheck before every chunk,
      // so log/deploy streams cannot keep sending previously authorized data.
      guardStream(branch.projectId || 'default');
      next(); return;
    }
    if (kind?.toLowerCase() === 'build-profiles' && method === 'GET' && !id) { next(); return; }
    if (kind?.toLowerCase() === 'remote-branches' && method === 'GET' && typeof req.query.project === 'string') { next(); return; }
    deny();
  };
}
