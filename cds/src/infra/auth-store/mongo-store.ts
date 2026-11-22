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
 *   cds_users.username          unique, sparse (OAuth users have no username;
 *                               closes the local-create duplicate-username race)
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
import type {
  CdsUser, CdsSession, CdsWorkspace, CdsWorkspaceMember, CdsWorkspaceInvite, UpsertUserInput,
  CreateLocalUserInput, UserActivityRecord,
  AccountIdentityLinkResult, AccountIdentityProvider,
  AccountInvitationProof,
} from '../../domain/auth.js';
import { ACTIVITY_RING_CAPACITY, localPlaceholderGithubId } from './memory-store.js';
import type { IAuthMongoHandle } from './mongo-handle.js';
import type { CdsPasskeyStore } from '../../domain/passkey.js';
import type { Collection } from 'mongodb';
import type { OidcArtifact } from './oidc-store.js';
import type { AccountActionStore, AccountSecurityChange } from '../../domain/account-actions.js';

export { IAuthMongoHandle };

export class MongoAuthStore implements AuthStore {
  readonly passkeys?: CdsPasskeyStore;
  get oidcArtifacts(): Collection<OidcArtifact> | undefined { return this.handle.oidcCollection?.(); }
  get accountActions(): AccountActionStore | undefined {
    const actions = this.handle.accountActionsCollection?.();
    const update = actions?.updateOneMatched;
    if (!actions || !update) return undefined;
    return {
      insert: item => actions.insertOne(item),
      get: id => actions.findOne({ id }),
      list: ({ from, until, ...filter }, limit) => actions.find({
        ...filter,
        ...(from || until ? { createdAt: { ...(from ? { $gte: from } : {}), ...(until ? { $lte: until } : {}) } } : {}),
      }, { sort: { createdAt: -1 }, limit }),
      transition: (item, from) => update({ id: item.id, status: from }, { $set: item }),
    };
  }

  constructor(private readonly handle: IAuthMongoHandle) {
    const keys = handle.passkeysCollection?.bind(handle);
    if (!keys) return;
    this.passkeys = {
      find: id => keys().findOne({ _id: id }),
      list: userId => keys().find({ userId }).toArray(),
      insert: async key => { await keys().insertOne({ _id: key.id, ...key }); },
      advanceCounter: async (id, previous, next) => {
        const result = await keys().updateOne({ _id: id, counter: previous }, { $set: { counter: next } });
        return result.matchedCount === 1;
      },
    };
  }

  /**
   * 本地账号创建串行锁。createLocalUser 是"findOne 查重 + insertOne"两步，并发下
   * 两个同名 create 可能都过 findOne 再都 insert。CDS master 单实例单进程，把创建
   * 串到这条链上即可关闭进程内竞态窗口；跨实例/DB 级仍由文件头记录的 cds_users.username
   * 唯一(sparse)索引 + 下方 E11000 归一兜底（修复 PR #865 Codex P2「Make Mongo local
   * username creation atomic」）。
   */
  private createUserChain: Promise<void> = Promise.resolve();

  // ── Users ─────────────────────────────────────────────────────────────────

