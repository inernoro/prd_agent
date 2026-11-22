/**
 * Auth service — orchestrates GitHub OAuth login, first-login bootstrap,
 * and session validation for CDS v4.
 *
 * Responsibilities:
 *   1. Generate a CSRF-protected state token for /login initiation
 *   2. Handle the OAuth callback: exchange code → fetch profile + orgs →
 *      enforce allowedOrgs whitelist → upsert user → create session →
 *      trigger bootstrap on first login
 *   3. Validate session cookies on subsequent requests
 *   4. Refresh org membership lazily (every N minutes)
 *
 * This service is the single public entry point for everything auth.
 * Routes (cds/src/routes/auth.ts) and middleware
 * (cds/src/middleware/github-auth.ts) call it; tests use it directly.
 *
 * See doc/design.cds.multi-project.md section 七 and
 * doc/plan.cds.multi-project-phases.md P2.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type {
  AuthStore,
} from '../infra/auth-store/memory-store.js';
import { DEFAULT_SESSION_TTL_MS } from '../infra/auth-store/memory-store.js';
import type { AccountIdentityProvider, AccountInvitationProof, CdsSession, CdsUser, CdsWorkspace, CreateLocalUserInput, UserActivityRecord } from '../domain/auth.js';
import { GithubIdentityDetachedError } from '../domain/auth.js';
import type { AccountAction, AccountActionRequest, AccountActionStore, AccountSecurityChange } from '../domain/account-actions.js';
import { hashPassword, verifyPassword, MIN_PASSWORD_LENGTH } from './password.js';
import type {
  GitHubOAuthClient,
  GitHubProfile,
} from './github-oauth-client.js';
import { GitHubOAuthError } from './github-oauth-client.js';

/** Outcome of an OAuth callback, returned to the route layer. */
export interface LoginResult {
  session: CdsSession;
  user: CdsUser;
  /** True if this login triggered the system-owner bootstrap flow. */
  bootstrapped: boolean;
}

/** Errors produced by the auth service, carrying a stable machine code. */
export class AuthServiceError extends Error {
  constructor(
    public readonly code:
      | 'invalid_state'
      | 'state_mismatch'
      | 'org_not_allowed'
      | 'oauth_upstream'
      | 'oauth_disabled'
      | 'bootstrap_failed'
      | 'account_disabled'
      | 'identity_detached',
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'AuthServiceError';
  }
}

/** Errors produced by the local-credential paths, carrying a stable code. */
export class LocalAuthError extends Error {
  constructor(
    public readonly code:
      | 'username_taken'
      | 'username_invalid'
      | 'password_too_short'
      | 'invalid_credentials'
      | 'user_not_found'
      | 'account_changed'
      | 'not_local_account'
      | 'disabled',
    message: string,
  ) {
    super(message);
    this.name = 'LocalAuthError';
  }
}

/** Username must be 3-32 chars: lowercase letters, digits, hyphen, underscore, dot. */
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;

export interface AuthServiceConfig {
  /** Allowed GitHub org logins. Empty array means "allow any logged-in GitHub user". */
  allowedOrgs: string[];
  /** Session TTL override in milliseconds. Defaults to 30d. */
  sessionTtlMs?: number;
  /**
   * Sliding renewal threshold. A session whose remaining life has dropped below
   * this fraction of the TTL is pushed back out to a full TTL on the next
   * request — "keep using it and it never expires". Defaults to 0.5.
   */
  sessionRenewThreshold?: number;
  /** How long to trust a cached orgs snapshot before re-fetching. Defaults to 1h. */
  orgsRefreshMs?: number;
  /** Slug template for the first-login personal workspace. `{login}` is substituted. */
  personalWorkspaceSlugTemplate?: string;
}

/**
 * Small in-memory CSRF state store. A real mongo-backed implementation
 * would persist these across restarts; for P2 an in-process map is
 * sufficient because the state lives only seconds between /login and
 * /callback.
 */
