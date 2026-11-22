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
  CreateLocalUserInput,
  UserActivityRecord,
  AccountIdentityLinkResult,
  AccountIdentityProvider,
  AccountInvitationProof,
} from '../../domain/auth.js';
import { GithubIdentityDetachedError } from '../../domain/auth.js';
// 2026-06-20：本文件是 ESM 模块（package.json "type":"module"），运行时
// 不存在 require()。原先三处 require('node:crypto') 在 vitest（CJS interop）
// 下能跑，但真实运行（尤其 CDS_AUTH_BACKEND=memory）会抛 "require is not
// defined"，导致 bootstrap/login/users/activity 全部 500。改为顶层 import。
import { randomUUID, randomBytes } from 'node:crypto';
import type { CdsPasskeyStore } from '../../domain/passkey.js';
import type { Collection } from 'mongodb';
import type { OidcArtifact } from './oidc-store.js';
import type { AccountActionRequest, AccountActionStore, AccountSecurityChange } from '../../domain/account-actions.js';

/** The stable contract every AuthStore implementation must satisfy. */
export interface AuthStore {
  readonly passkeys?: CdsPasskeyStore;
  readonly oidcArtifacts?: Collection<OidcArtifact>;
  readonly accountActions?: AccountActionStore;
  // — Users —
  upsertUser(input: UpsertUserInput, now?: Date): Promise<CdsUser>;
  findUserByGithubId(githubId: number): Promise<CdsUser | null>;
  findUserById(id: string): Promise<CdsUser | null>;
  setUserStatus(id: string, status: CdsUser['status']): Promise<CdsUser | null>;
  setUserAdministrator(id: string, isAdministrator: boolean): Promise<CdsUser | null>;
  setExternalLoginAllowed(user: CdsUser, allowed: boolean): Promise<CdsUser | null>;
  findUserByGoogleSubject(subject: string): Promise<CdsUser | null>;
  linkIdentity(user: CdsUser, provider: AccountIdentityProvider, subject: string, label: string): Promise<AccountIdentityLinkResult>;
  detachIdentity(user: CdsUser, provider: AccountIdentityProvider, change: AccountSecurityChange, now: Date): Promise<boolean>;
  findAccountInvitation(hash: string, now: Date): Promise<CdsUser | null>;
  consumeAccountInvitation(user: CdsUser, proof: AccountInvitationProof, now: Date, security?: AccountSecurityChange): Promise<CdsUser | null>;
  applyAccountSecurityChange(user: CdsUser, change: AccountSecurityChange, now: Date): Promise<boolean>;
  touchUserLastLogin(id: string, now?: Date): Promise<void>;
  countUsers(): Promise<number>;
  /** All users (system-owner management view). Password fields included — callers must redact. */
  listUsers(): Promise<CdsUser[]>;

  // — Local credential users —
  /** Create a local username + password account. Throws on duplicate username. */
  createLocalUser(input: CreateLocalUserInput, now?: Date): Promise<CdsUser>;
  /** Case-insensitive lookup by local username. Returns null for OAuth-only users. */
  findUserByUsername(username: string): Promise<CdsUser | null>;
  /** Replace a user's password hash + salt (change-password / admin reset). */
  updateUserPassword(id: string, passwordHash: string, passwordSalt: string, now?: Date): Promise<CdsUser | null>;

  // — User activity / trace log —
  recordActivity(record: UserActivityRecord): Promise<void>;
  /** Query activity newest-first; filter by user when userId provided. */
  listActivity(opts?: { userId?: string; limit?: number }): Promise<UserActivityRecord[]>;

  // — Sessions —
  createSession(input: {
    userId: string;
    sessionRevision?: string;
    ttlMs: number;
    passkeyAuthenticated?: true;
    userAgent: string | null;
    ipAddress: string | null;
  }, now?: Date): Promise<CdsSession>;
  findSessionByToken(token: string, now?: Date): Promise<CdsSession | null>;
  /**
   * Sliding renewal: push a live session's expiry out to `now + ttlMs`.
   * Returns the updated session, or null when the token is unknown/expired.
   */
  extendSession(token: string, ttlMs: number, now?: Date): Promise<CdsSession | null>;
  deleteSession(token: string): Promise<void>;
  deleteSessionsForUser(userId: string): Promise<number>;
  countAccountSessions(user: CdsUser, now: Date): Promise<number>;
  listAccountSessions(userId: string, revision: string | undefined, now: Date): Promise<CdsSession[]>;

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
  return randomUUID().replace(/-/g, '');
}