  async upsertUser(input: UpsertUserInput, now = new Date()): Promise<CdsUser> {
    const users = this.handle.usersCollection();
    const existing = await users.findOne({ githubId: input.githubId });

    if (existing) {
      const updated = {
        ...(existing.authProvider === 'local'
          ? { linkedGithubLogin: input.githubLogin }
          : { githubLogin: input.githubLogin, email: input.email, name: input.name, avatarUrl: input.avatarUrl }),
        orgs: [...input.orgs],
        orgsCheckedAt: now.toISOString(),
        updatedAt: now.toISOString(),
      };
      await users.updateOne({ id: existing.id }, { $set: updated });
      return (await users.findOne({ id: existing.id }))!;
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
    await users.updateOne({ id }, { $set: { status, updatedAt: new Date().toISOString() } });
    return users.findOne({ id });
  }

  async setUserAdministrator(id: string, isAdministrator: boolean): Promise<CdsUser | null> {
    const users = this.handle.usersCollection();
    await users.updateOne({ id, isSystemOwner: { $ne: true } }, { $set: {
      isAdministrator, updatedAt: new Date().toISOString(),
    } });
    const current = await users.findOne({ id });
    return current?.isSystemOwner ? null : current;
  }

  async setExternalLoginAllowed(expected: CdsUser, allowed: boolean): Promise<CdsUser | null> {
    const users = this.handle.usersCollection();
    const changed = await users.updateOneMatched?.({
      id: expected.id, status: 'active', isSystemOwner: expected.isSystemOwner,
      isAdministrator: expected.isAdministrator === true ? true : { $ne: true },
    }, { $set: { externalLoginAllowed: allowed, updatedAt: new Date().toISOString() } });
    return changed ? users.findOne({ id: expected.id }) : null;
  }

  async findUserByGoogleSubject(subject: string): Promise<CdsUser | null> {
    return this.handle.usersCollection().findOne({ googleSubject: subject });
  }

  async linkIdentity(expected: CdsUser, provider: AccountIdentityProvider, subject: string, label: string): Promise<AccountIdentityLinkResult> {
    if (!this.handle.ensureExternalIdentityIndexes) return 'account_changed';
    await this.handle.ensureExternalIdentityIndexes();
    const users = this.handle.usersCollection();
    const found = provider === 'github' ? await users.findOne({ githubId: Number(subject) })
      : await users.findOne({ googleSubject: subject });
    if (found && found.id !== expected.id) return 'identity_taken';
    const other = provider === 'github' ? expected.githubId > 0 && expected.githubId !== Number(subject)
      : expected.googleSubject && expected.googleSubject !== subject;
    if (other) return 'provider_already_linked';
    const filter = provider === 'github' ? { githubId: expected.githubId } : { googleSubject: expected.googleSubject ?? { $exists: false } };
    const binding = provider === 'github' ? { githubId: Number(subject), linkedGithubLogin: label }
      : { googleSubject: subject, linkedGoogleLabel: label };
    try {
      const matched = await users.updateOneMatched?.({
        ...filter, id: expected.id, status: 'active', externalLoginAllowed: true,
        sessionRevision: expected.sessionRevision ?? { $exists: false },
      }, { $set: { ...binding, updatedAt: new Date().toISOString() } });
      return matched ? 'linked' : 'account_changed';
    } catch (error) {
      if ((error as { code?: number })?.code === 11000) return 'identity_taken';
      throw error;
    }
  }

  async findAccountInvitation(hash: string, now: Date): Promise<CdsUser | null> {
    return this.handle.usersCollection().findOne({ status: 'active', invitationHash: hash, invitationExpiresAt: { $gt: now.toISOString() } });
  }

  async consumeAccountInvitation(user: CdsUser, proof: AccountInvitationProof, now: Date, security?: AccountSecurityChange): Promise<CdsUser | null> {
    if (!user.invitationHash) return null;
    const users = this.handle.usersCollection();
    const external = 'provider' in proof;
    if (external) {
      if (!this.handle.ensureExternalIdentityIndexes) return null;
      await this.handle.ensureExternalIdentityIndexes();
    }
    const change = !external ? proof : proof.provider === 'github'
      ? { githubId: Number(proof.subject), linkedGithubLogin: proof.label }
      : { googleSubject: proof.subject, linkedGoogleLabel: proof.label };
    try {
      const matched = await users.updateOneMatched?.({
        id: user.id, status: 'active', invitationHash: user.invitationHash, invitationExpiresAt: { $gt: now.toISOString() },
        sessionRevision: user.sessionRevision ?? { $exists: false },
        ...(external ? { externalLoginAllowed: true } : {}),
      }, { $set: { ...change, ...security, updatedAt: now.toISOString() },
        $unset: { invitationHash: '', invitationExpiresAt: '', invitationForRecovery: '' } });
      return matched ? users.findOne({ id: user.id }) : null;
    } catch (error) {
      if ((error as { code?: number })?.code === 11000) return null;
      throw error;
    }
  }

  async applyAccountSecurityChange(user: CdsUser, change: AccountSecurityChange, now: Date): Promise<boolean> {
    const users = this.handle.usersCollection();
    if (!users.updateOneMatched) throw new Error('Account security updates are unavailable');
    return users.updateOneMatched({
      id: user.id,
      status: user.status,
      isSystemOwner: user.isSystemOwner,
      isAdministrator: user.isAdministrator === true ? true : { $ne: true },
      passwordHash: user.passwordHash ?? { $exists: false },
      sessionRevision: user.sessionRevision ?? { $exists: false },
    }, { $set: { ...change, updatedAt: now.toISOString() } });
  }

  async touchUserLastLogin(id: string, now = new Date()): Promise<void> {
    const at = now.toISOString();
    await this.handle.usersCollection().updateOne({ id }, { $set: { lastLoginAt: at, updatedAt: at } });
  }

  async countUsers(): Promise<number> {
    return this.handle.usersCollection().countDocuments();
  }

  async listUsers(): Promise<CdsUser[]> {
    return this.handle.usersCollection().find({});
  }

  // ── Local credential users ──────────────────────────────────────────────

  async createLocalUser(input: CreateLocalUserInput, now = new Date()): Promise<CdsUser> {
    // 串到 createUserChain 上：上一次创建彻底结束后才执行本次的"查重 + 插入"，
    // 关闭进程内同名并发竞态（见 createUserChain 注释）。
    const prev = this.createUserChain;
    let release!: () => void;
    this.createUserChain = new Promise<void>((resolve) => { release = resolve; });
    try {
      await prev.catch(() => { /* 上一次失败不应阻断本次 */ });
      return await this.createLocalUserUnlocked(input, now);
    } finally {
      release();
    }
  }

  private async createLocalUserUnlocked(input: CreateLocalUserInput, now: Date): Promise<CdsUser> {
    const username = input.username.toLowerCase();
    const users = this.handle.usersCollection();
    const existing = await users.findOne({ username });
    if (existing) {
      throw new Error(`Local user with username '${username}' already exists`);
    }
    const user: CdsUser = {
      id: randomUUID().replace(/-/g, ''),
      // 唯一负数占位，避免多个本地账号在 cds_users.githubId 唯一索引上撞 0
      // （修复 PR #865 P1）。真实 GitHub ID 恒正，负数永不与 OAuth 用户冲突。
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
    try {
      await users.insertOne(user);
    } catch (err) {
      // 并发下两个同名 create 可能都过了上面的 findOne。若 DBA 建了
      // cds_users.username 唯一(sparse)索引（见文件头 Indexes 段），DB 会以
      // E11000 拒掉第二个 insert——这里归一成与 findOne 分支一致的"已存在"错误
      // （修复 PR #865 Bugbot「Mongo local user duplicate username race」）。
      if ((err as { code?: number })?.code === 11000) {
        throw new Error(`Local user with username '${username}' already exists`);
      }
      throw err;
    }
    return user;
  }

  async findUserByUsername(username: string): Promise<CdsUser | null> {
    return this.handle.usersCollection().findOne({ username: username.toLowerCase() });
  }

  async updateUserPassword(id: string, passwordHash: string, passwordSalt: string, now = new Date()): Promise<CdsUser | null> {
    const users = this.handle.usersCollection();
    await users.updateOne({ id }, { $set: { passwordHash, passwordSalt, updatedAt: now.toISOString() } });
    return users.findOne({ id });
  }

  // ── User activity / trace log ────────────────────────────────────────────

  async recordActivity(record: UserActivityRecord): Promise<void> {
    const col = this.handle.activityCollection();
    await col.insertOne(record);
    // 与 memory store 的 ring buffer 对齐：mongo 端 cds_user_activity 无 TTL，
    // 不裁剪会无界增长（修复 PR #865 Low「mongo 活动日志永不封顶」）。每隔若干次
    // 插入做一次 best-effort 裁剪：删掉超出最近 ACTIVITY_RING_CAPACITY 条之外的旧记录。
    // 抽样触发避免每次插入都扫描；裁剪失败不致命（下次再裁）。
    if (Math.random() < 0.02) {
      try {
        const cutoff = await col.find({}, { sort: { at: -1 }, skip: ACTIVITY_RING_CAPACITY, limit: 1 });
        const cutoffAt = cutoff[0]?.at;
        if (cutoffAt) {
          // 严格小于 cutoff：与 cutoff 同毫秒(at 相等)的较新记录保留，避免一批
          // 同毫秒写入被连带删掉而跌破容量（修复 PR #865 Bugbot「裁剪过删」）。
          // 代价是偶尔多留几条，无害。
          await col.deleteMany({ at: { $lt: cutoffAt } });
        }
      } catch { /* best-effort trim; tolerate failure */ }
    }
  }

  async listActivity(opts?: { userId?: string; limit?: number }): Promise<UserActivityRecord[]> {
    const limit = Math.max(1, Math.min(opts?.limit ?? 200, ACTIVITY_RING_CAPACITY));
    const filter = opts?.userId ? { userId: opts.userId } : {};
    return this.handle.activityCollection().find(filter, { sort: { at: -1 }, limit });
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
      sessionRevision?: string;
      ttlMs: number;
      passkeyAuthenticated?: true;
      userAgent: string | null;
      ipAddress: string | null;
    },
    now = new Date(),
  ): Promise<CdsSession> {
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
    await this.handle.sessionsCollection().insertOne(session);
    return session;
  }

  async findSessionByToken(token: string, now = new Date()): Promise<CdsSession | null> {
    if (!token) return null;
    const sessions = this.handle.sessionsCollection();
    const session = await sessions.findOne({ token });
    if (!session) return null;

    // Enforce expiry eagerly — delete the session and report as missing.
    // Filter on the expiry we observed: a concurrent request can renew the session
    // between our read and this delete, and a token-only delete would wipe that
    // perfectly valid, just-extended session.
    if (new Date(session.expiresAt).getTime() <= now.getTime()) {
      await sessions.deleteOne({ token, expiresAt: session.expiresAt });
      return null;
    }

    // Touch lastSeenAt (fire-and-forget — don't block the response).
    // Field-level $set, never a full-document replace: this write is unawaited, so a
    // replace carrying the document we read could land *after* extendSession() and
    // roll `expiresAt` back to the old deadline — silently un-renewing the session.
    sessions
      .updateOne({ token }, { $set: { lastSeenAt: now.toISOString() } })
      .catch(() => { /* non-critical — ignore write errors for lastSeenAt */ });

    return { ...session, lastSeenAt: now.toISOString() };
  }

  async extendSession(token: string, ttlMs: number, now = new Date()): Promise<CdsSession | null> {
    if (!token) return null;
    const sessions = this.handle.sessionsCollection();
    const session = await sessions.findOne({ token });
    if (!session) return null;

    // Same guard as findSessionByToken: never delete on a token-only filter, or a
    // sibling request that renewed this session first would lose it.
    if (new Date(session.expiresAt).getTime() <= now.getTime()) {
      await sessions.deleteOne({ token, expiresAt: session.expiresAt });
      return null;
    }

    const updated: CdsSession = {
      ...session,
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
      lastSeenAt: now.toISOString(),
    };
    // Field-level $set filtered on the observed expiry (and never upsert): a concurrent
    // logout or a competing renewal turns this into a no-op instead of resurrecting or
    // clobbering the session, and touching only these two fields means an in-flight
    // lastSeenAt write cannot drag `expiresAt` back. The returned value is only used for
    // the cookie expiry; if the session did vanish, the next request bounces to /login.
    await sessions.updateOne(
      { token, expiresAt: session.expiresAt },
      { $set: { expiresAt: updated.expiresAt, lastSeenAt: updated.lastSeenAt } },
    );
    return updated;
  }

  async deleteSession(token: string): Promise<void> {
    await this.handle.sessionsCollection().deleteOne({ token });
  }

  async deleteSessionsForUser(userId: string): Promise<number> {
    return this.handle.sessionsCollection().deleteMany({ userId });
  }

  async countAccountSessions(user: CdsUser, now: Date): Promise<number> {
    return this.handle.sessionsCollection().countDocuments({
      userId: user.id,
      sessionRevision: user.sessionRevision ?? { $exists: false },
      expiresAt: { $gt: now.toISOString() },
    });
  }

  async listAccountSessions(userId: string, revision: string | undefined, now: Date): Promise<CdsSession[]> {
    return this.handle.sessionsCollection().find({
      userId,
      sessionRevision: revision ?? { $exists: false },
      expiresAt: { $gt: now.toISOString() },
    }, { sort: { lastSeenAt: -1 } });
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
    // P5: personal workspaces (owned) + team workspaces where user is a member.
    const members = await this.handle.membersCollection().find({ userId });
    const teamWsIds = new Set(members.map((m) => m.workspaceId));

    const personal = await this.handle.workspacesCollection().find({ ownerId: userId, kind: 'personal' });
    if (teamWsIds.size === 0) return personal;

    const team = await Promise.all(
      Array.from(teamWsIds).map((id) => this.handle.workspacesCollection().findOne({ id })),
    );
    const teamWs = team.filter((w): w is CdsWorkspace => w !== null);
    return [...personal, ...teamWs];
  }

  async countWorkspaces(): Promise<number> {
    return this.handle.workspacesCollection().countDocuments();
  }

  // ── P5: Workspace Members ─────────────────────────────────────────────────

  async addWorkspaceMember(input: {
    workspaceId: string;
    userId: string;
    role: CdsWorkspaceMember['role'];
    addedByUserId: string | null;
    syncSource?: CdsWorkspaceMember['syncSource'];
  }, now = new Date()): Promise<CdsWorkspaceMember> {
    const members = this.handle.membersCollection();
    const existing = await members.findOne({ workspaceId: input.workspaceId, userId: input.userId });

    if (existing) {
      const updated: CdsWorkspaceMember = {
        ...existing,
        role: input.role,
        syncSource: input.syncSource ?? existing.syncSource,
        updatedAt: now.toISOString(),
      };
      await members.replaceOne({ workspaceId: input.workspaceId, userId: input.userId }, updated);
      return updated;
    }

    const member: CdsWorkspaceMember = {
      id: randomUUID().replace(/-/g, ''),
      workspaceId: input.workspaceId,
      userId: input.userId,
      role: input.role,
      syncSource: input.syncSource ?? 'manual',
      addedAt: now.toISOString(),
      addedByUserId: input.addedByUserId,
      updatedAt: now.toISOString(),
    };
    await members.insertOne(member);
    return member;
  }

  async findWorkspaceMember(workspaceId: string, userId: string): Promise<CdsWorkspaceMember | null> {
    return this.handle.membersCollection().findOne({ workspaceId, userId });
  }

  async listWorkspaceMembers(workspaceId: string): Promise<CdsWorkspaceMember[]> {
    return this.handle.membersCollection().find({ workspaceId });
  }

  async updateWorkspaceMemberRole(workspaceId: string, userId: string, role: CdsWorkspaceMember['role']): Promise<CdsWorkspaceMember | null> {
    const members = this.handle.membersCollection();
    const member = await members.findOne({ workspaceId, userId });
    if (!member) return null;
    const updated: CdsWorkspaceMember = { ...member, role, updatedAt: new Date().toISOString() };
    await members.replaceOne({ workspaceId, userId }, updated);
    return updated;
  }

  async removeWorkspaceMember(workspaceId: string, userId: string): Promise<boolean> {
    const members = this.handle.membersCollection();
    const existing = await members.findOne({ workspaceId, userId });
    if (!existing) return false;
    await members.deleteOne({ workspaceId, userId });
    return true;
  }

  async findWorkspacesByMember(userId: string): Promise<CdsWorkspace[]> {
    const members = await this.handle.membersCollection().find({ userId });
    const wsIds = members.map((m) => m.workspaceId);
    if (wsIds.length === 0) return [];
    const workspaces = await Promise.all(
      wsIds.map((id) => this.handle.workspacesCollection().findOne({ id })),
    );
    return workspaces.filter((w): w is CdsWorkspace => w !== null);
  }

  // ── P5: Workspace Invites ─────────────────────────────────────────────────

  async createWorkspaceInvite(input: {
    workspaceId: string;
    githubLogin: string;
    role: CdsWorkspaceInvite['role'];
    invitedByUserId: string;
    ttlMs: number;
  }, now = new Date()): Promise<CdsWorkspaceInvite> {
    const token = randomBytes(32).toString('base64url');
    const invite: CdsWorkspaceInvite = {
      id: randomUUID().replace(/-/g, ''),
      workspaceId: input.workspaceId,
      githubLogin: input.githubLogin.toLowerCase(),
      token,
      role: input.role,
      invitedByUserId: input.invitedByUserId,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + input.ttlMs).toISOString(),
      acceptedAt: null,
    };
    await this.handle.invitesCollection().insertOne(invite);
    return invite;
  }

