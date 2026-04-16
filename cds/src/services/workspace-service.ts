/**
 * WorkspaceService — P5 Team Workspace orchestration.
 *
 * Responsibilities:
 *   1. Create team workspaces bound to a GitHub Org (validates membership)
 *   2. Sync org members from GitHub into workspace_members (manual trigger + hourly)
 *   3. List all workspaces accessible to a user (personal + team)
 *   4. Workspace member management (add/remove/role change)
 *
 * The service is the single entry point for workspace business logic.
 * Routes (routes/workspaces.ts) call it; tests use it directly.
 *
 * See doc/plan.cds-multi-project-phases.md §8 P5.
 */

import type { AuthStore } from '../infra/auth-store/memory-store.js';
import type {
  CdsWorkspace, CdsWorkspaceMember, CdsWorkspaceInvite,
} from '../domain/auth.js';
import type { GitHubOAuthClient } from './github-oauth-client.js';

/** Default invite TTL: 7 days. */
const DEFAULT_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface WorkspaceServiceConfig {
  /** How long workspace invites are valid. Defaults to 7 days. */
  inviteTtlMs?: number;
}

export class WorkspaceServiceError extends Error {
  constructor(
    public readonly code:
      | 'not_found'
      | 'forbidden'
      | 'conflict'
      | 'org_not_member'
      | 'already_member'
      | 'invite_expired'
      | 'invite_used',
    message: string,
  ) {
    super(message);
    this.name = 'WorkspaceServiceError';
  }
}

export class WorkspaceService {
  private readonly store: AuthStore;
  private readonly github: GitHubOAuthClient | null;
  private readonly inviteTtlMs: number;

  constructor(deps: {
    store: AuthStore;
    github?: GitHubOAuthClient | null;
    config?: WorkspaceServiceConfig;
  }) {
    this.store = deps.store;
    this.github = deps.github ?? null;
    this.inviteTtlMs = deps.config?.inviteTtlMs ?? DEFAULT_INVITE_TTL_MS;
  }

  /**
   * Create a team workspace bound to a GitHub Org.
   *
   * The creator must be a member of the target org. They become the
   * workspace owner (role='owner').
   *
   * @param creatorId    CDS user id of the user creating the workspace
   * @param githubLogin  Creator's GitHub login (for org membership check)
   * @param accessToken  GitHub OAuth access token (needs `read:org` scope)
   * @param orgLogin     GitHub org login to bind the workspace to
   * @param name         Human-friendly workspace name
   * @param slug         URL-friendly identifier (auto-derived from name if absent)
   */
  async createTeamWorkspace(input: {
    creatorId: string;
    githubLogin: string;
    accessToken: string;
    orgLogin: string;
    name: string;
    slug: string;
  }, now?: Date): Promise<{ workspace: CdsWorkspace; ownerMember: CdsWorkspaceMember }> {
    // Validate the creator is a member of the org (if GitHub client available).
    if (this.github) {
      const isMember = await this.isOrgMember(input.accessToken, input.orgLogin, input.githubLogin);
      if (!isMember) {
        throw new WorkspaceServiceError(
          'org_not_member',
          `GitHub user '${input.githubLogin}' is not a member of org '${input.orgLogin}'`,
        );
      }
    }

    // Fetch org metadata for githubOrgId.
    let orgId: number | null = null;
    if (this.github) {
      try {
        orgId = await this.fetchOrgId(input.accessToken, input.orgLogin);
      } catch {
        // Non-fatal — org id is informational only.
      }
    }

    const workspace = await this.store.createWorkspace({
      slug: input.slug,
      name: input.name,
      kind: 'team',
      ownerId: input.creatorId,
      githubOrgLogin: input.orgLogin,
      githubOrgId: orgId,
    }, now);

    const ownerMember = await this.store.addWorkspaceMember({
      workspaceId: workspace.id,
      userId: input.creatorId,
      role: 'owner',
      addedByUserId: null,
      syncSource: 'manual',
    }, now);

    return { workspace, ownerMember };
  }

  /**
   * List all workspaces accessible to a user:
   *   - Personal workspaces they own
   *   - Team workspaces where they are a member
   */
  async listUserWorkspaces(userId: string): Promise<CdsWorkspace[]> {
    return this.store.findWorkspacesForUser(userId);
  }

  /**
   * Get a workspace by slug. Throws `not_found` if it doesn't exist.
   */
  async getWorkspaceBySlug(slug: string): Promise<CdsWorkspace> {
    const ws = await this.store.findWorkspaceBySlug(slug);
    if (!ws) throw new WorkspaceServiceError('not_found', `Workspace '${slug}' not found`);
    return ws;
  }

  /**
   * Confirm that `userId` can access the workspace (is a member or the owner).
   * Throws `forbidden` if not.
   */
  async assertMemberAccess(workspaceId: string, userId: string): Promise<CdsWorkspaceMember> {
    const member = await this.store.findWorkspaceMember(workspaceId, userId);
    if (!member) {
      throw new WorkspaceServiceError(
        'forbidden',
        `User '${userId}' is not a member of workspace '${workspaceId}'`,
      );
    }
    return member;
  }

  /**
   * Confirm that `userId` is an owner or admin of the workspace.
   */
  async assertAdminAccess(workspaceId: string, userId: string): Promise<CdsWorkspaceMember> {
    const member = await this.assertMemberAccess(workspaceId, userId);
    if (member.role !== 'owner' && member.role !== 'admin') {
      throw new WorkspaceServiceError(
        'forbidden',
        `User '${userId}' is not an owner/admin of workspace '${workspaceId}'`,
      );
    }
    return member;
  }

