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
} from '../../domain/auth.js';
import { ACTIVITY_RING_CAPACITY, localPlaceholderGithubId } from './memory-store.js';
import type { IAuthMongoHandle } from './mongo-handle.js';

export { IAuthMongoHandle };

export class MongoAuthStore implements AuthStore {
  constructor(private readonly handle: IAuthMongoHandle) {}

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
      passwordHash: input.passwordHash,
      passwordSalt: input.passwordSalt,
      email: input.email ?? null,
      name: input.name?.trim() || input.username,
      avatarUrl: null,
      orgs: [],
      orgsCheckedAt: now.toISOString(),
      isSystemOwner: input.isSystemOwner ?? false,
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
    const user = await users.findOne({ id });
    if (!user) return null;
    const updated: CdsUser = {
      ...user,
      passwordHash,
      passwordSalt,
      updatedAt: now.toISOString(),
    };
    await users.replaceOne({ id }, updated);
    return updated;
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
