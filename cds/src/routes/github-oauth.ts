/**
 * GitHub OAuth Device Flow router — P4 Part 18 (Phase E).
 *
 * Powers the "从 GitHub 选择" button in the New Project modal plus
 * the Settings → GitHub Integration tab. Orthogonal to the existing
 * CDS session auth (src/routes/auth.ts) — this is bring-your-own
 * token for picking repos, not a CDS login mechanism.
 *
 * Endpoints:
 *   POST /api/github/oauth/device-start
 *     → { deviceCode, userCode, verificationUri, expiresIn, interval }
 *     Starts the device flow; the frontend renders userCode +
 *     verificationUri and loops device-poll until success.
 *
 *   POST /api/github/oauth/device-poll { deviceCode }
 *     → { status: 'pending' | 'slow-down' | 'expired' | 'denied' | 'ready', login? }
 *     One poll tick. On 'ready' the token is persisted server-side
 *     (state.githubDeviceAuth) and the response carries the login
 *     for the UI to greet the user with.
 *
 *   GET /api/github/oauth/status
 *     → { connected: true, login, name, avatarUrl, connectedAt, scopes }
 *     | { connected: false, configured: boolean }
 *     The `configured` field tells the UI whether CDS_GITHUB_CLIENT_ID
 *     is set — if not, the Sign in button is hidden with a hint.
 *
 *   DELETE /api/github/oauth
 *     → { ok: true }
 *     Deletes the persisted token. Does NOT revoke it on GitHub's
 *     side (we could POST /applications/{client_id}/token but that
 *     needs the client_secret which device-flow apps may not have).
 *     Users can revoke manually at https://github.com/settings/applications.
 *
 *   GET /api/github/repos
 *     → { repos: GitHubRepo[] }
 *     Lists the authenticated user's repos (first 100, sorted by
 *     most recently updated).
 */

import { Router } from 'express';
import type { StateService } from '../services/state.js';
import type { GitHubOAuthClient } from '../services/github-oauth-client.js';
import { GitHubOAuthError } from '../services/github-oauth-client.js';

export interface GitHubOAuthRouterDeps {
  stateService: StateService;
  /** Set when CDS_GITHUB_CLIENT_ID is configured. Null disables the feature. */
  githubClient: GitHubOAuthClient | null;
}

export function createGithubOAuthRouter(deps: GitHubOAuthRouterDeps): Router {
  const router = Router();
  const { stateService, githubClient } = deps;

  // Small helper so every endpoint returns a consistent
  // "feature-disabled" response when client_id isn't configured.
  function requireClient(res: import('express').Response): GitHubOAuthClient | null {
    if (!githubClient) {
      res.status(503).json({
        error: 'not_configured',
        message:
          'GitHub 集成未配置。请管理员设置 CDS_GITHUB_CLIENT_ID 环境变量并在 GitHub OAuth App 设置中启用 Device Flow。',
      });
      return null;
    }
    return githubClient;
  }

  router.post('/github/oauth/device-start', async (_req, res) => {
    const client = requireClient(res);
    if (!client) return;
    try {
      const init = await client.startDeviceFlow('repo read:user');
      res.json(init);
    } catch (err) {
      const msg = (err as Error).message;
      res.status(500).json({ error: 'device_code_failed', message: msg });
    }
  });

  router.post('/github/oauth/device-poll', async (req, res) => {
    const client = requireClient(res);
    if (!client) return;
    const { deviceCode } = (req.body || {}) as { deviceCode?: string };
    if (!deviceCode) {
      res.status(400).json({ error: 'invalid_request', message: 'deviceCode 不能为空' });
      return;
    }

    try {
      const token = await client.pollDeviceFlow(deviceCode);
      // Success — fetch profile so we can store display metadata
      // and return it to the UI.
      try {
        const profile = await client.fetchProfile(token);
        const snapshot = {
          token,
          login: profile.login,
          name: profile.name,
          avatarUrl: profile.avatarUrl,
          connectedAt: new Date().toISOString(),
          // GitHub doesn't echo granted scopes on the device flow
          // success response; we pin what we requested so the UI
          // has something to show. Real granted scopes can be seen
          // on github.com/settings/applications.
          scopes: ['repo', 'read:user'],
        };
        stateService.setGithubDeviceAuth(snapshot);
        res.json({
          status: 'ready',
          login: snapshot.login,
          name: snapshot.name,
          avatarUrl: snapshot.avatarUrl,
          connectedAt: snapshot.connectedAt,
          scopes: snapshot.scopes,
        });
      } catch (profileErr) {
        // Token acquired but profile fetch failed — persist a
        // minimal snapshot so the UI still sees "connected", but
        // flag the profile error in the response.
        const snapshot = {
          token,
          login: '(unknown)',
          name: null,
          avatarUrl: null,
          connectedAt: new Date().toISOString(),
          scopes: ['repo', 'read:user'],
        };
        stateService.setGithubDeviceAuth(snapshot);
        res.json({
          status: 'ready',
          login: '(unknown)',
          warning: 'token 已获取但 /user profile 拉取失败: ' + (profileErr as Error).message,
        });
      }
      return;
    } catch (err) {
      if (err instanceof GitHubOAuthError) {
        switch (err.code) {
          case 'device_poll_pending':
            res.json({ status: 'pending' });
            return;
          case 'device_poll_slow_down':
            res.json({ status: 'slow-down' });
            return;
          case 'device_poll_expired':
            res.json({ status: 'expired' });
            return;
          case 'device_poll_denied':
            res.json({ status: 'denied' });
            return;
          default:
            res.status(500).json({ error: err.code, message: err.message });
            return;
        }
      }
      res.status(500).json({ error: 'unknown', message: (err as Error).message });
    }
  });

  router.get('/github/oauth/status', (_req, res) => {
    const configured = !!githubClient;
    const auth = stateService.getGithubDeviceAuth();
    if (!auth) {
      res.json({ connected: false, configured });
      return;
    }
    res.json({
      connected: true,
      configured,
      login: auth.login,
      name: auth.name,
      avatarUrl: auth.avatarUrl,
      connectedAt: auth.connectedAt,
      scopes: auth.scopes,
    });
  });

  router.delete('/github/oauth', (_req, res) => {
    stateService.setGithubDeviceAuth(null);
    res.json({ ok: true });
  });

  router.get('/github/repos', async (_req, res) => {
    const client = requireClient(res);
    if (!client) return;
    const auth = stateService.getGithubDeviceAuth();
    if (!auth) {
      res.status(401).json({
        error: 'not_connected',
        message: '尚未连接 GitHub。请先通过 Device Flow 登录。',
      });
      return;
    }
    try {
      const repos = await client.fetchUserRepos(auth.token);
      res.json({ repos });
    } catch (err) {
      if (err instanceof GitHubOAuthError && err.code === 'repos_fetch_failed') {
        // 401 from GitHub likely means the token was revoked; clear
        // the snapshot so the UI re-prompts for Sign in.
        const msg = err.message;
        if (msg.includes('401') || msg.includes('403')) {
          stateService.setGithubDeviceAuth(null);
          res.status(401).json({
            error: 'token_revoked',
            message: 'GitHub token 已失效，已清除本地记录，请重新连接。',
          });
          return;
        }
      }
      res.status(500).json({ error: 'repos_fetch_failed', message: (err as Error).message });
    }
  });

  return router;
}