class StateStore {
  private readonly store = new Map<string, { redirect: string; createdAt: number }>();
  private readonly ttlMs = 10 * 60 * 1000; // 10 minutes

  create(redirect: string): string {
    this.gc();
    const state = randomBytes(24).toString('base64url');
    this.store.set(state, { redirect, createdAt: Date.now() });
    return state;
  }

  consume(state: string): { redirect: string } | null {
    this.gc();
    const entry = this.store.get(state);
    if (!entry) return null;
    this.store.delete(state);
    return { redirect: entry.redirect };
  }

  private gc(): void {
    const now = Date.now();
    for (const [state, entry] of this.store.entries()) {
      if (now - entry.createdAt > this.ttlMs) {
        this.store.delete(state);
      }
    }
  }

  /** Visible for tests. */
  size(): number {
    return this.store.size;
  }
}

export class AuthService {
  private readonly store: AuthStore;
  private readonly github: GitHubOAuthClient | null;
  private readonly config: Required<Omit<AuthServiceConfig, 'allowedOrgs'>> & {
    allowedOrgs: string[];
  };
  private readonly stateStore = new StateStore();
  /**
   * 首启引导串行锁。两个并发 POST /api/auth/bootstrap 可能都先通过 hasAnyUser()
   * 再各自 createLocalUser → 铸出两个 system owner（PR #865 Codex P2）。CDS master
   * 是单实例单进程，把"检查空库 + 插入"串到这条链上即可彻底关闭竞态窗口。
   */
  private bootstrapChain: Promise<void> = Promise.resolve();

  constructor(deps: {
    store: AuthStore;
    github?: GitHubOAuthClient | null;
    config: AuthServiceConfig;
  }) {
    this.store = deps.store;
    this.github = deps.github ?? null;
    this.config = {
      allowedOrgs: deps.config.allowedOrgs,
      sessionTtlMs: deps.config.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS,
      sessionRenewThreshold:
        deps.config.sessionRenewThreshold !== undefined
          && deps.config.sessionRenewThreshold > 0
          && deps.config.sessionRenewThreshold < 1
          ? deps.config.sessionRenewThreshold
          : 0.5,
      orgsRefreshMs: deps.config.orgsRefreshMs ?? 60 * 60 * 1000,
      personalWorkspaceSlugTemplate:
        deps.config.personalWorkspaceSlugTemplate ?? '{login}-personal',
    };
  }

  /**
   * Step 1 of the login flow: return the URL the user should be sent to,
   * and store a CSRF state token we'll verify on callback.
   */
  startLogin(redirectUri: string, postLoginRedirect: string): { authorizeUrl: string; state: string } {
    if (!this.github) {
      throw new AuthServiceError('oauth_disabled', 'GitHub OAuth is not enabled for this CDS instance');
    }
    const state = this.stateStore.create(postLoginRedirect);
    const authorizeUrl = this.github.buildAuthorizeUrl(state, redirectUri);
    return { authorizeUrl, state };
  }

