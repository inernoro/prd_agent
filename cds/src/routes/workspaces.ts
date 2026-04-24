/**
 * Workspaces API router — P5 Team Workspace.
 *
 * Endpoints (all under /api/workspaces):
 *   GET  /api/workspaces                         → list workspaces for the current user
 *   POST /api/workspaces                         → create a team workspace
 *   GET  /api/workspaces/:slug                   → get one workspace
 *   GET  /api/workspaces/:slug/members           → list members
 *   POST /api/workspaces/:slug/members           → add a member (admin+)
 *   PATCH /api/workspaces/:slug/members/:userId  → update member role (owner only)
 *   DELETE /api/workspaces/:slug/members/:userId → remove a member (admin+)
 *   GET  /api/workspaces/:slug/invites           → list pending invites (admin+)
 *   POST /api/workspaces/:slug/invites           → create invite (admin+)
 *   DELETE /api/workspaces/:slug/invites/:id     → revoke invite (admin+)
 *   POST /api/workspaces/accept-invite           → accept an invite (authenticated user)
 *
 * These routes require CDS_AUTH_MODE=github — they only mount when the
 * github auth block wires up an authService. The middleware provides
 * `req.cdsUser` when a valid session cookie is present.
 *
 * See doc/plan.cds-multi-project-phases.md §8 P5.
 */

import { Router, type Request, type Response } from 'express';
import { WorkspaceService, WorkspaceServiceError } from '../services/workspace-service.js';
import type { CdsUser } from '../domain/auth.js';

/** Augmented request type — set by github-auth middleware. */
interface AuthedRequest extends Request {
  cdsUser?: CdsUser;
}

export interface WorkspacesRouterDeps {
  workspaceService: WorkspaceService;
}

/** Require an active CDS session; return 401 otherwise. */
function requireUser(req: AuthedRequest, res: Response): CdsUser | null {
  if (!req.cdsUser) {
    res.status(401).json({ error: 'unauthenticated' });
    return null;
  }
  return req.cdsUser;
}

/** Map WorkspaceServiceError to HTTP status. */
function serviceErrStatus(err: WorkspaceServiceError): number {
  switch (err.code) {
    case 'not_found':      return 404;
    case 'forbidden':      return 403;
    case 'conflict':       return 409;
    case 'org_not_member': return 403;
    case 'already_member': return 409;
    case 'invite_expired':
    case 'invite_used':    return 410;
    default:               return 500;
  }
}

function handleErr(res: Response, err: unknown): void {
  if (err instanceof WorkspaceServiceError) {
    res.status(serviceErrStatus(err)).json({ error: err.message, code: err.code });
    return;
  }
  if (err instanceof Error && err.message.includes('already exists')) {
    res.status(409).json({ error: err.message, code: 'conflict' });
    return;
  }
  console.error('[workspaces] unhandled error:', err);
  res.status(500).json({ error: 'Internal error' });
}

