/**
 * GitHub OAuth HTTP client.
 *
 * Wraps the three GitHub endpoints CDS needs during the OAuth flow:
 *   1. POST https://github.com/login/oauth/access_token  (code → access_token)
 *   2. GET  https://api.github.com/user                   (profile)
 *   3. GET  https://api.github.com/user/orgs              (org membership)
 *
 * The client is a thin, injectable wrapper around `globalThis.fetch` so
 * unit tests can pass a stub fetch without touching the network. Errors
 * bubble up as structured objects rather than HTTP exceptions so the
 * auth-service can map them to user-visible messages.
 *
 * See doc/design.cds-multi-project.md section 七 and
 * doc/plan.cds-multi-project-phases.md P2.
 */

export interface GitHubProfile {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
}

export interface GitHubOrgRef {
  id: number;
  login: string;
}

export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  json(): Promise<any>;
  text(): Promise<string>;
  // FU-01: optional response headers accessor. Not all test mocks
  // implement this, so the pagination path degrades gracefully if
  // `headers` is undefined.
  headers?: { get(name: string): string | null };
}>;

export interface GitHubOAuthClientOptions {
  clientId: string;
  clientSecret: string;
  /** Optional HTTP client override for tests. Defaults to globalThis.fetch. */
  fetchImpl?: FetchLike;
  /** Override for tests; defaults to https://github.com. */
  oauthBaseUrl?: string;
  /** Override for tests; defaults to https://api.github.com. */
  apiBaseUrl?: string;
}

export class GitHubOAuthError extends Error {
  constructor(
    public readonly code:
      | 'token_exchange_failed'
      | 'profile_fetch_failed'
      | 'orgs_fetch_failed'
      | 'network_error'
      | 'device_code_failed'
      | 'device_poll_pending'
      | 'device_poll_slow_down'
      | 'device_poll_expired'
      | 'device_poll_denied'
      | 'repos_fetch_failed',
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'GitHubOAuthError';
  }
}

/**
 * P4 Part 18 (Phase E): Device Flow initiation payload returned by
 * GitHub's /login/device/code endpoint. Passed to the frontend so
 * the user can type the `userCode` at `verificationUri` in their
 * browser.
 */
export interface DeviceFlowInit {
  /** Opaque device code the client polls with — never shown to user. */
  deviceCode: string;
  /** Short code the user types on github.com/login/device. */
  userCode: string;
  /** URL the user opens in their browser. */
  verificationUri: string;
  /** Seconds until deviceCode expires (usually 900). */
  expiresIn: number;
  /** Minimum seconds between polls (usually 5). */
  interval: number;
}

/**
 * P4 Part 18 (Phase E): single GitHub repository record used by the
 * repo-picker UI. We expose only the fields the picker renders and
 * the clone URL — callers can fetch more via `raw` if needed but
 * nothing else in CDS consumes this shape.
 */
export interface GitHubRepo {
  id: number;
  name: string;
  fullName: string;
  description: string | null;
  isPrivate: boolean;
  cloneUrl: string;
  sshUrl: string;
  defaultBranch: string;
  updatedAt: string | null;
  stargazersCount: number;
  language: string | null;
}

export class GitHubOAuthClient {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly fetchImpl: FetchLike;
  private readonly oauthBaseUrl: string;
  private readonly apiBaseUrl: string;

  constructor(options: GitHubOAuthClientOptions) {
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.fetchImpl = options.fetchImpl ?? ((globalThis as any).fetch as FetchLike);
    this.oauthBaseUrl = options.oauthBaseUrl ?? 'https://github.com';
    this.apiBaseUrl = options.apiBaseUrl ?? 'https://api.github.com';

    if (!this.fetchImpl) {
      throw new Error('GitHubOAuthClient requires a fetch implementation (pass fetchImpl or run on Node 18+)');
    }
  }