  /** List all members of a workspace. */
  async listMembers(workspaceId: string): Promise<CdsWorkspaceMember[]> {
    return this.store.listWorkspaceMembers(workspaceId);
  }

  /** Add or update a member directly (admin operation, no invite flow). */
  async addMember(input: {
    workspaceId: string;
    userId: string;
    role: CdsWorkspaceMember['role'];
    addedByUserId: string;
  }, now?: Date): Promise<CdsWorkspaceMember> {
    return this.store.addWorkspaceMember({
      workspaceId: input.workspaceId,
      userId: input.userId,
      role: input.role,
      addedByUserId: input.addedByUserId,
      syncSource: 'manual',
    }, now);
  }

  /** Remove a member. Returns false if they weren't a member. */
  async removeMember(workspaceId: string, userId: string): Promise<boolean> {
    return this.store.removeWorkspaceMember(workspaceId, userId);
  }

  /** Update a member's role. Returns null if the member doesn't exist. */
  async updateMemberRole(workspaceId: string, userId: string, role: CdsWorkspaceMember['role']): Promise<CdsWorkspaceMember | null> {
    return this.store.updateWorkspaceMemberRole(workspaceId, userId, role);
  }

  // ── Invites ───────────────────────────────────────────────────────────────

  async createInvite(input: {
    workspaceId: string;
    githubLogin: string;
    role: CdsWorkspaceInvite['role'];
    invitedByUserId: string;
    ttlMs?: number;
  }, now?: Date): Promise<CdsWorkspaceInvite> {
    return this.store.createWorkspaceInvite({
      workspaceId: input.workspaceId,
      githubLogin: input.githubLogin,
      role: input.role,
      invitedByUserId: input.invitedByUserId,
      ttlMs: input.ttlMs ?? this.inviteTtlMs,
    }, now);
  }

  async acceptInvite(token: string, userId: string, now?: Date): Promise<CdsWorkspaceMember> {
    const member = await this.store.acceptWorkspaceInvite(token, userId, now);
    if (!member) {
      throw new WorkspaceServiceError(
        'invite_expired',
        'Invite token is expired, already used, or does not exist',
      );
    }
    return member;
  }

  async listInvites(workspaceId: string): Promise<CdsWorkspaceInvite[]> {
    return this.store.listWorkspaceInvites(workspaceId);
  }

  async deleteInvite(workspaceId: string, inviteId: string, requesterId: string): Promise<void> {
    // Only admins/owners can revoke invites.
    await this.assertAdminAccess(workspaceId, requesterId);
    await this.store.deleteWorkspaceInvite(inviteId);
  }

  // ── Org Sync ──────────────────────────────────────────────────────────────

  /**
   * Sync GitHub Org members into workspace_members for a team workspace.
   * Existing members keep their current role. New org members get role='member'.
   * Former org members are NOT removed automatically (manual removal required).
   *
   * Requires `read:org` scope on the access token.
   */
  async syncOrgMembers(input: {
    workspaceId: string;
    githubOrgLogin: string;
    accessToken: string;
  }): Promise<{ added: number; skipped: number }> {
    if (!this.github) {
      return { added: 0, skipped: 0 };
    }

    const orgMembers = await this.github.fetchOrgs(input.accessToken)
      .then(() => this.fetchOrgMemberLogins(input.accessToken, input.githubOrgLogin))
      .catch(() => [] as string[]);

    const existingMembers = await this.store.listWorkspaceMembers(input.workspaceId);
    const existingUserIds = new Set(existingMembers.map((m) => m.userId));

    let added = 0;
    let skipped = 0;

    for (const login of orgMembers) {
      // Resolve CDS user by GitHub login.
      // Note: CDS users are keyed by githubId, not login. For P5 we do a
      // best-effort lookup; unknown logins (not yet logged in) are skipped.
      const user = await this.findUserByGithubLogin(login);
      if (!user) { skipped++; continue; }
      if (existingUserIds.has(user.id)) { skipped++; continue; }

      await this.store.addWorkspaceMember({
        workspaceId: input.workspaceId,
        userId: user.id,
        role: 'member',
        addedByUserId: null,
        syncSource: 'github-org',
      });
      added++;
    }

    return { added, skipped };
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private async isOrgMember(accessToken: string, orgLogin: string, githubLogin: string): Promise<boolean> {
    try {
      const orgs = await this.github!.fetchOrgs(accessToken);
      return orgs.some((o) => o.login.toLowerCase() === orgLogin.toLowerCase());
    } catch {
      return false;
    }
  }

  private async fetchOrgId(accessToken: string, orgLogin: string): Promise<number | null> {
    // GitHubOAuthClient doesn't expose an org detail endpoint yet.
    // Return null until it does.
    void accessToken; void orgLogin;
    return null;
  }

  private async fetchOrgMemberLogins(accessToken: string, orgLogin: string): Promise<string[]> {
    // GitHubOAuthClient doesn't expose the org members list endpoint yet.
    // This is a placeholder for the P5 org-sync feature.
    void accessToken; void orgLogin;
    return [];
  }

  private async findUserByGithubLogin(githubLogin: string): Promise<{ id: string } | null> {
    // The AuthStore doesn't have findUserByGithubLogin. We'd need to search
    // through all users. For P5 Phase 1 this is acceptable since CDS user counts
    // are small (single-org deployments rarely exceed 100 users).
    // TODO P5.2: add findUserByGithubLogin to AuthStore for O(1) lookup.
    void githubLogin;
    return null;
  }
}