/**
 * Unique negative placeholder GitHub id for local-credential users (who have
 * no real GitHub identity). Real GitHub ids are positive, so negatives never
 * clash with OAuth users; a 53-bit random keeps collisions between local users
 * astronomically unlikely so the `cds_users.githubId` unique index never trips.
 */
export function localPlaceholderGithubId(): number {
  return -(Math.floor(Math.random() * 9_000_000_000_000_000) + 1);
}

/**
 * Default session TTL in milliseconds. 7 days — the project-wide login window
 * (MAP and the gateway console use the same figure). Sessions slide forward on
 * use, so 7 days is "7 days of inactivity", not "7 days since login".
 */
export const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Max user-activity records kept in the in-memory ring buffer. */
export const ACTIVITY_RING_CAPACITY = 1000;

export class MemoryAuthStore implements AuthStore {
  private readonly usersById = new Map<string, CdsUser>();
  private readonly usersByGithubId = new Map<number, string>();
  private readonly usersByUsername = new Map<string, string>();
  /** Newest-last ring buffer of activity records, capped at ACTIVITY_RING_CAPACITY. */
  private activity: UserActivityRecord[] = [];
  private readonly sessionsByToken = new Map<string, CdsSession>();
  private readonly accountRequests = new Map<string, AccountActionRequest>();
  readonly accountActions: AccountActionStore = {
    insert: async request => {
      if (this.accountRequests.has(request.id)) throw new Error('Account request exists');
      this.accountRequests.set(request.id, request);
    },
    get: async id => this.accountRequests.get(id) ?? null,
    list: async (filter, limit) => Array.from(this.accountRequests.values()).reverse()
      .filter(item => (!filter.targetId || filter.targetId === item.targetId) &&
        (!filter.requestedByAccountId || filter.requestedByAccountId === item.requestedByAccountId) &&
        (!filter.action || filter.action === item.action) &&
        (!filter.from || item.createdAt >= filter.from) &&
        (!filter.until || item.createdAt <= filter.until))
      .slice(0, limit),
    transition: async (request, from) => {
      if (this.accountRequests.get(request.id)?.status !== from) return false;
      this.accountRequests.set(request.id, request);
      return true;
    },
  };
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
        ...(existing.authProvider === 'local'
          ? { linkedGithubLogin: input.githubLogin }
          : { githubLogin: input.githubLogin, email: input.email, name: input.name, avatarUrl: input.avatarUrl }),
        orgs: [...input.orgs],
        orgsCheckedAt: now.toISOString(),
        updatedAt: now.toISOString(),
      };
      this.usersById.set(existingId, updated);
      return updated;
    }

    if (Array.from(this.usersById.values()).some(user => user.detachedGithubIds?.includes(input.githubId))) {
      throw new GithubIdentityDetachedError();
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

  async setUserAdministrator(id: string, isAdministrator: boolean): Promise<CdsUser | null> {
    const user = this.usersById.get(id);
    if (!user || user.isSystemOwner) return null;
    const updated = { ...user, isAdministrator, updatedAt: new Date().toISOString() };
    this.usersById.set(id, updated);
    return updated;
  }

  async setExternalLoginAllowed(expected: CdsUser, allowed: boolean): Promise<CdsUser | null> {
    const user = this.usersById.get(expected.id);
    if (!user || user.status !== 'active' || user.isSystemOwner !== expected.isSystemOwner ||
        Boolean(user.isAdministrator) !== Boolean(expected.isAdministrator)) return null;
    const updated = { ...user, externalLoginAllowed: allowed, updatedAt: new Date().toISOString() };
    this.usersById.set(user.id, updated);
    return updated;
  }

  async findUserByGoogleSubject(subject: string): Promise<CdsUser | null> {
    return Array.from(this.usersById.values()).find(user => user.googleSubject === subject) ?? null;
  }

  async linkIdentity(expected: CdsUser, provider: AccountIdentityProvider, subject: string, label: string): Promise<AccountIdentityLinkResult> {
    const user = this.usersById.get(expected.id);
    if (!user || user.status !== 'active' || !user.externalLoginAllowed ||
        user.sessionRevision !== expected.sessionRevision) return 'account_changed';
    if (provider === 'github') {
      const id = Number(subject);
      if (this.usersByGithubId.has(id) && this.usersByGithubId.get(id) !== user.id) return 'identity_taken';
      if (user.githubId > 0 && user.githubId !== id) return 'provider_already_linked';
      this.usersByGithubId.delete(user.githubId);
      this.usersByGithubId.set(id, user.id);
      this.usersById.set(user.id, { ...user, githubId: id, linkedGithubLogin: label, updatedAt: new Date().toISOString() });
      return 'linked';
    }
    if (Array.from(this.usersById.values()).some(item => item.id !== user.id && item.googleSubject === subject)) return 'identity_taken';
    if (user.googleSubject && user.googleSubject !== subject) return 'provider_already_linked';
    this.usersById.set(user.id, { ...user, googleSubject: subject, linkedGoogleLabel: label, updatedAt: new Date().toISOString() });
    return 'linked';
  }

  async findAccountInvitation(hash: string, now: Date): Promise<CdsUser | null> {
    return Array.from(this.usersById.values()).find(user =>
      user.status === 'active' && user.invitationHash === hash && (user.invitationExpiresAt ?? '') > now.toISOString()) ?? null;
  }

  async detachIdentity(expected: CdsUser, provider: AccountIdentityProvider, change: AccountSecurityChange, now: Date): Promise<boolean> {
    const user = this.usersById.get(expected.id);
    if (!user || user.status !== 'active' || user.sessionRevision !== expected.sessionRevision ||
        user.passwordHash !== expected.passwordHash || user.githubId !== expected.githubId || user.googleSubject !== expected.googleSubject) return false;
    const updated = { ...user, ...change, updatedAt: now.toISOString() };
    if (provider === 'github') {
      this.usersByGithubId.delete(user.githubId);
      updated.githubId = localPlaceholderGithubId();
      updated.detachedGithubIds = Array.from(new Set([...(user.detachedGithubIds ?? []), user.githubId]));
      delete updated.linkedGithubLogin;
    } else {
      delete updated.googleSubject;
      delete updated.linkedGoogleLabel;
    }
    this.usersById.set(user.id, updated);
    return true;
  }

  async consumeAccountInvitation(expected: CdsUser, proof: AccountInvitationProof, now: Date, security?: AccountSecurityChange): Promise<CdsUser | null> {
    const user = this.usersById.get(expected.id);
    if (!user || user.status !== 'active' || !user.invitationHash || user.invitationHash !== expected.invitationHash ||
        user.sessionRevision !== expected.sessionRevision || (user.invitationExpiresAt ?? '') <= now.toISOString()) return null;
    const { invitationHash: _hash, invitationExpiresAt: _expires, invitationForRecovery: _recovery, ...rest } = user;
    const updated = { ...rest, ...security, updatedAt: now.toISOString() };
    if ('passwordHash' in proof) {
      updated.passwordHash = proof.passwordHash;
      updated.passwordSalt = proof.passwordSalt;
    } else {
      if (!user.externalLoginAllowed) return null;
      if (proof.provider === 'github') {
        const id = Number(proof.subject);
        if (this.usersByGithubId.has(id) && this.usersByGithubId.get(id) !== user.id) return null;
        this.usersByGithubId.delete(user.githubId);
        this.usersByGithubId.set(id, user.id);
        updated.githubId = id;
        updated.linkedGithubLogin = proof.label;
      } else {
        if (Array.from(this.usersById.values()).some(existing => existing.googleSubject === proof.subject)) return null;
        updated.googleSubject = proof.subject;
        updated.linkedGoogleLabel = proof.label;
      }
    }
    this.usersById.set(user.id, updated);
    return updated;
  }

  async applyAccountSecurityChange(expected: CdsUser, change: AccountSecurityChange, now: Date): Promise<boolean> {
    const user = this.usersById.get(expected.id);
    if (!user || user.sessionRevision !== expected.sessionRevision ||
        user.status !== expected.status || user.passwordHash !== expected.passwordHash ||
        Boolean(user.isAdministrator) !== Boolean(expected.isAdministrator) ||
        user.isSystemOwner !== expected.isSystemOwner) return false;
    this.usersById.set(user.id, { ...user, ...change, updatedAt: now.toISOString() });
    return true;
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

  async listUsers(): Promise<CdsUser[]> {
    return Array.from(this.usersById.values());
  }

  // ── Local credential users ──────────────────────────────────────────────

  async createLocalUser(input: CreateLocalUserInput, now = new Date()): Promise<CdsUser> {
    const username = input.username.toLowerCase();
    if (this.usersByUsername.has(username)) {
      throw new Error(`Local user with username '${username}' already exists`);
    }
    const id = genUuid();
    const user: CdsUser = {
      id,
      // 本地账号没有真实 GitHub 身份。给一个唯一负数占位（真实 GitHub ID 恒正），
      // 避免多个本地用户都用 githubId:0 在 cds_users.githubId 唯一索引上撞键
      // （修复 PR #865 P1「githubId 0 复用导致第二个本地账号建不出」）。
      githubId: localPlaceholderGithubId(),
      githubLogin: username,
      authProvider: 'local',
      username,
      ...(input.passwordHash && input.passwordSalt ? { passwordHash: input.passwordHash, passwordSalt: input.passwordSalt } : {}),
      ...(input.invitationHash ? { invitationHash: input.invitationHash, invitationExpiresAt: input.invitationExpiresAt } : {}),
      email: input.email ?? null,
      name: input.name?.trim() || input.username,
      avatarUrl: null,
      orgs: [],
      orgsCheckedAt: now.toISOString(),
      isSystemOwner: input.isSystemOwner ?? false,
      ...(input.isAdministrator ? { isAdministrator: true } : {}),
      ...(input.externalLoginAllowed ? { externalLoginAllowed: true } : {}),
      status: 'active',
      lastLoginAt: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    this.usersById.set(id, user);
    this.usersByUsername.set(username, id);
    return user;
  }

  async findUserByUsername(username: string): Promise<CdsUser | null> {
    const id = this.usersByUsername.get(username.toLowerCase());
    return id ? this.usersById.get(id) || null : null;
  }

  async updateUserPassword(id: string, passwordHash: string, passwordSalt: string, now = new Date()): Promise<CdsUser | null> {
    const user = this.usersById.get(id);
    if (!user) return null;
    const updated: CdsUser = {
      ...user,
      passwordHash,
      passwordSalt,
      updatedAt: now.toISOString(),
    };
    this.usersById.set(id, updated);
    return updated;
  }

  // ── User activity / trace log ────────────────────────────────────────────

  async recordActivity(record: UserActivityRecord): Promise<void> {
    this.activity.push(record);
    if (this.activity.length > ACTIVITY_RING_CAPACITY) {
      this.activity = this.activity.slice(this.activity.length - ACTIVITY_RING_CAPACITY);
    }
  }

  async listActivity(opts?: { userId?: string; limit?: number }): Promise<UserActivityRecord[]> {
    const limit = Math.max(1, Math.min(opts?.limit ?? 200, ACTIVITY_RING_CAPACITY));
    let rows = this.activity;
    if (opts?.userId) {
      rows = rows.filter((r) => r.userId === opts.userId);
    }
    // Newest first.
    return rows.slice().reverse().slice(0, limit);
  }

  async createSession(input: {
    userId: string;
    sessionRevision?: string;
    ttlMs: number;
    passkeyAuthenticated?: true;
    userAgent: string | null;
    ipAddress: string | null;
  }, now = new Date()): Promise<CdsSession> {
    const token = randomBytes(48).toString('base64url');
    const session: CdsSession = {
      token,
      userId: input.userId,
      ...(input.sessionRevision ? { sessionRevision: input.sessionRevision } : {}),
      createdAt: now.toISOString(),
      ...(input.passkeyAuthenticated ? { passkeyAuthenticated: true } : {}),
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

  async extendSession(token: string, ttlMs: number, now = new Date()): Promise<CdsSession | null> {
    const session = this.sessionsByToken.get(token);
    if (!session) return null;
    if (new Date(session.expiresAt).getTime() <= now.getTime()) {
      this.sessionsByToken.delete(token);
      return null;
    }
    const updated: CdsSession = {
      ...session,
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
      lastSeenAt: now.toISOString(),
    };
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

  async countAccountSessions(user: CdsUser, now: Date): Promise<number> {
    let count = 0;
    for (const session of this.sessionsByToken.values()) {
      if (session.userId === user.id && session.sessionRevision === user.sessionRevision && session.expiresAt > now.toISOString()) count++;
    }
    return count;
  }

  async listAccountSessions(userId: string, revision: string | undefined, now: Date): Promise<CdsSession[]> {
    return Array.from(this.sessionsByToken.values()).filter(session => session.userId === userId &&
      session.sessionRevision === revision && session.expiresAt > now.toISOString());
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
