/**
 * In-memory AuthStore — P2 implementation.
 *
 * Holds users, sessions, and workspaces in plain Maps. This is the P2
 * stepping stone: functional for single-node dev and CI tests, but NOT
 * durable across process restarts. P3 replaces the implementation with
 * a MongoDB-backed store behind the same AuthStore interface.
 *
 * Design notes:
 * - Session expiry is lazily enforced on read; there is no background
 *   sweep. MongoDB TTL indexes take over that job in P3.
 * - All mutator methods return the resulting entity so callers don't
 *   need a separate read round-trip.
 * - No locking is needed because Node.js single-threadedness already
 *   serialises access to the Maps.
 */

import type {
  CdsUser,
  CdsSession,
  CdsWorkspace,
  CdsWorkspaceMember,
  CdsWorkspaceInvite,
  UpsertUserInput,
} from '../../domain/auth.js';

/** The stable contract every AuthStore implementation must satisfy. */
export interface AuthStore {
  // — Users —
  upsertUser(input: UpsertUserInput, now?: Date): Promise<CdsUser>;
  findUserByGithubId(githubId: number): Promise<CdsUser | null>;
  findUserById(id: string): Promise<CdsUser | null>;
  setUserStatus(id: string, status: CdsUser['status']): Promise<CdsUser | null>;
  touchUserLastLogin(id: string, now?: Date): Promise<void>;
  countUsers(): Promise<number>;

  // — Sessions —
  createSession(input: {
    userId: string;
    ttlMs: number;
    userAgent: string | null;
    ipAddress: string | null;
  }, now?: Date): Promise<CdsSession>;
  findSessionByToken(token: string, now?: Date): Promise<CdsSession | null>;
  deleteSession(token: string): Promise<void>;
  deleteSessionsForUser(userId: string): Promise<number>;

  // — Workspaces —
  createWorkspace(input: {
    slug: string;
    name: string;
    kind: CdsWorkspace['kind'];
    ownerId: string;
    githubOrgLogin?: string | null;
    githubOrgId?: number | null;
    description?: string | null;
  }, now?: Date): Promise<CdsWorkspace>;
  findWorkspaceBySlug(slug: string): Promise<CdsWorkspace | null>;
  findWorkspacesForUser(userId: string): Promise<CdsWorkspace[]>;
  countWorkspaces(): Promise<number>;

  // — Workspace Members (P5) —
  addWorkspaceMember(input: {
    workspaceId: string;
    userId: string;
    role: CdsWorkspaceMember['role'];
    addedByUserId: string | null;
    syncSource?: CdsWorkspaceMember['syncSource'];
  }, now?: Date): Promise<CdsWorkspaceMember>;
  findWorkspaceMember(workspaceId: string, userId: string): Promise<CdsWorkspaceMember | null>;
  listWorkspaceMembers(workspaceId: string): Promise<CdsWorkspaceMember[]>;
  updateWorkspaceMemberRole(workspaceId: string, userId: string, role: CdsWorkspaceMember['role']): Promise<CdsWorkspaceMember | null>;
  removeWorkspaceMember(workspaceId: string, userId: string): Promise<boolean>;
  /** All workspaces (personal + team) where userId appears as a member. */
  findWorkspacesByMember(userId: string): Promise<CdsWorkspace[]>;

  // — Workspace Invites (P5) —
  createWorkspaceInvite(input: {
    workspaceId: string;
    githubLogin: string;
    role: CdsWorkspaceInvite['role'];
    invitedByUserId: string;
    ttlMs: number;
  }, now?: Date): Promise<CdsWorkspaceInvite>;
  findWorkspaceInviteByToken(token: string, now?: Date): Promise<CdsWorkspaceInvite | null>;
  acceptWorkspaceInvite(token: string, userId: string, now?: Date): Promise<CdsWorkspaceMember | null>;
  listWorkspaceInvites(workspaceId: string): Promise<CdsWorkspaceInvite[]>;
  deleteWorkspaceInvite(id: string): Promise<void>;
}

