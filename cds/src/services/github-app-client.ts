/**
 * GitHubAppClient — talks to GitHub as a GitHub App (not an OAuth App).
 *
 * Unlike the existing GitHubOAuthClient (Device Flow for a single user),
 * this client mints short-lived installation access tokens so the server
 * can:
 *   1. Verify incoming webhook HMAC signatures
 *   2. Post / update "check runs" on commits — the panel Railway shows
 *      in PRs under "Some checks were not successful" / "✅ Success"
 *   3. List installations (repos the App has been granted access to)
 *
 * Zero new dependencies: JWT RS256 uses Node's built-in `crypto`, and
 * HTTP calls use the global `fetch` already used elsewhere in CDS.
 *
 * Design notes:
 * - Installation tokens last 1h. We cache them in-memory keyed by
 *   installationId and re-mint when <60s remaining. Lost on restart —
 *   acceptable because mint cost is ~1 HTTPS call.
 * - All API calls are isolated behind the instance so tests can inject
 *   a `fetchImpl`, same pattern as GitHubOAuthClient.
 */

import { createSign, createHmac, timingSafeEqual } from 'node:crypto';

/** Minimal subset of the fetch API we rely on. Mirrors GitHubOAuthClient. */
export type FetchLike = (url: string, init?: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  json: () => Promise<any>;
  text: () => Promise<string>;
}>;

export interface GitHubAppClientOptions {
  /** Numeric GitHub App id (string so leading zeros survive env parsing). */
  appId: string;
  /** PEM-encoded RSA private key — real newlines, not `\n` escapes. */
  privateKey: string;
  /** Lowercase App slug — optional, only for the install URL helper. */
  appSlug?: string;
  /** Injection point for tests. Defaults to the global `fetch`. */
  fetchImpl?: FetchLike;
  /**
   * Clock skew tolerance when verifying JWT-issued-at fields during tests.
   * Production code pins to the system clock.
   */
  clockSkewSec?: number;
}

export interface CheckRunCreatePayload {
  /** Display name, e.g. "CDS Deploy". Required. */
  name: string;
  /** Commit SHA the check belongs to. Required. */
  headSha: string;
  /** Lifecycle — defaults to 'in_progress' when omitted. */
  status?: 'queued' | 'in_progress' | 'completed';
  /** Set only with status='completed'. Defaults to 'success'. */
  conclusion?: 'success' | 'failure' | 'neutral' | 'cancelled' | 'skipped' | 'timed_out' | 'action_required';
  /** URL GitHub links to from the "Details" button. */
  detailsUrl?: string;
  /** ISO timestamp for started_at. Defaults to now. */
  startedAt?: string;
  /** ISO timestamp for completed_at. Only with status='completed'. */
  completedAt?: string;
  /** Free-form correlation id — CDS uses the branch id. */
  externalId?: string;
  output?: { title: string; summary: string };
}

export interface CheckRunUpdatePayload {
  status?: 'queued' | 'in_progress' | 'completed';
  conclusion?: 'success' | 'failure' | 'neutral' | 'cancelled' | 'skipped' | 'timed_out' | 'action_required';
  detailsUrl?: string;
  completedAt?: string;
  output?: {
    title: string;
    summary: string;
    /**
     * Optional markdown body shown under "Show more" in GitHub's check-run
     * panel. Useful for embedding deploy log tails on failure. Capped at
     * 65535 chars by GitHub; callers should trim before passing.
     */
    text?: string;
  };
}

export interface InstallationSummary {
  id: number;
  account: {
    login: string;
    type: string;
    avatarUrl: string | null;
  };
  targetType: string;
  repositorySelection: 'all' | 'selected';
}

export interface InstallationRepoSummary {
  id: number;
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch: string | null;
  htmlUrl: string;
}

interface TokenCacheEntry {
  token: string;
  /** Epoch milliseconds when this token is no longer safe to use. */
  expiresAtMs: number;
}

export class GitHubAppError extends Error {
  constructor(public code: string, message: string, public status?: number) {
    super(message);
    this.name = 'GitHubAppError';
  }
}

export class GitHubAppClient {
  private readonly appId: string;
  private readonly privateKey: string;
  readonly appSlug: string | undefined;
  private readonly fetchImpl: FetchLike;
  private readonly tokenCache = new Map<number, TokenCacheEntry>();

  constructor(opts: GitHubAppClientOptions) {
    this.appId = opts.appId;
    this.privateKey = opts.privateKey;
    this.appSlug = opts.appSlug;
    this.fetchImpl = opts.fetchImpl || (globalThis.fetch as unknown as FetchLike);
  }

