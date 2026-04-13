import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import { MemoryAuthStore } from '../../src/infra/auth-store/memory-store.js';
import { GitHubOAuthClient, type FetchLike } from '../../src/services/github-oauth-client.js';
import { AuthService } from '../../src/services/auth-service.js';
import { createAuthRouter, GH_SESSION_COOKIE } from '../../src/routes/auth.js';

function stubFetch(): FetchLike {
  return async (input: string) => {
    if (input.includes('/login/oauth/access_token')) {
      return {
        ok: true, status: 200, statusText: 'OK',
        json: async () => ({ access_token: 'access-xyz', token_type: 'bearer' }),
        text: async () => '',
      };
    }
    if (input.endsWith('/user')) {
      return {
        ok: true, status: 200, statusText: 'OK',
        json: async () => ({
          id: 42, login: 'alice', name: 'Alice', email: 'alice@example.com', avatar_url: null,
        }),
        text: async () => '',
      };
    }
    if (input.endsWith('/user/orgs')) {
      return {
        ok: true, status: 200, statusText: 'OK',
        json: async () => [{ id: 100, login: 'inernoro' }],
        text: async () => '',
      };
    }
    throw new Error(`unexpected ${input}`);
  };
}

interface ResponseLite {
  status: number;
  body: any;
  headers: http.IncomingHttpHeaders;
}

async function request(
  server: http.Server,
  method: string,
  urlPath: string,
  headers: Record<string, string> = {},
): Promise<ResponseLite> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const req = http.request({
      hostname: '127.0.0.1',
      port: addr.port,
      path: urlPath,
      method,
      headers,
    }, (res) => {
      let raw = '';
      res.on('data', (chunk: Buffer) => (raw += chunk.toString()));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode!, body: JSON.parse(raw), headers: res.headers });
        } catch {
          resolve({ status: res.statusCode!, body: raw, headers: res.headers });
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('Auth routes (P2)', () => {
  let server: http.Server;
  let authService: AuthService;

  beforeEach(() => {
    const store = new MemoryAuthStore();
    const github = new GitHubOAuthClient({
      clientId: 'cid',
      clientSecret: 'secret',
      fetchImpl: stubFetch(),
    });
    authService = new AuthService({
      store,
      github,
      config: { allowedOrgs: ['inernoro'] },
    });

    const app = express();
    app.use(express.json());
    app.use('/api', createAuthRouter({
      authService,
      publicBaseUrl: 'http://localhost:9900',
      cookieSecure: false,
    }));
    server = app.listen(0);
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  describe('GET /api/auth/github/login', () => {
    it('redirects 302 to a GitHub authorize URL', async () => {
      const res = await request(server, 'GET', '/api/auth/github/login');
      expect(res.status).toBe(302);
      const location = res.headers.location as string;
      expect(location).toContain('github.com/login/oauth/authorize');
      expect(location).toContain('client_id=cid');
      expect(location).toContain('state=');
    });
  });

  describe('GET /api/auth/github/callback', () => {
    it('400s when code or state missing', async () => {
      const res = await request(server, 'GET', '/api/auth/github/callback');
      expect(res.status).toBe(400);
    });

    it('completes the OAuth dance and issues a session cookie', async () => {
      const login = await request(server, 'GET', '/api/auth/github/login');
      const location = login.headers.location as string;
      const state = new URL(location).searchParams.get('state')!;

      const cb = await request(
        server,
        'GET',
        `/api/auth/github/callback?code=test-code&state=${state}`,
      );
      expect(cb.status).toBe(302);
      expect(cb.headers.location).toBe('/projects.html');
      const setCookie = cb.headers['set-cookie'];
      expect(setCookie).toBeTruthy();
      expect(Array.isArray(setCookie) ? setCookie[0] : setCookie).toContain(GH_SESSION_COOKIE);
    });

    it('400s on an unknown state token', async () => {
      const cb = await request(
        server,
        'GET',
        '/api/auth/github/callback?code=c&state=forged',
      );
      expect(cb.status).toBe(400);
    });
  });

  describe('GET /api/me', () => {
    it('returns 401 when no cookie is provided', async () => {
      const res = await request(server, 'GET', '/api/me');
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('unauthenticated');
    });

    it('returns the user when a valid cookie is provided', async () => {
      const login = await request(server, 'GET', '/api/auth/github/login');
      const state = new URL(login.headers.location as string).searchParams.get('state')!;
      const cb = await request(
        server,
        'GET',
        `/api/auth/github/callback?code=c&state=${state}`,
      );
      const rawCookie = (cb.headers['set-cookie'] as string[])[0];
      const cookieValue = rawCookie.split(';')[0];

      const me = await request(server, 'GET', '/api/me', { cookie: cookieValue });
      expect(me.status).toBe(200);
      expect(me.body.user.githubLogin).toBe('alice');
      expect(me.body.user.isSystemOwner).toBe(true);
    });
  });

  describe('POST /api/auth/logout', () => {
    it('clears the session cookie', async () => {
      const login = await request(server, 'GET', '/api/auth/github/login');
      const state = new URL(login.headers.location as string).searchParams.get('state')!;
      const cb = await request(
        server,
        'GET',
        `/api/auth/github/callback?code=c&state=${state}`,
      );
      const cookieValue = ((cb.headers['set-cookie'] as string[])[0]).split(';')[0];

      const logout = await request(server, 'POST', '/api/auth/logout', { cookie: cookieValue });
      expect(logout.status).toBe(200);
      expect(logout.body.ok).toBe(true);
      const clear = logout.headers['set-cookie'] as string[];
      expect(clear[0]).toContain('Max-Age=0');

      // /api/me must now return 401
      const me = await request(server, 'GET', '/api/me', { cookie: cookieValue });
      expect(me.status).toBe(401);
    });
  });
});
