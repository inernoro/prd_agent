/**
 * Route-level tests for the local username + password auth router, wired with
 * the same github-auth gate used in production so we verify:
 *  - public endpoints (bootstrap-status, bootstrap, login) reach without a session
 *  - authed endpoints (change-password, users, activity) are gated by the cookie
 *  - system-owner-only endpoints reject non-owners
 *  - login issues the shared session cookie and the gate accepts it
 *  - no password material leaks into any response
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import { MemoryAuthStore } from '../../src/infra/auth-store/memory-store.js';
import { GitHubOAuthClient } from '../../src/services/github-oauth-client.js';
import { AuthService } from '../../src/services/auth-service.js';
import { createAuthRouter, GH_SESSION_COOKIE } from '../../src/routes/auth.js';
import { createAuthLocalRouter } from '../../src/routes/auth-local.js';
import { createGithubAuthMiddleware } from '../../src/middleware/github-auth.js';

interface Res {
  status: number;
  body: any;
  headers: http.IncomingHttpHeaders;
}

async function call(
  server: http.Server,
  method: string,
  urlPath: string,
  opts: { body?: unknown; cookie?: string } = {},
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const payload = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(payload));
    }
    if (opts.cookie) headers.Cookie = opts.cookie;
    const req = http.request(
      { hostname: '127.0.0.1', port: addr.port, path: urlPath, method, headers },
      (res) => {
        let raw = '';
        res.on('data', (c: Buffer) => (raw += c.toString()));
        res.on('end', () => {
          let body: any = raw;
          try { body = JSON.parse(raw); } catch { /* keep raw */ }
          resolve({ status: res.statusCode!, body, headers: res.headers });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function sessionCookieFrom(res: Res): string {
  const setCookie = res.headers['set-cookie'];
  const raw = Array.isArray(setCookie) ? setCookie[0] : String(setCookie || '');
  const token = raw.split(';')[0];
  expect(token.startsWith(`${GH_SESSION_COOKIE}=`)).toBe(true);
  return token;
}