  /**
   * Sign a fresh App JWT. Valid for ≤10 minutes per GitHub's spec; we use
   * 9 minutes to stay under the limit with clock skew.
   *
   * The `iat` is backdated 30s to tolerate clock drift on the GitHub side
   * (documented workaround in GitHub's own examples).
   */
  generateAppJwt(nowSec = Math.floor(Date.now() / 1000)): string {
    const header = { alg: 'RS256', typ: 'JWT' };
    const payload = {
      iat: nowSec - 30,
      exp: nowSec + 9 * 60,
      iss: this.appId,
    };
    const headerB64 = base64urlJson(header);
    const payloadB64 = base64urlJson(payload);
    const signingInput = `${headerB64}.${payloadB64}`;
    const signer = createSign('RSA-SHA256');
    signer.update(signingInput);
    signer.end();
    const signature = signer.sign(this.privateKey);
    const signatureB64 = base64url(signature);
    return `${signingInput}.${signatureB64}`;
  }

  /**
   * Mint (or reuse a cached) installation access token. Tokens live an hour
   * on GitHub's side; we refresh when <60s remain.
   */
  async getInstallationToken(installationId: number): Promise<string> {
    const cached = this.tokenCache.get(installationId);
    if (cached && cached.expiresAtMs - Date.now() > 60_000) {
      return cached.token;
    }
    const jwt = this.generateAppJwt();
    const res = await this.fetchImpl(
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'CDS-GitHubApp/1.0',
        },
      },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new GitHubAppError(
        'installation_token_failed',
        `Failed to mint installation token (HTTP ${res.status}): ${text.slice(0, 200)}`,
        res.status,
      );
    }
    const body = (await res.json()) as { token: string; expires_at: string };
    const entry: TokenCacheEntry = {
      token: body.token,
      expiresAtMs: new Date(body.expires_at).getTime(),
    };
    this.tokenCache.set(installationId, entry);
    return entry.token;
  }

  /** Drop a cached token — call after a 401 so the next request re-mints. */
  invalidateTokenCache(installationId: number): void {
    this.tokenCache.delete(installationId);
  }

  /**
   * Create a check run on a commit. Returns the numeric id so the caller
   * can PATCH it later via `updateCheckRun`.
   *
   * Errors here don't crash the deploy — the caller treats them as "best
   * effort" so a CDS outage of GitHub connectivity doesn't block a deploy.
   */
  async createCheckRun(
    installationId: number,
    owner: string,
    repo: string,
    payload: CheckRunCreatePayload,
  ): Promise<{ id: number; htmlUrl: string }> {
    const token = await this.getInstallationToken(installationId);
    const body: Record<string, unknown> = {
      name: payload.name,
      head_sha: payload.headSha,
      status: payload.status || 'in_progress',
    };
    if (payload.conclusion) body.conclusion = payload.conclusion;
    if (payload.detailsUrl) body.details_url = payload.detailsUrl;
    if (payload.startedAt) body.started_at = payload.startedAt;
    if (payload.completedAt) body.completed_at = payload.completedAt;
    if (payload.externalId) body.external_id = payload.externalId;
    if (payload.output) body.output = payload.output;

    const url = `https://api.github.com/repos/${owner}/${repo}/check-runs`;
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'CDS-GitHubApp/1.0',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new GitHubAppError(
        'create_check_run_failed',
        `POST /check-runs failed (HTTP ${res.status}): ${text.slice(0, 300)}`,
        res.status,
      );
    }
    const json = (await res.json()) as { id: number; html_url: string };
    return { id: json.id, htmlUrl: json.html_url };
  }

  /**
   * Patch an existing check run. Typically used to move from 'in_progress'
   * to 'completed' with a conclusion + summary.
   */
  async updateCheckRun(
    installationId: number,
    owner: string,
    repo: string,
    checkRunId: number,
    payload: CheckRunUpdatePayload,
  ): Promise<void> {
    const token = await this.getInstallationToken(installationId);
    const body: Record<string, unknown> = {};
    if (payload.status) body.status = payload.status;
    if (payload.conclusion) body.conclusion = payload.conclusion;
    if (payload.detailsUrl) body.details_url = payload.detailsUrl;
    if (payload.completedAt) body.completed_at = payload.completedAt;
    if (payload.output) body.output = payload.output;

    const url = `https://api.github.com/repos/${owner}/${repo}/check-runs/${checkRunId}`;
    const res = await this.fetchImpl(url, {
      method: 'PATCH',
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'CDS-GitHubApp/1.0',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new GitHubAppError(
        'update_check_run_failed',
        `PATCH /check-runs/${checkRunId} failed (HTTP ${res.status}): ${text.slice(0, 300)}`,
        res.status,
      );
    }
  }

  /**
   * Post a comment to a PR (or issue). PR comments go through the issues
   * API — `POST /repos/:owner/:repo/issues/:number/comments`. Used for
   * the Railway-style "preview URL on PR open" bot comment.
   *
   * Returns the comment id + HTML url so callers can cache it and edit
   * later (e.g. update the preview URL when the slug changes).
   */
  async createIssueComment(
    installationId: number,
    owner: string,
    repo: string,
    issueNumber: number,
    body: string,
  ): Promise<{ id: number; htmlUrl: string }> {
    const token = await this.getInstallationToken(installationId);
    const res = await this.fetchImpl(
      `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
      {
        method: 'POST',
        headers: {
          Authorization: `token ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'CDS-GitHubApp/1.0',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ body }),
      },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new GitHubAppError(
        'create_comment_failed',
        `POST /issues/${issueNumber}/comments failed (HTTP ${res.status}): ${text.slice(0, 300)}`,
        res.status,
      );
    }
    const json = (await res.json()) as { id: number; html_url: string };
    return { id: json.id, htmlUrl: json.html_url };
  }

  /**
   * Update an existing issue/PR comment. Used to refresh the preview-URL
   * bot comment when a subsequent push changes the preview state.
   */
  async updateIssueComment(
    installationId: number,
    owner: string,
    repo: string,
    commentId: number,
    body: string,
  ): Promise<void> {
    const token = await this.getInstallationToken(installationId);
    const res = await this.fetchImpl(
      `https://api.github.com/repos/${owner}/${repo}/issues/comments/${commentId}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `token ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'CDS-GitHubApp/1.0',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ body }),
      },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new GitHubAppError(
        'update_comment_failed',
        `PATCH /issues/comments/${commentId} failed (HTTP ${res.status}): ${text.slice(0, 300)}`,
        res.status,
      );
    }
  }

  /**
   * List every installation of this App. Used by the Settings UI so the
   * operator can associate a project with one of the App's install
   * targets (their user or org).
   */
  async listInstallations(): Promise<InstallationSummary[]> {
    const jwt = this.generateAppJwt();
    const res = await this.fetchImpl('https://api.github.com/app/installations?per_page=100', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'CDS-GitHubApp/1.0',
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new GitHubAppError(
        'list_installations_failed',
        `GET /app/installations failed (HTTP ${res.status}): ${text.slice(0, 200)}`,
        res.status,
      );
    }
    const json = (await res.json()) as Array<{
      id: number;
      account: { login: string; type: string; avatar_url: string } | null;
      target_type: string;
      repository_selection: 'all' | 'selected';
    }>;
    return json.map((inst) => ({
      id: inst.id,
      account: {
        login: inst.account?.login || '(unknown)',
        type: inst.account?.type || 'Unknown',
        avatarUrl: inst.account?.avatar_url || null,
      },
      targetType: inst.target_type,
      repositorySelection: inst.repository_selection,
    }));
  }

  /**
   * List repos accessible to a particular installation. Called after the
   * user picks an installation so we can show them the repos available
   * for linking to a CDS project.
   */
  async listInstallationRepos(installationId: number): Promise<InstallationRepoSummary[]> {
    const token = await this.getInstallationToken(installationId);
    const res = await this.fetchImpl(
      'https://api.github.com/installation/repositories?per_page=100',
      {
        method: 'GET',
        headers: {
          Authorization: `token ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'CDS-GitHubApp/1.0',
        },
      },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new GitHubAppError(
        'list_repos_failed',
        `GET /installation/repositories failed (HTTP ${res.status}): ${text.slice(0, 200)}`,
        res.status,
      );
    }
    const json = (await res.json()) as {
      repositories: Array<{
        id: number;
        name: string;
        full_name: string;
        private: boolean;
        default_branch: string;
        html_url: string;
      }>;
    };
    return (json.repositories || []).map((r) => ({
      id: r.id,
      name: r.name,
      fullName: r.full_name,
      private: r.private,
      defaultBranch: r.default_branch || null,
      htmlUrl: r.html_url,
    }));
  }
}

/**
 * Verify a webhook signature. GitHub signs the raw request body with
 * `HMAC-SHA256(secret, body)` and sends the hex digest as
 * `X-Hub-Signature-256: sha256=<hex>`. Use a constant-time compare so
 * an attacker can't deduce the secret via timing attacks.
 *
 * Returns true on match, false on any kind of mismatch (including a
 * missing header or incorrect prefix). Does NOT throw — let the route
 * map `false` to a 401 so signature failures stay out of observability.
 */
export function verifyWebhookSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
  const providedHex = signatureHeader.slice('sha256='.length).trim();
  if (providedHex.length !== 64) return false;
  const hmac = createHmac('sha256', secret);
  hmac.update(rawBody);
  const expectedHex = hmac.digest('hex');
  // timingSafeEqual requires equal-length buffers.
  const expected = Buffer.from(expectedHex, 'hex');
  let provided: Buffer;
  try {
    provided = Buffer.from(providedHex, 'hex');
  } catch {
    return false;
  }
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

/** Build the install-URL an operator clicks to grant the App access. */
export function buildInstallUrl(appSlug: string | undefined, state?: string): string | null {
  if (!appSlug) return null;
  const base = `https://github.com/apps/${encodeURIComponent(appSlug)}/installations/new`;
  return state ? `${base}?state=${encodeURIComponent(state)}` : base;
}

function base64url(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function base64urlJson(obj: unknown): string {
  return base64url(Buffer.from(JSON.stringify(obj), 'utf-8'));
}