  /**
   * Step 2: handle the /callback?code=...&state=... hit from GitHub.
   * Throws AuthServiceError on any failure; the route layer maps the
   * error code to a user-visible page.
   */
  async handleCallback(params: {
    code: string;
    state: string;
    redirectUri: string;
    userAgent: string | null;
    ipAddress: string | null;
  }): Promise<LoginResult & { redirect: string }> {
    if (!this.github) {
      throw new AuthServiceError('oauth_disabled', 'GitHub OAuth is not enabled for this CDS instance');
    }
    const stateEntry = this.stateStore.consume(params.state);
    if (!stateEntry) {
      throw new AuthServiceError('state_mismatch', 'OAuth state token is missing or already consumed');
    }

    let accessToken: string;
    let profile: GitHubProfile;
    let orgs: { login: string }[];
    try {
      accessToken = await this.github.exchangeCodeForToken(params.code, params.redirectUri);
      profile = await this.github.fetchProfile(accessToken);
      orgs = await this.github.fetchOrgs(accessToken);
    } catch (err) {
      if (err instanceof GitHubOAuthError) {
        throw new AuthServiceError('oauth_upstream', err.message, err);
      }
      throw err;
    }

    const orgLogins = orgs.map((o) => o.login);
    if (!this.isOrgAllowed(orgLogins)) {
      throw new AuthServiceError(
        'org_not_allowed',
        `User ${profile.login} is not a member of any allowed org. Allowed: ${this.config.allowedOrgs.join(', ') || '(none configured)'}`,
      );
    }

    const now = new Date();
    let user: CdsUser;
    try {
      user = await this.store.upsertUser({
        githubId: profile.id,
        githubLogin: profile.login,
        email: profile.email,
        name: profile.name || profile.login,
        avatarUrl: profile.avatarUrl,
        orgs: orgLogins,
      }, now);
    } catch (err) {
      if (err instanceof GithubIdentityDetachedError) {
        throw new AuthServiceError('identity_detached', '使用另一种方式登录 CDS 后重新绑定 GitHub');
      }
      throw err;
    }

    // 被 owner 禁用的账号不得再通过 GitHub OAuth 登录——upsert 只同步资料，禁用
    // 状态要在发会话前拦掉，否则禁用形同虚设、且会签出一个下次 validateSession 即失效
    // 的孤儿会话（修复 PR #865 Bugbot High「OAuth login ignores disabled status」）。
    if (user.status === 'disabled') {
      throw new AuthServiceError('account_disabled', `账号 ${profile.login} 已被禁用，无法登录`);
    }

    await this.store.touchUserLastLogin(user.id, now);

    // First-login bootstrap: if this is the first user ever, they become
    // the system owner and get a personal workspace.
    let bootstrapped = false;
    const userCount = await this.store.countUsers();
    if (userCount === 1 && !user.isSystemOwner) {
      await this.bootstrapSystemOwner(user);
      bootstrapped = true;
    } else {
      // Otherwise still ensure they have a personal workspace.
      await this.ensurePersonalWorkspace(user);
    }

    const session = await this.store.createSession(
      {
        userId: user.id,
        sessionRevision: user.sessionRevision,
        ttlMs: this.config.sessionTtlMs,
        userAgent: params.userAgent,
        ipAddress: params.ipAddress,
      },
      now,
    );

    // Re-fetch the user because bootstrap may have flipped isSystemOwner
    // and we want to return the canonical state.
    const finalUser = (await this.store.findUserById(user.id)) || user;

    await this.recordActivity({
      userId: finalUser.id,
      userLogin: finalUser.githubLogin,
      action: 'login',
      summary: `GitHub 登录${bootstrapped ? '（首次，已设为系统所有者）' : ''}`,
      ip: params.ipAddress,
    }, now);

    return {
      user: finalUser,
      session,
      bootstrapped,
      redirect: stateEntry.redirect,
    };
  }

  // ── Local username + password (coexists with GitHub OAuth) ──────────────

  /**
   * Whether any user exists at all. Used to gate the first-run bootstrap of
   * the initial local system-owner account.
   */
  async hasAnyUser(): Promise<boolean> {
    return (await this.store.countUsers()) > 0;
  }

  /**
   * Provision a local username + password account. Hashes the password before
   * it reaches the store. `isSystemOwner` is honored only by trusted callers
   * (route layer enforces who may set it).
   */
  async createLocalUser(input: {
    username: string;
    password: string;
    name?: string;
    email?: string | null;
    isSystemOwner?: boolean;
    isAdministrator?: boolean;
    externalLoginAllowed?: boolean;
  }): Promise<CdsUser> {
    if (typeof input.password !== 'string' || input.password.length < MIN_PASSWORD_LENGTH) {
      throw new LocalAuthError('password_too_short', `密码长度至少 ${MIN_PASSWORD_LENGTH} 位`);
    }
    const { hash, salt } = hashPassword(input.password);
    return this.provisionAccount({
      username: input.username,
      passwordHash: hash,
      passwordSalt: salt,
      name: input.name,
      email: input.email ?? null,
      isSystemOwner: input.isSystemOwner ?? false,
      isAdministrator: input.isAdministrator === true && !input.isSystemOwner,
      externalLoginAllowed: input.externalLoginAllowed === true,
    });
  }

