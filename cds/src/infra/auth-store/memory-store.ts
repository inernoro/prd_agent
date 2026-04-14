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
    // P2: personal workspaces are looked up by owner. Team membership
    // filtering lands in P5.
    return Array.from(this.workspacesById.values()).filter(
      (w) => w.ownerId === userId && w.kind === 'personal',
    );
  }

  async countWorkspaces(): Promise<number> {
    return this.workspacesById.size;
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
