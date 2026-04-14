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
      | 'network_error',
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'GitHubOAuthError';
  }
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
}