  private async provisionAccount(input: CreateLocalUserInput): Promise<CdsUser> {
    const username = String(input.username || '').trim().toLowerCase();
    if (!USERNAME_RE.test(username)) {
      throw new LocalAuthError('username_invalid', '用户名需为 3-32 位，仅含小写字母、数字、点、连字符或下划线');
    }
    if (await this.store.findUserByUsername(username)) throw new LocalAuthError('username_taken', `用户名 ${username} 已存在`);
    try { return await this.store.createLocalUser({ ...input, username }); }
    catch (error) {
      if (await this.store.findUserByUsername(username)) throw new LocalAuthError('username_taken', `用户名 ${username} 已存在`);
      throw error;
    }
  }

  async createAccountInvitation(input: Pick<CreateLocalUserInput, 'username' | 'name' | 'isAdministrator' | 'externalLoginAllowed'>) {
    const invitation = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString();
    const user = await this.provisionAccount({
      ...input, invitationHash: createHash('sha256').update(invitation).digest('hex'), invitationExpiresAt: expiresAt,
    });
    return { user, invitation, expiresAt };
  }

  async findAccountInvitation(invitation: unknown): Promise<CdsUser | null> {
    if (typeof invitation !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(invitation)) return null;
    return this.store.findAccountInvitation(createHash('sha256').update(invitation).digest('hex'), new Date());
  }

  async acceptAccountInvitation(user: CdsUser, proof: AccountInvitationProof | string): Promise<CdsUser | null> {
    let verified: AccountInvitationProof;
    if (typeof proof === 'string') {
      if (proof.length < MIN_PASSWORD_LENGTH || proof.length > 512 || /[\u0000\r\n]/.test(proof)) {
        throw new LocalAuthError('password_too_short', `口令需为 ${MIN_PASSWORD_LENGTH}–512 位且不含换行`);
      }
      const { hash, salt } = hashPassword(proof);
      verified = { passwordHash: hash, passwordSalt: salt };
    } else verified = proof;
    const now = new Date();
    const recovery = user.invitationForRecovery
      ? this.sessionRevocation(user, randomUUID(), 'recover-identity', now) : undefined;
    return this.store.consumeAccountInvitation(user, verified, now, recovery);
  }

  async findAccountByUsername(username: string): Promise<CdsUser | null> {
    return this.store.findUserByUsername(username.trim().toLowerCase());
  }