/**
 * Generate a UUID v4. Uses Node.js built-in crypto to avoid pulling in
 * another dependency. Node 20+ ships crypto.randomUUID.
 */
function genUuid(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { randomUUID } = require('node:crypto') as typeof import('node:crypto');
  return randomUUID().replace(/-/g, '');
}

/** Default session TTL in milliseconds. 30 days. */
export const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export class MemoryAuthStore implements AuthStore {
  private readonly usersById = new Map<string, CdsUser>();
  private readonly usersByGithubId = new Map<number, string>();
  private readonly sessionsByToken = new Map<string, CdsSession>();
  private readonly workspacesById = new Map<string, CdsWorkspace>();
  private readonly workspaceIdBySlug = new Map<string, string>();
  // P5: workspace members — keyed by `workspaceId:userId`
  private readonly membersByKey = new Map<string, CdsWorkspaceMember>();
  // P5: workspace invites — keyed by token
  private readonly invitesByToken = new Map<string, CdsWorkspaceInvite>();
  private readonly invitesById = new Map<string, CdsWorkspaceInvite>();

  async upsertUser(input: UpsertUserInput, now = new Date()): Promise<CdsUser> {
    const existingId = this.usersByGithubId.get(input.githubId);
    if (existingId) {
      const existing = this.usersById.get(existingId)!;
      const updated: CdsUser = {
        ...existing,
        githubLogin: input.githubLogin,
        email: input.email,
        name: input.name,
        avatarUrl: input.avatarUrl,
        orgs: [...input.orgs],
        orgsCheckedAt: now.toISOString(),
        updatedAt: now.toISOString(),
      };
      this.usersById.set(existingId, updated);
      return updated;
    }

    const id = genUuid();
    const user: CdsUser = {
      id,
      githubId: input.githubId,
      githubLogin: input.githubLogin,
      email: input.email,
      name: input.name,
      avatarUrl: input.avatarUrl,
      orgs: [...input.orgs],
      orgsCheckedAt: now.toISOString(),
      // isSystemOwner flip is handled by the auth-service bootstrap step,
      // not here. The store only knows about raw persistence.
      isSystemOwner: false,
      status: 'active',
      lastLoginAt: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    this.usersById.set(id, user);
    this.usersByGithubId.set(input.githubId, id);
    return user;
  }

  async findUserByGithubId(githubId: number): Promise<CdsUser | null> {
    const id = this.usersByGithubId.get(githubId);
    return id ? this.usersById.get(id) || null : null;
  }

  async findUserById(id: string): Promise<CdsUser | null> {
    return this.usersById.get(id) || null;
  }

  async setUserStatus(id: string, status: CdsUser['status']): Promise<CdsUser | null> {
    const user = this.usersById.get(id);
    if (!user) return null;
    const updated: CdsUser = { ...user, status, updatedAt: new Date().toISOString() };
    this.usersById.set(id, updated);
    return updated;
  }

  async touchUserLastLogin(id: string, now = new Date()): Promise<void> {
    const user = this.usersById.get(id);
    if (!user) return;
    this.usersById.set(id, {
      ...user,
      lastLoginAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
  }

  async countUsers(): Promise<number> {
    return this.usersById.size;
  }

  async createSession(input: {
    userId: string;
    ttlMs: number;
    userAgent: string | null;
    ipAddress: string | null;
  }, now = new Date()): Promise<CdsSession> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { randomBytes } = require('node:crypto') as typeof import('node:crypto');
    const token = randomBytes(48).toString('base64url');
    const session: CdsSession = {
      token,
      userId: input.userId,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + input.ttlMs).toISOString(),
      lastSeenAt: now.toISOString(),
      orgsCheckedAt: now.toISOString(),
      userAgent: input.userAgent,
      ipAddress: input.ipAddress,
    };
    this.sessionsByToken.set(token, session);
    return session;
  }

  async findSessionByToken(token: string, now = new Date()): Promise<CdsSession | null> {
    const session = this.sessionsByToken.get(token);
    if (!session) return null;
    if (new Date(session.expiresAt).getTime() <= now.getTime()) {
      // Lazy expiry: prune and report as missing.
      this.sessionsByToken.delete(token);
      return null;
    }
    // Touch lastSeenAt so the session stays "live".
    const updated: CdsSession = { ...session, lastSeenAt: now.toISOString() };
    this.sessionsByToken.set(token, updated);
    return updated;
  }

  async deleteSession(token: string): Promise<void> {
    this.sessionsByToken.delete(token);
  }

  async deleteSessionsForUser(userId: string): Promise<number> {
    let count = 0;
    for (const [token, session] of this.sessionsByToken.entries()) {
      if (session.userId === userId) {
        this.sessionsByToken.delete(token);
        count++;
      }
    }
    return count;
  }

  async createWorkspace(input: {
    slug: string;
    name: string;
    kind: CdsWorkspace['kind'];
    ownerId: string;
    githubOrgLogin?: string | null;
    githubOrgId?: number | null;
    description?: string | null;
  }, now = new Date()): Promise<CdsWorkspace> {
    if (this.workspaceIdBySlug.has(input.slug)) {
      throw new Error(`Workspace with slug '${input.slug}' already exists`);
    }
    const id = genUuid();
    const workspace: CdsWorkspace = {
      id,
      slug: input.slug,
      name: input.name,
      kind: input.kind,
      ownerId: input.ownerId,
      githubOrgLogin: input.githubOrgLogin ?? null,
      githubOrgId: input.githubOrgId ?? null,
      description: input.description ?? null,
      projectCount: 0,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    this.workspacesById.set(id, workspace);
    this.workspaceIdBySlug.set(input.slug, id);
    return workspace;
  }

  async findWorkspaceBySlug(slug: string): Promise<CdsWorkspace | null> {
    const id = this.workspaceIdBySlug.get(slug);
    return id ? this.workspacesById.get(id) || null : null;
  }

  async findWorkspacesForUser(userId: string): Promise<CdsWorkspace[]> {
    // P5: include personal workspaces (owned) + team workspaces where
    // the user is an explicit member.
    const teamWorkspaceIds = new Set<string>();
    for (const member of this.membersByKey.values()) {
      if (member.userId === userId) {
        teamWorkspaceIds.add(member.workspaceId);
      }
    }
    return Array.from(this.workspacesById.values()).filter((w) => {
      if (w.kind === 'personal') return w.ownerId === userId;
      return teamWorkspaceIds.has(w.id);
    });
  }

  async countWorkspaces(): Promise<number> {
    return this.workspacesById.size;
  }

  // ── P5: Workspace Member methods ────────────────────────────────────────

  async addWorkspaceMember(input: {
    workspaceId: string;
    userId: string;
    role: CdsWorkspaceMember['role'];
    addedByUserId: string | null;
    syncSource?: CdsWorkspaceMember['syncSource'];
  }, now = new Date()): Promise<CdsWorkspaceMember> {
    const key = `${input.workspaceId}:${input.userId}`;
    const existing = this.membersByKey.get(key);
    if (existing) {
      // Idempotent: update role if it changed.
      const updated: CdsWorkspaceMember = {
        ...existing,
        role: input.role,
        syncSource: input.syncSource ?? existing.syncSource,
        updatedAt: now.toISOString(),
      };
      this.membersByKey.set(key, updated);
      return updated;
    }
    const member: CdsWorkspaceMember = {
      id: genUuid(),
      workspaceId: input.workspaceId,
      userId: input.userId,
      role: input.role,
      syncSource: input.syncSource ?? 'manual',
      addedAt: now.toISOString(),
      addedByUserId: input.addedByUserId,
      updatedAt: now.toISOString(),
    };
    this.membersByKey.set(key, member);
    return member;
  }

  async findWorkspaceMember(workspaceId: string, userId: string): Promise<CdsWorkspaceMember | null> {
    return this.membersByKey.get(`${workspaceId}:${userId}`) ?? null;
  }

  async listWorkspaceMembers(workspaceId: string): Promise<CdsWorkspaceMember[]> {
    return Array.from(this.membersByKey.values()).filter((m) => m.workspaceId === workspaceId);
  }

  async updateWorkspaceMemberRole(workspaceId: string, userId: string, role: CdsWorkspaceMember['role']): Promise<CdsWorkspaceMember | null> {
    const key = `${workspaceId}:${userId}`;
    const member = this.membersByKey.get(key);
    if (!member) return null;
    const updated: CdsWorkspaceMember = { ...member, role, updatedAt: new Date().toISOString() };
    this.membersByKey.set(key, updated);
    return updated;
  }

  async removeWorkspaceMember(workspaceId: string, userId: string): Promise<boolean> {
    return this.membersByKey.delete(`${workspaceId}:${userId}`);
  }

  async findWorkspacesByMember(userId: string): Promise<CdsWorkspace[]> {
    const wsIds = new Set<string>();
    for (const member of this.membersByKey.values()) {
      if (member.userId === userId) wsIds.add(member.workspaceId);
    }
    return Array.from(this.workspacesById.values()).filter((w) => wsIds.has(w.id));
  }

  // ── P5: Workspace Invite methods ─────────────────────────────────────────

  async createWorkspaceInvite(input: {
    workspaceId: string;
    githubLogin: string;
    role: CdsWorkspaceInvite['role'];
    invitedByUserId: string;
    ttlMs: number;
  }, now = new Date()): Promise<CdsWorkspaceInvite> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { randomBytes } = require('node:crypto') as typeof import('node:crypto');
    const token = randomBytes(32).toString('base64url');
    const invite: CdsWorkspaceInvite = {
      id: genUuid(),
      workspaceId: input.workspaceId,
      githubLogin: input.githubLogin.toLowerCase(),
      token,
      role: input.role,
      invitedByUserId: input.invitedByUserId,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + input.ttlMs).toISOString(),
      acceptedAt: null,
    };
    this.invitesByToken.set(token, invite);
    this.invitesById.set(invite.id, invite);
    return invite;
  }

  async findWorkspaceInviteByToken(token: string, now = new Date()): Promise<CdsWorkspaceInvite | null> {
    const invite = this.invitesByToken.get(token);
    if (!invite) return null;
    if (new Date(invite.expiresAt).getTime() <= now.getTime()) {
      this.invitesByToken.delete(token);
      this.invitesById.delete(invite.id);
      return null;
    }
    return invite;
  }

  async acceptWorkspaceInvite(token: string, userId: string, now = new Date()): Promise<CdsWorkspaceMember | null> {
    const invite = await this.findWorkspaceInviteByToken(token, now);
    if (!invite || invite.acceptedAt !== null) return null;
    const updated: CdsWorkspaceInvite = { ...invite, acceptedAt: now.toISOString() };
    this.invitesByToken.set(token, updated);
    this.invitesById.set(invite.id, updated);
    return this.addWorkspaceMember({
      workspaceId: invite.workspaceId,
      userId,
      role: invite.role,
      addedByUserId: invite.invitedByUserId,
      syncSource: 'manual',
    }, now);
  }

  async listWorkspaceInvites(workspaceId: string): Promise<CdsWorkspaceInvite[]> {
    return Array.from(this.invitesById.values()).filter((i) => i.workspaceId === workspaceId);
  }

  async deleteWorkspaceInvite(id: string): Promise<void> {
    const invite = this.invitesById.get(id);
    if (invite) {
      this.invitesByToken.delete(invite.token);
      this.invitesById.delete(id);
    }
  }

  /**
   * Mark a user as the system owner. Only the auth-service bootstrap step
   * should invoke this — callers pass the user id returned from
   * upsertUser(). This is split out because the bootstrap needs to know
   * it atomically ran once, and the store is the authoritative place.
   */
  async markUserAsSystemOwner(id: string): Promise<CdsUser | null> {
    const user = this.usersById.get(id);
    if (!user) return null;
    const updated: CdsUser = {
      ...user,
      isSystemOwner: true,
      updatedAt: new Date().toISOString(),
    };
    this.usersById.set(id, updated);
    return updated;
  }
}