export function createWorkspacesRouter(deps: WorkspacesRouterDeps): Router {
  const router = Router();
  const svc = deps.workspaceService;

  // ── List user's workspaces ─────────────────────────────────────────────────

  router.get('/', async (req: AuthedRequest, res: Response) => {
    const user = requireUser(req, res);
    if (!user) return;
    try {
      const workspaces = await svc.listUserWorkspaces(user.id);
      res.json({ workspaces });
    } catch (err) {
      handleErr(res, err);
    }
  });

  // ── Create team workspace ─────────────────────────────────────────────────

  router.post('/', async (req: AuthedRequest, res: Response) => {
    const user = requireUser(req, res);
    if (!user) return;

    const { name, slug, orgLogin } = req.body ?? {};
    if (!name || typeof name !== 'string') {
      res.status(400).json({ error: '`name` is required' });
      return;
    }
    if (!slug || typeof slug !== 'string') {
      res.status(400).json({ error: '`slug` is required' });
      return;
    }
    if (!/^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$|^[a-z0-9]$/.test(slug)) {
      res.status(400).json({ error: '`slug` must be lowercase alphanumeric + hyphens, 1-50 chars' });
      return;
    }
    if (!orgLogin || typeof orgLogin !== 'string') {
      res.status(400).json({ error: '`orgLogin` is required for team workspaces' });
      return;
    }

    // Read GitHub access token from session cookie value forwarded by middleware.
    // For now we pass an empty string — the GitHub Org membership check is
    // best-effort (skipped when no GitHub client is wired).
    const accessToken = (req as unknown as Record<string, string>).cdsAccessToken ?? '';

    try {
      const { workspace, ownerMember } = await svc.createTeamWorkspace({
        creatorId: user.id,
        githubLogin: user.githubLogin,
        accessToken,
        orgLogin,
        name: name.trim(),
        slug: slug.trim(),
      });
      res.status(201).json({ workspace, ownerMember });
    } catch (err) {
      handleErr(res, err);
    }
  });

  // ── Get one workspace ─────────────────────────────────────────────────────

  router.get('/:slug', async (req: AuthedRequest, res: Response) => {
    const user = requireUser(req, res);
    if (!user) return;
    try {
      const ws = await svc.getWorkspaceBySlug(req.params.slug);
      res.json({ workspace: ws });
    } catch (err) {
      handleErr(res, err);
    }
  });

  // ── Members ───────────────────────────────────────────────────────────────

  router.get('/:slug/members', async (req: AuthedRequest, res: Response) => {
    const user = requireUser(req, res);
    if (!user) return;
    try {
      const ws = await svc.getWorkspaceBySlug(req.params.slug);
      const members = await svc.listMembers(ws.id);
      res.json({ members });
    } catch (err) {
      handleErr(res, err);
    }
  });

  router.post('/:slug/members', async (req: AuthedRequest, res: Response) => {
    const user = requireUser(req, res);
    if (!user) return;
    const { userId, role } = req.body ?? {};
    if (!userId || typeof userId !== 'string') {
      res.status(400).json({ error: '`userId` is required' });
      return;
    }
    const validRoles = ['owner', 'admin', 'member'] as const;
    if (!role || !validRoles.includes(role)) {
      res.status(400).json({ error: '`role` must be owner | admin | member' });
      return;
    }
    try {
      const ws = await svc.getWorkspaceBySlug(req.params.slug);
      await svc.assertAdminAccess(ws.id, user.id);
      const member = await svc.addMember({ workspaceId: ws.id, userId, role, addedByUserId: user.id });
      res.status(201).json({ member });
    } catch (err) {
      handleErr(res, err);
    }
  });

  router.patch('/:slug/members/:userId', async (req: AuthedRequest, res: Response) => {
    const user = requireUser(req, res);
    if (!user) return;
    const { role } = req.body ?? {};
    const validRoles = ['owner', 'admin', 'member'] as const;
    if (!role || !validRoles.includes(role)) {
      res.status(400).json({ error: '`role` must be owner | admin | member' });
      return;
    }
    try {
      const ws = await svc.getWorkspaceBySlug(req.params.slug);
      await svc.assertAdminAccess(ws.id, user.id);
      const member = await svc.updateMemberRole(ws.id, req.params.userId, role);
      if (!member) {
        res.status(404).json({ error: 'Member not found' });
        return;
      }
      res.json({ member });
    } catch (err) {
      handleErr(res, err);
    }
  });

  router.delete('/:slug/members/:userId', async (req: AuthedRequest, res: Response) => {
    const user = requireUser(req, res);
    if (!user) return;
    try {
      const ws = await svc.getWorkspaceBySlug(req.params.slug);
      await svc.assertAdminAccess(ws.id, user.id);
      const removed = await svc.removeMember(ws.id, req.params.userId);
      res.json({ removed });
    } catch (err) {
      handleErr(res, err);
    }
  });

  // ── Invites ───────────────────────────────────────────────────────────────

  router.get('/:slug/invites', async (req: AuthedRequest, res: Response) => {
    const user = requireUser(req, res);
    if (!user) return;
    try {
      const ws = await svc.getWorkspaceBySlug(req.params.slug);
      await svc.assertAdminAccess(ws.id, user.id);
      const invites = await svc.listInvites(ws.id);
      res.json({ invites });
    } catch (err) {
      handleErr(res, err);
    }
  });

  router.post('/:slug/invites', async (req: AuthedRequest, res: Response) => {
    const user = requireUser(req, res);
    if (!user) return;
    const { githubLogin, role } = req.body ?? {};
    if (!githubLogin || typeof githubLogin !== 'string') {
      res.status(400).json({ error: '`githubLogin` is required' });
      return;
    }
    const validRoles = ['admin', 'member'] as const;
    if (!role || !validRoles.includes(role)) {
      res.status(400).json({ error: '`role` must be admin | member' });
      return;
    }
    try {
      const ws = await svc.getWorkspaceBySlug(req.params.slug);
      await svc.assertAdminAccess(ws.id, user.id);
      const invite = await svc.createInvite({
        workspaceId: ws.id,
        githubLogin,
        role,
        invitedByUserId: user.id,
      });
      res.status(201).json({ invite });
    } catch (err) {
      handleErr(res, err);
    }
  });

  router.delete('/:slug/invites/:id', async (req: AuthedRequest, res: Response) => {
    const user = requireUser(req, res);
    if (!user) return;
    try {
      const ws = await svc.getWorkspaceBySlug(req.params.slug);
      await svc.deleteInvite(ws.id, req.params.id, user.id);
      res.json({ ok: true });
    } catch (err) {
      handleErr(res, err);
    }
  });

  // ── Accept invite ─────────────────────────────────────────────────────────

  router.post('/accept-invite', async (req: AuthedRequest, res: Response) => {
    const user = requireUser(req, res);
    if (!user) return;
    const { token } = req.body ?? {};
    if (!token || typeof token !== 'string') {
      res.status(400).json({ error: '`token` is required' });
      return;
    }
    try {
      const member = await svc.acceptInvite(token, user.id);
      res.json({ member });
    } catch (err) {
      handleErr(res, err);
    }
  });

  return router;
}