  async issueRecoveryInvitation(user: CdsUser) {
    const now = new Date();
    const invitation = randomBytes(32).toString('base64url');
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60_000).toISOString();
    const saved = await this.store.applyAccountSecurityChange(user, {
      invitationHash: createHash('sha256').update(invitation).digest('hex'),
      invitationExpiresAt: expiresAt, invitationForRecovery: true,
    }, now);
    return saved ? { path: `/login#invite=${invitation}`, expiresAt } : null;
  }

  /**
   * First-run bootstrap: when there are zero users, create the first local
   * account and mark it system owner + give it a personal workspace. Refuses
   * to run once any user exists so this can't be used to mint a second owner.
   */
  async bootstrapFirstLocalUser(input: {
    username: string;
    password: string;
    name?: string;
  }): Promise<CdsUser> {
    // 串到 bootstrapChain 上：上一次引导（成功或失败）彻底结束后才执行本次的
    // "检查空库 + 插入"，避免并发请求都看到空库各自铸 owner（见 bootstrapChain 注释）。
    const prev = this.bootstrapChain;
    let release!: () => void;
    this.bootstrapChain = new Promise<void>((resolve) => { release = resolve; });
    try {
      await prev.catch(() => { /* 上一次失败不应阻断本次重试 */ });
      if (await this.hasAnyUser()) {
        throw new LocalAuthError('username_taken', '系统已存在用户，首启引导不可用');
      }
      const user = await this.createLocalUser({ ...input, isSystemOwner: true });
      await this.ensurePersonalWorkspace(user).catch(() => { /* non-fatal: workspace is best-effort */ });
      return user;
    } finally {
      release();
    }
  }

  /**
   * Verify a local login. Constant-time on the password compare. Returns the
   * user on success or null on any failure (unknown username, wrong password,
   * not a local account, disabled). Callers must NOT distinguish the failure
   * reasons to the client.
   */
  async verifyLocalLogin(username: string, password: string): Promise<CdsUser | null> {
    const handle = String(username || '').trim().toLowerCase();
    const user = await this.store.findUserByUsername(handle);
    // Always run a hash even when the user is missing, to reduce timing signal
    // on username existence.
    const hash = user?.passwordHash ?? '0'.repeat(128);
    const salt = user?.passwordSalt ?? '0'.repeat(32);
    const ok = verifyPassword(password, { hash, salt });
    if (!user || !ok) return null;
    if (user.status !== 'active') return null;
    if ((user.authProvider ?? 'github') !== 'local') return null;
    return user;
  }

  /**
   * Create a session for an already-verified user (local login path mirrors
   * the OAuth callback's session creation + lastLogin touch).
   */
  async createSessionForUser(
    identity: string | CdsUser,
    meta: { userAgent: string | null; ipAddress: string | null; passkeyAuthenticated?: true },
    now = new Date(),
  ): Promise<CdsSession> {
    const user = typeof identity === 'string' ? await this.store.findUserById(identity) : identity;
    if (!user || user.status !== 'active') throw new LocalAuthError('disabled', '账号不可用');
    await this.store.touchUserLastLogin(user.id, now);
    return this.store.createSession(
      {
        userId: user.id,
        sessionRevision: user.sessionRevision,
        ttlMs: this.config.sessionTtlMs,
        userAgent: meta.userAgent,
        ipAddress: meta.ipAddress,
        ...(meta.passkeyAuthenticated ? { passkeyAuthenticated: true } : {}),
      },
      now,
    );
  }

  /**
   * Change a user's password. The old password is verified first. When
   * `allowWithoutOld` is true (admin reset by a system owner), the old-password
   * check is skipped — the route layer is responsible for authorizing that.
   */
  async changePassword(
    userId: string,
    oldPassword: string,
    newPassword: string,
    allowWithoutOld = false,
  ): Promise<void> {
    const user = await this.store.findUserById(userId);
    if (!user) throw new LocalAuthError('user_not_found', '用户不存在');
    if ((user.authProvider ?? 'github') !== 'local' || !user.passwordHash || !user.passwordSalt) {
      throw new LocalAuthError('not_local_account', '该账号非本地账号，无法修改密码');
    }
    if (typeof newPassword !== 'string' || newPassword.length < MIN_PASSWORD_LENGTH) {
      throw new LocalAuthError('password_too_short', `新密码长度至少 ${MIN_PASSWORD_LENGTH} 位`);
    }
    if (!allowWithoutOld) {
      const ok = verifyPassword(oldPassword, { hash: user.passwordHash, salt: user.passwordSalt });
      if (!ok) throw new LocalAuthError('invalid_credentials', '原密码不正确');
    }
    const { hash, salt } = hashPassword(newPassword);
    if (!this.store.accountActions) {
      await this.store.updateUserPassword(userId, hash, salt);
      await this.store.deleteSessionsForUser(userId);
      return;
    }
    const at = new Date();
    const id = randomUUID();
    const changed = await this.store.applyAccountSecurityChange(user, {
      ...this.sessionRevocation(user, id, 'reset-password', at), passwordHash: hash, passwordSalt: salt,
    }, at);
    if (!changed) throw new LocalAuthError('account_changed', '账号状态已改变，请重新登录后再试');
  }

  /** List all users (system-owner management view). Callers must redact secrets. */
  async listUsers(): Promise<CdsUser[]> {
    return this.store.listUsers();
  }

  /** Look up a single user by CDS id. */
  async findUserById(id: string): Promise<CdsUser | null> {
    return this.store.findUserById(id);
  }

  async setUserAdministrator(id: string, isAdministrator: boolean): Promise<CdsUser | null> {
    return this.store.setUserAdministrator(id, isAdministrator);
  }

  async setExternalLoginAllowed(user: CdsUser, allowed: boolean): Promise<CdsUser | null> {
    return this.store.setExternalLoginAllowed(user, allowed);
  }

  async findUserByExternalIdentity(provider: AccountIdentityProvider, subject: string): Promise<CdsUser | null> {
    return provider === 'github' ? this.store.findUserByGithubId(Number(subject)) : this.store.findUserByGoogleSubject(subject);
  }

  async linkIdentity(user: CdsUser, provider: AccountIdentityProvider, subject: string, label: string) {
    return this.store.linkIdentity(user, provider, subject, label);
  }

  async detachIdentity(user: CdsUser, provider: AccountIdentityProvider, receipt: string = randomUUID()): Promise<CdsUser | null> {
    const now = new Date();
    const change = this.sessionRevocation(user, receipt, provider === 'github' ? 'unlink-github' : 'unlink-google', now);
    if (!await this.store.detachIdentity(user, provider, change, now)) return null;
    return this.store.findUserById(user.id);
  }

  get accountActions(): AccountActionStore | undefined {
    return this.store.accountActions;
  }

  async countAccountSessions(user: CdsUser): Promise<number> {
    return this.store.countAccountSessions(user, new Date());
  }

  /** Track a verified shared system browser with a separate, non-login proof. */
  async rememberSystemBrowser(userId: string, revision: string | undefined, proof: string | undefined, meta: {
    userAgent: string | null; ipAddress: string | null;
  }): Promise<CdsSession> {
    const prior = proof ? await this.store.findSessionByToken(proof) : null;
    if (prior && prior.userId === userId && prior.sessionRevision === revision) {
      return (await this.renewIfNeeded(prior)) ?? prior;
    }
    return this.store.createSession({ userId, sessionRevision: revision, ttlMs: this.config.sessionTtlMs, ...meta });
  }

  async systemBrowserSessions(userId: string, revision?: string): Promise<Array<{
    device: string; location: string | null; createdAt: string; lastSeenAt: string;
  }>> {
    const sessions = await this.store.listAccountSessions(userId, revision, new Date());
    return sessions.map(browserSessionView);
  }

  async personalBrowserSessions(user: CdsUser, currentToken: string | null) {
    const sessions = await this.store.listAccountSessions(user.id, user.sessionRevision, new Date());
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString();
    return {
      sessions: sessions.map(session => ({ ...browserSessionView(session), current: session.token === currentToken })),
      revocations: (user.sessionRevocationNotices ?? []).filter(notice => notice.at >= cutoff)
        .map(({ action, at }) => ({ action, at })).reverse(),
    };
  }

  async systemSignInNotice(userId: string, revision: string | undefined, proof: string | undefined) {
    if (!proof || !this.store.accountActions) return null;
    const browser = await this.store.findSessionByToken(proof);
    if (!browser || browser.userId !== userId || browser.sessionRevision === revision) return null;
    const records = await this.store.accountActions.list({ targetId: userId, action: 'rotate-system-password' }, 100);
    const event = records.find(item => item.status === 'completed' && (item.targetRevision || undefined) === browser.sessionRevision);
    return event?.decidedAt ? { action: event.action, at: event.decidedAt, receiptId: event.id } : null;
  }

  async applyAccountAction(user: CdsUser, request: AccountActionRequest, newPassword?: string): Promise<boolean> {
    const now = new Date();
    if (request.action === 'unlink-github' || request.action === 'unlink-google') {
      return Boolean(await this.detachIdentity(user, request.action === 'unlink-github' ? 'github' : 'google', request.id));
    }
    const change = this.sessionRevocation(user, request.id, request.action, now);
    if (request.action === 'disable-user') change.status = 'disabled';
    if (request.action === 'revoke-admin') change.isAdministrator = false;
    if (request.action === 'reset-password') {
      if (!newPassword || newPassword.length < MIN_PASSWORD_LENGTH) {
        throw new LocalAuthError('password_too_short', `新口令至少 ${MIN_PASSWORD_LENGTH} 位`);
      }
      const { hash, salt } = hashPassword(newPassword);
      change.passwordHash = hash;
      change.passwordSalt = salt;
    }
    return this.store.applyAccountSecurityChange(user, change, now);
  }

  private sessionRevocation(user: CdsUser, id: string, action: AccountAction, now: Date): AccountSecurityChange {
    const at = now.toISOString();
    const cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60_000).toISOString();
    const recent = (user.sessionRevocationNotices ?? []).filter(notice => notice.at >= cutoff).slice(-39);
    return {
      sessionRevision: id, lastAccountAction: { id, action, at },
      sessionRevocationNotices: [...recent, { previousRevision: user.sessionRevision ?? null, action, at }],
    };
  }

  async signInNotice(token: string | null): Promise<{ action: AccountAction; at: string } | null> {
    if (!token) return null;
    const session = await this.store.findSessionByToken(token);
    if (!session) return null;
    const user = await this.store.findUserById(session.userId);
    if (!user || session.sessionRevision === user.sessionRevision) return null;
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString();
    const notice = user.sessionRevocationNotices?.find(note => note.previousRevision === (session.sessionRevision ?? null) && note.at >= cutoff);
    return notice ? { action: notice.action, at: notice.at } : null;
  }

  /** Enable/disable an account; disabling also revokes its sessions. */
  async setUserStatus(userId: string, status: CdsUser['status']): Promise<CdsUser | null> {
    const user = await this.store.setUserStatus(userId, status);
    if (user && status === 'disabled') {
      await this.store.deleteSessionsForUser(userId);
    }
    return user;
  }

  // ── User activity / trace log ────────────────────────────────────────────

  /**
   * Record a single user-activity entry. Best-effort: failures are swallowed
   * (logged) so a tracing write can never break the action it describes.
   */
  async recordActivity(input: {
    userId: string;
    userLogin: string;
    action: string;
    summary: string;
    targetType?: string | null;
    targetId?: string | null;
    ip?: string | null;
  }, now = new Date()): Promise<void> {
    try {
      const record: UserActivityRecord = {
        id: randomUUID().replace(/-/g, ''),
        userId: input.userId,
        userLogin: input.userLogin,
        action: input.action,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
        summary: input.summary,
        ip: input.ip ?? null,
        at: now.toISOString(),
      };
      await this.store.recordActivity(record);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[auth] recordActivity failed:', (err as Error).message);
    }
  }

  /** Query activity, newest-first. Filter by user id when provided. */
  async listActivity(opts?: { userId?: string; limit?: number }): Promise<UserActivityRecord[]> {
    return this.store.listActivity(opts);
  }

  /**
   * Validate a session token from the cookie. Returns null if the token
   * is missing/expired/unknown. Callers should treat null as "redirect
   * to /login".
   *
   * `renewed` is true when this call slid the session's expiry forward — the
   * caller MUST then re-issue the cookie, otherwise the server-side session is
   * extended while the browser copy still dies at the old deadline (and the
   * fresh server expiry stops any later caller from renewing again).
   *
   * Callers that cannot set a cookie (e.g. logout, which is about to delete the
   * session anyway) must pass `{ renew: false }` instead of silently dropping
   * the flag.
   */
  async validateSession(
    token: string | null,
    options: { renew?: boolean } = {},
  ): Promise<{
    session: CdsSession;
    user: CdsUser;
    renewed: boolean;
  } | null> {
    if (!token) return null;
    const session = await this.store.findSessionByToken(token);
    if (!session) return null;
    const user = await this.store.findUserById(session.userId);
    if (!user || user.status !== 'active' || session.sessionRevision !== user.sessionRevision) return null;

    // Sliding renewal: an in-use session never runs out. Only refresh once the
    // remaining life has dropped below the threshold so we don't write on every
    // single request.
    const renewed = options.renew === false ? null : await this.renewIfNeeded(session);
    return { session: renewed ?? session, user, renewed: renewed !== null };
  }

  /**
   * Push a session's expiry back to a full TTL when it has burned through more
   * than (1 - threshold) of its life. Returns the extended session, or null when
   * no renewal happened (still fresh, or the store write failed — a failed
   * renewal must never invalidate an otherwise valid session).
   */
  private async renewIfNeeded(session: CdsSession, now = new Date()): Promise<CdsSession | null> {
    const ttlMs = this.config.sessionTtlMs;
    const remainingMs = new Date(session.expiresAt).getTime() - now.getTime();
    if (!Number.isFinite(remainingMs)) return null;
    if (remainingMs > ttlMs * this.config.sessionRenewThreshold) return null;
    try {
      return await this.store.extendSession(session.token, ttlMs, now);
    } catch {
      return null;
    }
  }

  /** Destroy a single session. Used by /logout. */
  async logout(token: string): Promise<void> {
    await this.store.deleteSession(token);
  }

  /** Revoke all sessions for a user. Used on account disable. */
  async logoutAllForUser(userId: string): Promise<number> {
    return this.store.deleteSessionsForUser(userId);
  }

  private isOrgAllowed(orgLogins: string[]): boolean {
    if (this.config.allowedOrgs.length === 0) {
      // Empty allowlist means "any successful GitHub login is fine".
      // This is intended for single-user dev environments; production
      // deployments must set CDS_ALLOWED_ORGS.
      return true;
    }
    const allowed = new Set(this.config.allowedOrgs.map((s) => s.toLowerCase()));
    return orgLogins.some((o) => allowed.has(o.toLowerCase()));
  }

  private async bootstrapSystemOwner(user: CdsUser): Promise<CdsWorkspace> {
    // The memory store has a side-channel for flipping isSystemOwner.
    // A mongo-backed store will expose the same mutator.
    if ('markUserAsSystemOwner' in this.store) {
      await (this.store as any).markUserAsSystemOwner(user.id);
    }
    return this.ensurePersonalWorkspace(user);
  }

  private async ensurePersonalWorkspace(user: CdsUser): Promise<CdsWorkspace> {
    const slug = this.config.personalWorkspaceSlugTemplate.replace('{login}', user.githubLogin.toLowerCase());
    const existing = await this.store.findWorkspaceBySlug(slug);
    if (existing) return existing;
    try {
      return await this.store.createWorkspace({
        slug,
        name: `${user.githubLogin} 的个人空间`,
        kind: 'personal',
        ownerId: user.id,
        description: null,
      });
    } catch (err) {
      throw new AuthServiceError('bootstrap_failed', `Failed to create personal workspace '${slug}'`, err);
    }
  }

  /** Visible for tests. */
  _stateStoreSize(): number {
    return this.stateStore.size();
  }
}

function browserSessionView(session: CdsSession) {
  const agent = session.userAgent || '';
  const device = /Windows/i.test(agent) ? 'Windows' : /iPhone|iPad/i.test(agent) ? 'iOS'
    : /Android/i.test(agent) ? 'Android' : /Macintosh/i.test(agent) ? 'macOS' : /Linux/i.test(agent) ? 'Linux' : '未知设备';
  return { device, location: session.ipAddress, createdAt: session.createdAt, lastSeenAt: session.lastSeenAt };
}