  /**
   * Build the GitHub OAuth authorization URL. The caller should 302 the
   * browser to this URL after generating and storing a CSRF state token.
   */
  buildAuthorizeUrl(state: string, redirectUri: string): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: redirectUri,
      scope: 'read:user user:email read:org',
      state,
      // Always force the consent screen when the set of requested scopes
      // changes across versions. Helps during P2→P5 when we add scopes.
      allow_signup: 'false',
    });
    return `${this.oauthBaseUrl}/login/oauth/authorize?${params.toString()}`;
  }

  /**
   * Exchange an OAuth authorization code for an access token. Returns
   * the raw access_token string — GitHub tokens have no refresh leg so
   * callers just keep it for the duration of the current request and
   * discard it.
   */
  async exchangeCodeForToken(code: string, redirectUri: string): Promise<string> {
    let response;
    try {
      response = await this.fetchImpl(`${this.oauthBaseUrl}/login/oauth/access_token`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          client_id: this.clientId,
          client_secret: this.clientSecret,
          code,
          redirect_uri: redirectUri,
        }),
      });
    } catch (err) {
      throw new GitHubOAuthError('network_error', 'Failed to reach GitHub during token exchange', err);
    }

    if (!response.ok) {
      throw new GitHubOAuthError(
        'token_exchange_failed',
        `GitHub token exchange returned HTTP ${response.status} ${response.statusText}`,
      );
    }

    const body = await response.json().catch(() => ({}));
    if (body.error) {
      throw new GitHubOAuthError(
        'token_exchange_failed',
        `GitHub rejected OAuth code: ${body.error} — ${body.error_description ?? 'no description'}`,
      );
    }
    if (!body.access_token || typeof body.access_token !== 'string') {
      throw new GitHubOAuthError(
        'token_exchange_failed',
        'GitHub response missing access_token field',
      );
    }
    return body.access_token as string;
  }

  /** Fetch /user — the authenticated user's profile. */
  async fetchProfile(accessToken: string): Promise<GitHubProfile> {
    let response;
    try {
      response = await this.fetchImpl(`${this.apiBaseUrl}/user`, {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${accessToken}`,
          'User-Agent': 'cds-oauth-client',
        },
      });
    } catch (err) {
      throw new GitHubOAuthError('network_error', 'Failed to reach GitHub /user', err);
    }

    if (!response.ok) {
      throw new GitHubOAuthError(
        'profile_fetch_failed',
        `GitHub /user returned HTTP ${response.status}`,
      );
    }

    const body = await response.json();
    return {
      id: body.id,
      login: body.login,
      name: body.name ?? null,
      email: body.email ?? null,
      avatarUrl: body.avatar_url ?? null,
    };
  }

  /**
   * Fetch /user/orgs — the list of organisations the user belongs to.
   * Note: only public memberships are returned unless the `read:org`
   * scope was granted during authorization. We always request that
   * scope (see buildAuthorizeUrl) but users can still deny it.
   */
  async fetchOrgs(accessToken: string): Promise<GitHubOrgRef[]> {
    let response;
    try {
      response = await this.fetchImpl(`${this.apiBaseUrl}/user/orgs`, {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${accessToken}`,
          'User-Agent': 'cds-oauth-client',
        },
      });
    } catch (err) {
      throw new GitHubOAuthError('network_error', 'Failed to reach GitHub /user/orgs', err);
    }

    if (!response.ok) {
      throw new GitHubOAuthError(
        'orgs_fetch_failed',
        `GitHub /user/orgs returned HTTP ${response.status}`,
      );
    }

    const body = await response.json();
    if (!Array.isArray(body)) {
      throw new GitHubOAuthError('orgs_fetch_failed', 'GitHub /user/orgs did not return an array');
    }
    return body.map((o) => ({ id: o.id, login: o.login }));
  }

  // ──────────────────────────────────────────────────────────────
  // P4 Part 18 (Phase E): GitHub Device Flow.
  //
  // Device flow is GitHub's authentication mechanism for apps that
  // don't have a browser callback URL (CLI tools, remote servers).
  // Users type a short code at github.com/login/device and we poll
  // for the access_token. It's orthogonal to the existing web flow
  // used by the CDS login path — they share a client_id but don't
  // require the client_secret (device flow is public-client only).
  //
  // Contract:
  //   1. startDeviceFlow(scope) → { deviceCode, userCode, verificationUri, ... }
  //   2. Show userCode + verificationUri to the user
  //   3. Loop pollDeviceFlow(deviceCode) every `interval` seconds
  //      until it returns a token or fatal error
  //   4. fetchUserRepos(token) to list repos once authorized
  //
  // NOTE: Device Flow must be explicitly enabled for the GitHub
  // OAuth App (Settings → OAuth Apps → Enable Device Flow).
  // ──────────────────────────────────────────────────────────────

  /**
   * Step 1: initiate device flow. Scope defaults to 'repo' so the
   * returned token can list + clone both public and private repos.
   * Returns the polling payload which the caller passes back to
   * pollDeviceFlow on each tick.
   */
  async startDeviceFlow(scope: string = 'repo read:user'): Promise<DeviceFlowInit> {
    let response;
    try {
      response = await this.fetchImpl(`${this.oauthBaseUrl}/login/device/code`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          client_id: this.clientId,
          scope,
        }),
      });
    } catch (err) {
      throw new GitHubOAuthError('network_error', 'Failed to reach GitHub /login/device/code', err);
    }
    if (!response.ok) {
      throw new GitHubOAuthError(
        'device_code_failed',
        `GitHub /login/device/code returned HTTP ${response.status}`,
      );
    }
    const body = await response.json().catch(() => ({}));
    if (body.error) {
      throw new GitHubOAuthError(
        'device_code_failed',
        `GitHub rejected device_code request: ${body.error} — ${body.error_description ?? 'no description'}`,
      );
    }
    if (!body.device_code || !body.user_code) {
      throw new GitHubOAuthError(
        'device_code_failed',
        'GitHub response missing device_code / user_code — is Device Flow enabled for this OAuth App?',
      );
    }
    return {
      deviceCode: body.device_code,
      userCode: body.user_code,
      verificationUri: body.verification_uri || body.verification_uri_complete || 'https://github.com/login/device',
      expiresIn: body.expires_in || 900,
      interval: body.interval || 5,
    };
  }

  /**
   * Step 2: poll for the access token.
   *
   * GitHub responds with:
   *   - `access_token` when the user has authorized → return it
   *   - error=authorization_pending → GitHubOAuthError('device_poll_pending')
   *   - error=slow_down             → GitHubOAuthError('device_poll_slow_down') + caller backs off
   *   - error=expired_token         → GitHubOAuthError('device_poll_expired')
   *   - error=access_denied         → GitHubOAuthError('device_poll_denied')
   *
   * The distinct error codes let the caller know whether to keep
   * polling or give up.
   */
  async pollDeviceFlow(deviceCode: string): Promise<string> {
    let response;
    try {
      response = await this.fetchImpl(`${this.oauthBaseUrl}/login/oauth/access_token`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          client_id: this.clientId,
          device_code: deviceCode,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
      });
    } catch (err) {
      throw new GitHubOAuthError('network_error', 'Failed to reach GitHub /login/oauth/access_token', err);
    }
    // GitHub returns HTTP 200 even on "pending" errors; the distinction
    // is in the JSON body's `error` field.
    const body = await response.json().catch(() => ({}));
    if (body.access_token) return body.access_token as string;

    switch (body.error) {
      case 'authorization_pending':
        throw new GitHubOAuthError('device_poll_pending', '等待用户在 GitHub 完成授权…');
      case 'slow_down':
        throw new GitHubOAuthError('device_poll_slow_down', '轮询过快，已自动放慢');
      case 'expired_token':
        throw new GitHubOAuthError('device_poll_expired', '设备代码已过期，请重新发起');
      case 'access_denied':
        throw new GitHubOAuthError('device_poll_denied', '用户拒绝了授权请求');
      default:
        throw new GitHubOAuthError(
          'token_exchange_failed',
          `未知的 device flow 错误: ${body.error || response.status}`,
        );
    }
  }

  /**
   * List the authenticated user's repositories. We request the
   * first 100 sorted by most recently updated so the picker defaults
   * to the repos the user is actually working on. Callers that need
   * pagination can follow the GitHub Link header (we don't expose
   * that yet; 100 covers the 95% case for a personal account).
   */
  async fetchUserRepos(accessToken: string): Promise<GitHubRepo[]> {
    // Back-compat shim: callers that don't care about pagination get
    // the first 100 repos (sorted by most recent activity) just like
    // before. Pagination-aware callers should use fetchUserReposPage.
    const { repos } = await this.fetchUserReposPage(accessToken, 1);
    return repos;
  }

  /**
   * FU-01: paginated variant of fetchUserRepos. Returns one page of
   * repositories plus a `hasNext` hint derived from the GitHub
   * `Link` response header. Pages are 1-indexed to match GitHub's
   * own convention.
   *
   * Why a separate method? The pagination response shape is a strict
   * superset of the old flat-array return, so we'd break every
   * existing caller (tests + clone helper) by bolting `hasNext` onto
   * the old method. A new method keeps both contracts clean.
   */
  async fetchUserReposPage(
    accessToken: string,
    page: number = 1,
  ): Promise<{ repos: GitHubRepo[]; hasNext: boolean; page: number }> {
    if (!Number.isInteger(page) || page < 1) page = 1;
    let response;
    try {
      response = await this.fetchImpl(
        `${this.apiBaseUrl}/user/repos?per_page=100&page=${page}&sort=updated&affiliation=owner,collaborator,organization_member`,
        {
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${accessToken}`,
            'User-Agent': 'cds-oauth-client',
          },
        },
      );
    } catch (err) {
      throw new GitHubOAuthError('network_error', 'Failed to reach GitHub /user/repos', err);
    }
    if (!response.ok) {
      throw new GitHubOAuthError(
        'repos_fetch_failed',
        `GitHub /user/repos returned HTTP ${response.status}`,
      );
    }
    const body = await response.json();
    if (!Array.isArray(body)) {
      throw new GitHubOAuthError('repos_fetch_failed', 'GitHub /user/repos did not return an array');
    }
    const repos: GitHubRepo[] = body.map((r: any) => ({
      id: r.id,
      name: r.name,
      fullName: r.full_name,
      description: r.description ?? null,
      isPrivate: !!r.private,
      cloneUrl: r.clone_url,
      sshUrl: r.ssh_url,
      defaultBranch: r.default_branch || 'main',
      updatedAt: r.updated_at ?? null,
      stargazersCount: r.stargazers_count || 0,
      language: r.language ?? null,
    }));
    // Parse Link header for pagination. GitHub returns something like:
    //   <https://api.github.com/user/repos?page=2>; rel="next",
    //   <https://api.github.com/user/repos?page=5>; rel="last"
    // If `rel="next"` is present there are more pages to fetch.
    const linkHeader = (response.headers && typeof response.headers.get === 'function')
      ? response.headers.get('link') || response.headers.get('Link') || ''
      : '';
    const hasNext = /rel=["']next["']/.test(linkHeader);
    return { repos, hasNext, page };
  }
}
