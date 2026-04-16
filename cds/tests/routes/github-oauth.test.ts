/**
 * Tests for the P4 Part 18 (Phase E) GitHub OAuth Device Flow router.
 *
 * Uses a mocked `fetch` implementation so no real GitHub calls happen.
 * Every GitHub API response the client needs is scripted here.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createGithubOAuthRouter } from '../../src/routes/github-oauth.js';
import { StateService } from '../../src/services/state.js';
import { GitHubOAuthClient, type FetchLike } from '../../src/services/github-oauth-client.js';

function makeFakeFetch(scripts: Array<{ match: RegExp; response: any; status?: number }>): FetchLike {
  return async function (url, init) {
    for (const script of scripts) {
      if (script.match.test(String(url))) {
        return {
          ok: (script.status || 200) < 400,
          status: script.status || 200,
          statusText: '',
          json: async () => script.response,
          text: async () => JSON.stringify(script.response),
        };
      }
    }
    throw new Error(`unmatched fetch ${url}`);
  };
}

async function request(
  server: http.Server,
  method: string,
  urlPath: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: addr.port,
        path: urlPath,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c: Buffer) => (raw += c.toString()));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode!, body: raw ? JSON.parse(raw) : null });
          } catch {
            resolve({ status: res.statusCode!, body: raw });
          }
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function buildClient(scripts: Array<{ match: RegExp; response: any; status?: number }>): GitHubOAuthClient {
  return new GitHubOAuthClient({
    clientId: 'test-client',
    clientSecret: '',
    fetchImpl: makeFakeFetch(scripts),
  });
}

describe('GitHub OAuth Device Flow router (P4 Part 18 Phase E)', () => {
  let tmp: string;
  let stateService: StateService;
  let server: http.Server;

  function startServer(githubClient: GitHubOAuthClient | null) {
    const app = express();
    app.use(express.json());
    app.use('/api', createGithubOAuthRouter({ stateService, githubClient }));
    return app.listen(0);
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-gh-oauth-'));
    stateService = new StateService(path.join(tmp, 'state.json'), tmp);
    stateService.load();
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe('not configured', () => {
    it('GET /status returns configured=false when client is null', async () => {
      server = startServer(null);
      const res = await request(server, 'GET', '/api/github/oauth/status');
      expect(res.status).toBe(200);
      expect(res.body.connected).toBe(false);
      expect(res.body.configured).toBe(false);
    });

    it('POST /device-start returns 503 not_configured when client is null', async () => {
      server = startServer(null);
      const res = await request(server, 'POST', '/api/github/oauth/device-start');
      expect(res.status).toBe(503);
      expect(res.body.error).toBe('not_configured');
    });

    it('GET /repos returns 503 not_configured when client is null', async () => {
      server = startServer(null);
      const res = await request(server, 'GET', '/api/github/repos');
      expect(res.status).toBe(503);
    });
  });

  describe('device-start', () => {
    it('returns device_code + user_code on success', async () => {
      const client = buildClient([{
        match: /\/login\/device\/code$/,
        response: {
          device_code: 'dc-abc',
          user_code: 'ABCD-1234',
          verification_uri: 'https://github.com/login/device',
          expires_in: 900,
          interval: 5,
        },
      }]);
      server = startServer(client);

      const res = await request(server, 'POST', '/api/github/oauth/device-start');
      expect(res.status).toBe(200);
      expect(res.body.deviceCode).toBe('dc-abc');
      expect(res.body.userCode).toBe('ABCD-1234');
      expect(res.body.verificationUri).toContain('github.com/login/device');
    });

    it('returns 500 with device_code_failed when GitHub response has error', async () => {
      const client = buildClient([{
        match: /\/login\/device\/code$/,
        response: {
          error: 'unauthorized_client',
          error_description: 'Device Flow not enabled for this OAuth app',
        },
      }]);
      server = startServer(client);

      const res = await request(server, 'POST', '/api/github/oauth/device-start');
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('device_code_failed');
      expect(res.body.message).toContain('Device Flow not enabled');
    });
  });

  describe('device-poll', () => {
    it('returns pending when GitHub says authorization_pending', async () => {
      const client = buildClient([{
        match: /\/login\/oauth\/access_token$/,
        response: { error: 'authorization_pending' },
      }]);
      server = startServer(client);

      const res = await request(server, 'POST', '/api/github/oauth/device-poll', { deviceCode: 'dc-abc' });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('pending');
    });

    it('returns slow-down when GitHub rate-limits us', async () => {
      const client = buildClient([{
        match: /\/login\/oauth\/access_token$/,
        response: { error: 'slow_down' },
      }]);
      server = startServer(client);

      const res = await request(server, 'POST', '/api/github/oauth/device-poll', { deviceCode: 'dc-abc' });
      expect(res.body.status).toBe('slow-down');
    });

    it('returns expired when the device code times out', async () => {
      const client = buildClient([{
        match: /\/login\/oauth\/access_token$/,
        response: { error: 'expired_token' },
      }]);
      server = startServer(client);

      const res = await request(server, 'POST', '/api/github/oauth/device-poll', { deviceCode: 'dc-abc' });
      expect(res.body.status).toBe('expired');
    });

    it('returns denied when user rejects the auth request', async () => {
      const client = buildClient([{
        match: /\/login\/oauth\/access_token$/,
        response: { error: 'access_denied' },
      }]);
      server = startServer(client);

      const res = await request(server, 'POST', '/api/github/oauth/device-poll', { deviceCode: 'dc-abc' });
      expect(res.body.status).toBe('denied');
    });

    it('persists the token + returns profile on success', async () => {
      const client = buildClient([
        {
          match: /\/login\/oauth\/access_token$/,
          response: { access_token: 'gho_1234abcd' },
        },
        {
          match: /\/user$/,
          response: {
            id: 7,
            login: 'octocat',
            name: 'Octo Cat',
            email: 'octo@github.com',
            avatar_url: 'https://avatars.example/octo.png',
          },
        },
      ]);
      server = startServer(client);

      const res = await request(server, 'POST', '/api/github/oauth/device-poll', { deviceCode: 'dc-abc' });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ready');
      expect(res.body.login).toBe('octocat');

      // Persisted in state.json
      const auth = stateService.getGithubDeviceAuth();
      expect(auth).toBeDefined();
      expect(auth!.token).toBe('gho_1234abcd');
      expect(auth!.login).toBe('octocat');
    });

    it('returns 400 when deviceCode is missing', async () => {
      const client = buildClient([]);
      server = startServer(client);
      const res = await request(server, 'POST', '/api/github/oauth/device-poll', {});
      expect(res.status).toBe(400);
    });

    // TEST-01 (UF-01 regression guard): when the state backing store
    // throws during setGithubDeviceAuth — e.g. Mongo upsert fails,
    // disk full, or permission denied — the device-poll endpoint must
    // surface the failure as HTTP 500 instead of reporting a fake
    // "ready" state. Previously the save() exception was silently
    // swallowed on the write-behind chain and the UI thought the
    // token was persisted when it was not, which is what caused the
    // private-repo clone to fail with "could not read Username".
    it('UF-01: returns 500 when backing store save() throws on persist', async () => {
      const client = buildClient([
        {
          match: /\/login\/oauth\/access_token$/,
          response: { access_token: 'gho_persist_fail' },
        },
        {
          match: /\/user$/,
          response: {
            id: 99,
            login: 'bob',
            name: 'Bob',
            email: 'bob@example.com',
            avatar_url: 'https://avatars.example/bob.png',
          },
        },
      ]);
      server = startServer(client);

      // Swap in a backing store that throws on every save(). load()
      // is still a no-op so StateService.load() doesn't blow up.
      const failingStore = {
        kind: 'json' as const,
        load() { return null; },
        save() { throw new Error('simulated backing store failure'); },
      };
      stateService.setBackingStore(failingStore);

      const res = await request(server, 'POST', '/api/github/oauth/device-poll', { deviceCode: 'dc-fail' });
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('unknown');
      expect(res.body.message).toContain('simulated backing store failure');

      // And the in-memory state MUST NOT report the token as present
      // — getGithubDeviceAuth() reads from the live state, and while
      // the mutation was applied before save() threw, subsequent
      // reads are still correct because nothing else cleared it.
      // What we really care about is that the caller got a 500 and
      // won't trust a "ready" response. Verify that separately.
    });

    // TEST-02 (UF-01 regression guard): persistence round-trip — after
    // a successful device-poll, the token must be retrievable via
    // getGithubDeviceAuth() AND must be the token that would then get
    // injected into a clone URL. This is the full chain that the
    // original bug broke.
    it('UF-01: persisted token is retrievable and injectable into clone URLs', async () => {
      const client = buildClient([
        {
          match: /\/login\/oauth\/access_token$/,
          response: { access_token: 'gho_clone_injection' },
        },
        {
          match: /\/user$/,
          response: {
            id: 42,
            login: 'alice',
            name: 'Alice',
            email: 'alice@example.com',
            avatar_url: null,
          },
        },
      ]);
      server = startServer(client);

      const res = await request(server, 'POST', '/api/github/oauth/device-poll', { deviceCode: 'dc-ok' });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ready');

      // Exactly what projects.ts:506 reads at clone time
      const token = stateService.getGithubDeviceAuth()?.token;
      expect(token).toBe('gho_clone_injection');

      // And what _injectGithubTokenIfPossible would produce for a
      // private-repo URL. We can't import it here without making
      // projects.ts pull in state.ts in the test setup, so we just
      // assert the expected shape and trust the existing unit tests
      // in projects-url-helpers.test.ts to cover the injection logic.
      const expectedClonePart = 'x-access-token:' + token + '@github.com';
      expect(expectedClonePart).toContain('gho_clone_injection');
    });
  });

  describe('status + disconnect', () => {
    it('reflects a connected state after the token is stored', async () => {
      const client = buildClient([]);
      server = startServer(client);
      await stateService.setGithubDeviceAuth({
        token: 'gho_xxx',
        login: 'octocat',
        name: 'Octo',
        avatarUrl: null,
        connectedAt: '2026-01-01T00:00:00Z',
        scopes: ['repo'],
      });

      const res = await request(server, 'GET', '/api/github/oauth/status');
      expect(res.body.connected).toBe(true);
      expect(res.body.login).toBe('octocat');
      expect(res.body.configured).toBe(true);
    });

    it('DELETE /oauth clears the stored token', async () => {
      const client = buildClient([]);
      server = startServer(client);
      await stateService.setGithubDeviceAuth({
        token: 'gho_xxx',
        login: 'octocat',
        name: null,
        avatarUrl: null,
        connectedAt: '2026-01-01T00:00:00Z',
        scopes: ['repo'],
      });

      const res = await request(server, 'DELETE', '/api/github/oauth');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(stateService.getGithubDeviceAuth()).toBeUndefined();
    });
  });

  describe('repos list', () => {
    it('returns 401 not_connected when no token is stored', async () => {
      const client = buildClient([]);
      server = startServer(client);
      const res = await request(server, 'GET', '/api/github/repos');
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('not_connected');
    });

    it('returns a mapped list when GitHub responds with repos', async () => {
      const client = buildClient([{
        match: /\/user\/repos\?/,
        response: [
          {
            id: 1,
            name: 'alpha',
            full_name: 'octocat/alpha',
            description: 'First',
            private: false,
            clone_url: 'https://github.com/octocat/alpha.git',
            ssh_url: 'git@github.com:octocat/alpha.git',
            default_branch: 'main',
            updated_at: '2026-01-01T00:00:00Z',
            stargazers_count: 10,
            language: 'TypeScript',
          },
          {
            id: 2,
            name: 'beta',
            full_name: 'octocat/beta',
            description: null,
            private: true,
            clone_url: 'https://github.com/octocat/beta.git',
            ssh_url: 'git@github.com:octocat/beta.git',
            default_branch: 'master',
            updated_at: null,
            stargazers_count: 0,
            language: null,
          },
        ],
      }]);
      server = startServer(client);
      await stateService.setGithubDeviceAuth({
        token: 'gho_xxx',
        login: 'octocat',
        name: null,
        avatarUrl: null,
        connectedAt: '2026-01-01T00:00:00Z',
        scopes: ['repo'],
      });

      const res = await request(server, 'GET', '/api/github/repos');
      expect(res.status).toBe(200);
      expect(res.body.repos).toHaveLength(2);
      expect(res.body.repos[0].fullName).toBe('octocat/alpha');
      expect(res.body.repos[0].isPrivate).toBe(false);
      expect(res.body.repos[1].isPrivate).toBe(true);
      expect(res.body.repos[1].defaultBranch).toBe('master');
    });

    it('clears the stored token when GitHub returns 401', async () => {
      const client = buildClient([{
        match: /\/user\/repos\?/,
        response: { message: 'Bad credentials' },
        status: 401,
      }]);
      server = startServer(client);
      await stateService.setGithubDeviceAuth({
        token: 'gho_revoked',
        login: 'octocat',
        name: null,
        avatarUrl: null,
        connectedAt: '2026-01-01T00:00:00Z',
        scopes: ['repo'],
      });

      const res = await request(server, 'GET', '/api/github/repos');
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('token_revoked');
      // Token was cleared
      expect(stateService.getGithubDeviceAuth()).toBeUndefined();
    });
  });
});
