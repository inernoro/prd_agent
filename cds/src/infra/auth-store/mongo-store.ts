/**
 * MongoAuthStore — FU-02 MongoDB-backed AuthStore implementation.
 *
 * Implements the same `AuthStore` interface as `MemoryAuthStore` (P2)
 * plus the duck-typed `markUserAsSystemOwner` that `auth-service.ts`
 * calls via `'markUserAsSystemOwner' in this.store`.
 *
 * Collections used:
 *   cds_users      — one document per CDS user (keyed by GitHub id)
 *   cds_sessions   — one document per login session (keyed by token)
 *   cds_workspaces — one document per workspace (keyed by slug)
 *
 * Indexes (maintained by DBA, NOT auto-created — see no-auto-index.md):
 *   cds_users.githubId          unique
 *   cds_users.id                unique
 *   cds_sessions.token          unique
 *   cds_sessions.userId         non-unique
 *   cds_sessions.expiresAt      TTL (optional but recommended)
 *   cds_workspaces.slug         unique
 *   cds_workspaces.ownerId      non-unique
 *
 * Design notes:
 * - All reads are fully async; no write-behind caching (unlike the state
 *   store). Auth reads are infrequent enough that direct round-trips are fine.
 * - Session expiry is enforced eagerly on every findSessionByToken read
 *   (delete + return null). MongoDB TTL indexes handle background cleanup.
 * - lastSeenAt is updated on successful session validation (fire-and-forget).
 * - `markUserAsSystemOwner` is NOT in the AuthStore interface; it is called
 *   duck-typed from auth-service.ts. Both MemoryAuthStore and this class
 *   implement it so the behaviour is symmetric.
 *
 * Migration from MemoryAuthStore:
 *   Set CDS_AUTH_BACKEND=mongo, restart. All users need to re-authenticate
 *   once (deliberate — memory state is not migrated). First login becomes
 *   the system owner automatically.
 */

import { randomUUID, randomBytes } from 'node:crypto';
import type { AuthStore } from './memory-store.js';
import type { CdsUser, CdsSession, CdsWorkspace, UpsertUserInput } from '../../domain/auth.js';
import type { IAuthMongoHandle } from './mongo-handle.js';

export { IAuthMongoHandle };

export class MongoAuthStore implements AuthStore {
  constructor(private readonly handle: IAuthMongoHandle) {}

  // ── Users ─────────────────────────────────────────────────────────────────

  async upsertUser(input: UpsertUserInput, now = new Date()): Promise<CdsUser> {
    const users = this.handle.usersCollection();
    const existing = await users.findOne({ githubId: input.githubId });

    if (existing) {
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
      await users.replaceOne({ githubId: input.githubId }, updated);
      return updated;
    }

    const newUser: CdsUser = {
      id: randomUUID().replace(/-/g, ''),
      githubId: input.githubId,
      githubLogin: input.githubLogin,
      email: input.email,
      name: input.name,
      avatarUrl: input.avatarUrl,
      orgs: [...input.orgs],
      orgsCheckedAt: now.toISOString(),
      isSystemOwner: false,
      status: 'active',
      lastLoginAt: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    await users.insertOne(newUser);
    return newUser;
  }

  async findUserByGithubId(githubId: number): Promise<CdsUser | null> {
    return this.handle.usersCollection().findOne({ githubId });
  }

  async findUserById(id: string): Promise<CdsUser | null> {
    return this.handle.usersCollection().findOne({ id });
  }

  async setUserStatus(id: string, status: CdsUser['status']): Promise<CdsUser | null> {
    const users = this.handle.usersCollection();
    const user = await users.findOne({ id });
    if (!user) return null;
    const updated: CdsUser = { ...user, status, updatedAt: new Date().toISOString() };
    await users.replaceOne({ id }, updated);
    return updated;
  }

  async touchUserLastLogin(id: string, now = new Date()): Promise<void> {
    const users = this.handle.usersCollection();
    const user = await users.findOne({ id });
    if (!user) return;
    await users.replaceOne({ id }, {
      ...user,
      lastLoginAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
  }

  async countUsers(): Promise<number> {
    return this.handle.usersCollection().countDocuments();
  }

  /**
   * Mark a user as the system owner (duck-typed from auth-service.ts).
   * Not in the AuthStore interface — both MemoryAuthStore and this class
   * implement it as a side-channel so auth-service can flip the flag.
   */
  async markUserAsSystemOwner(id: string): Promise<CdsUser | null> {
    const users = this.handle.usersCollection();
    const user = await users.findOne({ id });
    if (!user) return null;
    const updated: CdsUser = {
      ...user,
      isSystemOwner: true,
      updatedAt: new Date().toISOString(),
    };
    await users.replaceOne({ id }, updated);
    return updated;
  }

  // ── Sessions ──────────────────────────────────────────────────────────────

  async createSession(
    input: {
      userId: string;
      ttlMs: number;
      userAgent: string | null;
      ipAddress: string | null;
    },
    now = new Date(),
  ): Promise<CdsSession> {
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
    await this.handle.sessionsCollection().insertOne(session);
    return session;
  }

  async findSessionByToken(token: string, now = new Date()): Promise<CdsSession | null> {
    if (!token) return null;
    const sessions = this.handle.sessionsCollection();
    const session = await sessions.findOne({ token });
    if (!session) return null;

    // Enforce expiry eagerly — delete the session and report as missing.
    if (new Date(session.expiresAt).getTime() <= now.getTime()) {
      await sessions.deleteOne({ token });
      return null;
    }

    // Touch lastSeenAt (fire-and-forget — don't block the response).
    sessions
      .replaceOne({ token }, { ...session, lastSeenAt: now.toISOString() })
      .catch(() => { /* non-critical — ignore write errors for lastSeenAt */ });

    return { ...session, lastSeenAt: now.toISOString() };
  }

  async deleteSession(token: string): Promise<void> {
    await this.handle.sessionsCollection().deleteOne({ token });
  }

  async deleteSessionsForUser(userId: string): Promise<number> {
    return this.handle.sessionsCollection().deleteMany({ userId });
  }

  // ── Workspaces ────────────────────────────────────────────────────────────

  async createWorkspace(
    input: {
      slug: string;
      name: string;
      kind: CdsWorkspace['kind'];
      ownerId: string;
      githubOrgLogin?: string | null;
      githubOrgId?: number | null;
      description?: string | null;
    },
    now = new Date(),
  ): Promise<CdsWorkspace> {
    const workspaces = this.handle.workspacesCollection();

    // Guard against duplicate slugs (mirror MemoryAuthStore behaviour).
    const existing = await workspaces.findOne({ slug: input.slug });
    if (existing) {
      throw new Error(`Workspace with slug '${input.slug}' already exists`);
    }

    const workspace: CdsWorkspace = {
      id: randomUUID().replace(/-/g, ''),
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
    await workspaces.insertOne(workspace);
    return workspace;
  }

  async findWorkspaceBySlug(slug: string): Promise<CdsWorkspace | null> {
    return this.handle.workspacesCollection().findOne({ slug });
  }

  async findWorkspacesForUser(userId: string): Promise<CdsWorkspace[]> {
    // P2: personal workspaces only. Team membership (P5) filters on kind === 'team'.
    return this.handle.workspacesCollection().find({ ownerId: userId, kind: 'personal' });
  }

  async countWorkspaces(): Promise<number> {
    return this.handle.workspacesCollection().countDocuments();
  }
}