  async findWorkspaceInviteByToken(token: string, now = new Date()): Promise<CdsWorkspaceInvite | null> {
    const invite = await this.handle.invitesCollection().findOne({ token });
    if (!invite) return null;
    if (new Date(invite.expiresAt).getTime() <= now.getTime()) {
      await this.handle.invitesCollection().deleteOne({ token });
      return null;
    }
    return invite;
  }

  async acceptWorkspaceInvite(token: string, userId: string, now = new Date()): Promise<CdsWorkspaceMember | null> {
    const invite = await this.findWorkspaceInviteByToken(token, now);
    if (!invite || invite.acceptedAt !== null) return null;
    const updated: CdsWorkspaceInvite = { ...invite, acceptedAt: now.toISOString() };
    await this.handle.invitesCollection().replaceOne({ token }, updated);
    return this.addWorkspaceMember({
      workspaceId: invite.workspaceId,
      userId,
      role: invite.role,
      addedByUserId: invite.invitedByUserId,
      syncSource: 'manual',
    }, now);
  }

  async listWorkspaceInvites(workspaceId: string): Promise<CdsWorkspaceInvite[]> {
    return this.handle.invitesCollection().find({ workspaceId });
  }

  async deleteWorkspaceInvite(id: string): Promise<void> {
    await this.handle.invitesCollection().deleteOne({ id });
  }
}