describe('Local auth routes (with gate)', () => {
  let server: http.Server;
  let svc: AuthService;

  beforeEach(() => {
    const store = new MemoryAuthStore();
    const github = new GitHubOAuthClient({
      clientId: 'cid', clientSecret: 'secret',
      fetchImpl: async () => { throw new Error('github not used'); },
    });
    svc = new AuthService({ store, github, config: { allowedOrgs: [] } });

    const app = express();
    app.use(express.json());
    app.use('/api', createAuthRouter({ authService: svc, publicBaseUrl: 'http://localhost:9900', cookieSecure: false }));
    app.use(createGithubAuthMiddleware({ authService: svc }));
    app.use('/api', createAuthLocalRouter({ authService: svc, cookieSecure: false, bootstrapAllowed: true }));
    server = app.listen(0);
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('reports needsBootstrap then creates the first owner (public)', async () => {
    const status = await call(server, 'GET', '/api/auth/bootstrap-status');
    expect(status.status).toBe(200);
    expect(status.body.needsBootstrap).toBe(true);

    const boot = await call(server, 'POST', '/api/auth/bootstrap', {
      body: { username: 'owner', password: 'owner-password-1', name: 'Owner' },
    });
    expect(boot.status).toBe(200);
    expect(boot.body.user.isSystemOwner).toBe(true);
    expect(boot.body.user).not.toHaveProperty('passwordHash');
    expect(boot.body.user).not.toHaveProperty('passwordSalt');
    const cookie = sessionCookieFrom(boot);

    // Bootstrap is now closed.
    const again = await call(server, 'POST', '/api/auth/bootstrap', {
      body: { username: 'owner2', password: 'owner-password-2' },
    });
    expect(again.status).toBe(409);

    // Owner can create another local user.
    const created = await call(server, 'POST', '/api/auth/users', {
      cookie, body: { username: 'member', password: 'member-password-1', name: 'Member' },
    });
    expect(created.status).toBe(201);
    expect(created.body.user.username).toBe('member');

    // Member logs in (public).
    const login = await call(server, 'POST', '/api/auth/login', {
      body: { username: 'member', password: 'member-password-1' },
    });
    expect(login.status).toBe(200);
    expect(login.body.user.username).toBe('member');
    const memberCookie = sessionCookieFrom(login);

    // Member cannot list users (not owner).
    const denied = await call(server, 'GET', '/api/auth/users', { cookie: memberCookie });
    expect(denied.status).toBe(403);

    // Owner can list users; no secrets leak.
    const list = await call(server, 'GET', '/api/auth/users', { cookie });
    expect(list.status).toBe(200);
    expect(list.body.users.length).toBe(2);
    for (const u of list.body.users) {
      expect(u).not.toHaveProperty('passwordHash');
      expect(u).not.toHaveProperty('passwordSalt');
    }
  });

  it('rejects bad login credentials with 401', async () => {
    await call(server, 'POST', '/api/auth/bootstrap', { body: { username: 'root', password: 'root-password-1' } });
    const bad = await call(server, 'POST', '/api/auth/login', { body: { username: 'root', password: 'nope' } });
    expect(bad.status).toBe(401);
  });

  it('gates change-password and activity without a session', async () => {
    const cp = await call(server, 'POST', '/api/auth/change-password', { body: { oldPassword: 'x', newPassword: 'yyyyyyyy' } });
    expect(cp.status).toBe(401);
    const act = await call(server, 'GET', '/api/auth/activity');
    expect(act.status).toBe(401);
  });

  it('lets a user change their own password and records activity', async () => {
    const boot = await call(server, 'POST', '/api/auth/bootstrap', { body: { username: 'owner', password: 'owner-password-1' } });
    const cookie = sessionCookieFrom(boot);

    const cp = await call(server, 'POST', '/api/auth/change-password', {
      cookie, body: { oldPassword: 'owner-password-1', newPassword: 'owner-password-2' },
    });
    expect(cp.status).toBe(200);

    // The old session was revoked by changePassword; re-login with new password.
    const relogin = await call(server, 'POST', '/api/auth/login', { body: { username: 'owner', password: 'owner-password-2' } });
    expect(relogin.status).toBe(200);
    const cookie2 = sessionCookieFrom(relogin);

    // Owner sees activity (bootstrap + change-password + login at minimum).
    const act = await call(server, 'GET', '/api/auth/activity', { cookie: cookie2 });
    expect(act.status).toBe(200);
    const actions = act.body.activity.map((a: { action: string }) => a.action);
    expect(actions).toContain('change-password');
    expect(actions).toContain('login');
  });
});

describe('Local auth bootstrap gating (volatile store)', () => {
  // PR #865 Codex P1: on a volatile (memory) backend the store empties on every
  // restart, so the public bootstrap endpoint must be DISABLED to stop the first
  // post-restart visitor from seizing isSystemOwner. Production wires
  // bootstrapAllowed = (store is mongo); here we pass false to lock the gate.
  let server: http.Server;

  beforeEach(() => {
    const store = new MemoryAuthStore();
    const github = new GitHubOAuthClient({
      clientId: 'cid', clientSecret: 'secret',
      fetchImpl: async () => { throw new Error('github not used'); },
    });
    const svc = new AuthService({ store, github, config: { allowedOrgs: [] } });
    const app = express();
    app.use(express.json());
    app.use(createGithubAuthMiddleware({ authService: svc }));
    app.use('/api', createAuthLocalRouter({ authService: svc, cookieSecure: false, bootstrapAllowed: false }));
    server = app.listen(0);
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('reports needsBootstrap=false and refuses bootstrap (403) when not durable', async () => {
    const status = await call(server, 'GET', '/api/auth/bootstrap-status');
    expect(status.status).toBe(200);
    expect(status.body.needsBootstrap).toBe(false);

    const boot = await call(server, 'POST', '/api/auth/bootstrap', {
      body: { username: 'root', password: 'root-password-1' },
    });
    expect(boot.status).toBe(403);
    expect(boot.body.code).toBe('bootstrap_unavailable');
  });
});
