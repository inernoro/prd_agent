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
 * See doc/design.cds-multi-project.md section 七 and
 * doc/plan.cds-multi-project-phases.md P2.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import type {
  AuthStore,
} from '../infra/auth-store/memory-store.js';
import { DEFAULT_SESSION_TTL_MS } from '../infra/auth-store/memory-store.js';
import type { CdsSession, CdsUser, CdsWorkspace, UserActivityRecord } from '../domain/auth.js';
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
      | 'bootstrap_failed',
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
  private readonly github: GitHubOAuthClient;
  private readonly config: Required<Omit<AuthServiceConfig, 'allowedOrgs'>> & {
    allowedOrgs: string[];
  };
  private readonly stateStore = new StateStore();

  constructor(deps: {
    store: AuthStore;
    github: GitHubOAuthClient;
    config: AuthServiceConfig;
  }) {
    this.store = deps.store;
    this.github = deps.github;
    this.config = {
      allowedOrgs: deps.config.allowedOrgs,
      sessionTtlMs: deps.config.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS,
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
    const user = await this.store.upsertUser({
      githubId: profile.id,
      githubLogin: profile.login,
      email: profile.email,
      name: profile.name || profile.login,
      avatarUrl: profile.avatarUrl,
      orgs: orgLogins,
    }, now);

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
  }): Promise<CdsUser> {
    const username = String(input.username || '').trim().toLowerCase();
    if (!USERNAME_RE.test(username)) {
      throw new LocalAuthError('username_invalid', '用户名需为 3-32 位，仅含小写字母、数字、点、连字符或下划线');
    }
    if (typeof input.password !== 'string' || input.password.length < MIN_PASSWORD_LENGTH) {
      throw new LocalAuthError('password_too_short', `密码长度至少 ${MIN_PASSWORD_LENGTH} 位`);
    }
    const existing = await this.store.findUserByUsername(username);
    if (existing) {
      throw new LocalAuthError('username_taken', `用户名 ${username} 已存在`);
    }
    const { hash, salt } = hashPassword(input.password);
    return this.store.createLocalUser({
      username,
      passwordHash: hash,
      passwordSalt: salt,
      name: input.name,
      email: input.email ?? null,
      isSystemOwner: input.isSystemOwner ?? false,
    });
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
    if (await this.hasAnyUser()) {
      throw new LocalAuthError('username_taken', '系统已存在用户，首启引导不可用');
    }
    const user = await this.createLocalUser({ ...input, isSystemOwner: true });
    await this.ensurePersonalWorkspace(user).catch(() => { /* non-fatal: workspace is best-effort */ });
    return user;
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
    userId: string,
    meta: { userAgent: string | null; ipAddress: string | null },
    now = new Date(),
  ): Promise<CdsSession> {
    await this.store.touchUserLastLogin(userId, now);
    return this.store.createSession(
      {
        userId,
        ttlMs: this.config.sessionTtlMs,
        userAgent: meta.userAgent,
        ipAddress: meta.ipAddress,
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
    await this.store.updateUserPassword(userId, hash, salt);
    // Revoke all other sessions on password change to be safe.
    await this.store.deleteSessionsForUser(userId);
  }

  /** List all users (system-owner management view). Callers must redact secrets. */
  async listUsers(): Promise<CdsUser[]> {
    return this.store.listUsers();
  }

  /** Look up a single user by CDS id. */
  async findUserById(id: string): Promise<CdsUser | null> {
    return this.store.findUserById(id);
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
   */
  async validateSession(token: string | null): Promise<{
    session: CdsSession;
    user: CdsUser;
  } | null> {
    if (!token) return null;
    const session = await this.store.findSessionByToken(token);
    if (!session) return null;
    const user = await this.store.findUserById(session.userId);
    if (!user || user.status !== 'active') return null;
    return { session, user };
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
