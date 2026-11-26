/**
 * github-mode gate must accept machine credentials (cdsp_/cdsg_/static AI key)
 * alongside the human session cookie — equal standing, both work. Previously the
 * gate only validated cds_gh_session, so agent keys 401'd before reaching
 * key-aware routes like /api/reports (PR #865 Codex P2). These tests pin:
 *   - no session + valid agent key  -> next() (key auth accepted)
 *   - no session + no key           -> 401
 *   - valid cookie session          -> next(), key resolver NOT consulted
 */
import type { OutgoingHttpHeaders } from 'node:http';
import type { Request, Response } from 'express';
import { describe, it, expect, vi } from 'vitest';
import { MemoryAuthStore } from '../../src/infra/auth-store/memory-store.js';
import { createGithubAuthMiddleware } from '../../src/middleware/github-auth.js';
import { accountSignoutDigest, readAccountSignoutProof } from '../../src/services/account-signout-proof.js';
import { AuthService } from '../../src/services/auth-service.js';

const daySeconds = 24 * 60 * 60;
const sessionTtlMs = 7 * daySeconds * 1000;

function mockRes() {
  const headers: OutgoingHttpHeaders = {};
  const res: any = { statusCode: 0, body: undefined, redirectedTo: undefined, headers };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  res.redirect = (_c: number, url: string) => { res.redirectedTo = url; return res; };
  res.setHeader = (name: string, value: number | string | string[]) => { headers[name] = value; return res; };
  return res as Response & { statusCode: number; body: any; redirectedTo?: string; headers: OutgoingHttpHeaders };
}

function apiReq(headers: Record<string, string> = {}): Request {
  return {
    path: '/api/reports',
    url: '/api/reports',
    originalUrl: '/api/reports',
    headers: { accept: 'application/json', ...headers },
  } as unknown as Request;
}

async function storedSession(ageDays = 0) {
  const store = new MemoryAuthStore();
  const authService = new AuthService({ store, config: { allowedOrgs: [], sessionTtlMs } });
  const user = await store.createLocalUser({ username: 'fixture-session-renewal' });
  const issuedAt = new Date(Date.now() - ageDays * daySeconds * 1000);
  const session = await store.createSession({
    userId: user.id, sessionRevision: user.sessionRevision, ttlMs: sessionTtlMs, userAgent: null, ipAddress: null,
  }, issuedAt);
  return { authService, session, user, store };
}

describe('github auth middleware — agent key coexistence', () => {
  it('shares method-scoped recovery routes without opening approval or project operations', async () => {
    const authService = { validateSession: vi.fn(async () => null) } as any;
    const resolveAgentKey = vi.fn(() => null);
    const mw = createGithubAuthMiddleware({ authService, resolveAgentKey,
      isPublicRequest: req => req.method === 'GET' && req.path === '/api/projects/p/access-status' });
    for (const [method, path, allowed] of [
      ['GET', '/api/projects/p/access-status', true],
      ['POST', '/api/projects/p/access-status', false],
      ['GET', '/api/projects/p', false],
      ['POST', '/api/access-requests/r/approve', false],
    ] as const) {
      const next = vi.fn(); const res = mockRes();
      await mw({ ...apiReq(), method, path } as Request, res, next);
      expect(next.mock.calls.length).toBe(allowed ? 1 : 0);
      expect(res.statusCode).toBe(allowed ? 0 : 401);
    }
  });
  it('accepts a valid agent key when there is no session', async () => {
    const authService = { validateSession: vi.fn(async () => null) } as any;
    const resolveAgentKey = vi.fn(() => ({ id: 'projkey:k1' }));
    const mw = createGithubAuthMiddleware({ authService, resolveAgentKey });
    const req = apiReq();
    const res = mockRes();
    const next = vi.fn();

    await mw(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(0);
    expect((req as any)._aiSession).toEqual({ id: 'projkey:k1' });
  });

  it('401s when there is neither a session nor a valid key', async () => {
    const authService = { validateSession: vi.fn(async () => null) } as any;
    const resolveAgentKey = vi.fn(() => null);
    const mw = createGithubAuthMiddleware({ authService, resolveAgentKey });
    const req = apiReq();
    const res = mockRes();
    const next = vi.fn();

    await mw(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('prefers the cookie session and never consults the key resolver', async () => {
    const authService = {
      validateSession: vi.fn(async () => ({ user: { id: 'u1' }, session: { token: 't' } })),
    } as any;
    const resolveAgentKey = vi.fn(() => ({ id: 'projkey:k1' }));
    const mw = createGithubAuthMiddleware({ authService, resolveAgentKey });
    const req = apiReq({ cookie: 'cds_gh_session=valid' });
    const res = mockRes();
    const next = vi.fn();

    await mw(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(resolveAgentKey).not.toHaveBeenCalled();
    expect((req as any).cdsUser).toEqual({ id: 'u1' });
  });

  it.each([
    { hostSessionCookies: false, name: 'cds_gh_session', proofName: 'cds_signout_proof' },
    { hostSessionCookies: true, name: '__Host-cds_gh_session', proofName: '__Host-cds_signout_proof' },
  ])('renews an HTTPS session as $name with a separate sign-out receipt proof', async ({ hostSessionCookies, name, proofName }) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-02T03:04:05Z'));
    try {
      const { authService, session, user, store } = await storedSession(4);
      const mw = createGithubAuthMiddleware({ authService, cookieSecure: true, hostSessionCookies });
      const res = mockRes();
      const next = vi.fn();

      await mw(apiReq({ cookie: `${name}=${session.token}` }), res, next);

      expect(next).toHaveBeenCalledOnce();
      const renewed = await store.findSessionByToken(session.token);
      const expiresAt = new Date(Date.now() + sessionTtlMs);
      expect(renewed?.expiresAt).toBe(expiresAt.toISOString());
      const cookies = res.headers['Set-Cookie'];
      if (!Array.isArray(cookies) || cookies.length !== 2) throw new Error('Expected two separate Set-Cookie headers');
      const sessionHeader = cookies.find(cookie => cookie.startsWith(`${name}=`));
      const proofHeader = cookies.find(cookie => cookie.startsWith(`${proofName}=`));
      if (!sessionHeader || !proofHeader) throw new Error('Expected the session cookie and its receipt proof');
      const [sessionCookie, ...sessionAttributes] = sessionHeader.split('; ');
      const [proofCookie, ...proofAttributes] = proofHeader.split('; ');
      const privateAttributes = ['Path=/', 'HttpOnly', 'SameSite=Lax', 'Secure'];
      expect(sessionCookie === `${name}=${session.token}`).toBe(true);
      expect(sessionAttributes).toEqual(expect.arrayContaining([
        ...privateAttributes, `Max-Age=${sessionTtlMs / 1000}`, `Expires=${expiresAt.toUTCString()}`,
      ]));
      expect(proofAttributes).toEqual(expect.arrayContaining([...privateAttributes, `Max-Age=${37 * daySeconds}`]));
      expect([...sessionAttributes, ...proofAttributes].some(attribute => /^domain=/i.test(attribute))).toBe(false);

      const proofValue = proofCookie.slice(proofName.length + 1);
      const proof = readAccountSignoutProof(proofValue);
      expect(proof?.accountId).toBe(user.id);
      expect(proof?.digest === accountSignoutDigest(session.token)).toBe(true);
      expect(proofValue === session.token).toBe(false);
      const proofOnlyResponse = mockRes();
      const nextWithProof = vi.fn();
      await mw(apiReq({ cookie: proofCookie }), proofOnlyResponse, nextWithProof);
      expect(nextWithProof).not.toHaveBeenCalled();
      expect(proofOnlyResponse.statusCode).toBe(401);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not touch the cookie when the session was not renewed', async () => {
    const { authService, session } = await storedSession();
    const mw = createGithubAuthMiddleware({ authService });
    const req = apiReq({ cookie: `cds_gh_session=${session.token}` });
    const res = mockRes();
    const next = vi.fn();

    await mw(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.headers['Set-Cookie']).toBeUndefined();
  });

  it('stamps an SSO identity as a verified non-owner human session', async () => {
    const authService = { validateSession: vi.fn(async () => null) } as any;
    const mw = createGithubAuthMiddleware({ authService });
    const req = apiReq() as any;
    req.cdsSsoIdentity = {
      subject: 'map:user-1',
      username: 'operator',
      displayName: 'Operator',
      email: 'operator@example.com',
    };
    const res = mockRes();
    const next = vi.fn();

    await mw(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(req._cdsCookieAuth).toBe(true);
    expect(req.cdsSession.userId).toBe('sso:map:user-1');
    expect(req.cdsUser).toMatchObject({
      id: 'sso:map:user-1',
      authProvider: 'sso',
      isSystemOwner: false,
    });
  });

  // 构建闸健康探针必须免鉴权可达（定时回归任务 / 外部监控不带会话），
  // github 模式有自己的 PUBLIC_PATHS 白名单，与 server.ts 的
  // isPublicAccessRequestRoute 相互独立、两边都要登记（Codex P2，2026-07-16）。
  it('lets the build-gate health probe through without any session or key', async () => {
    const authService = { validateSession: vi.fn(async () => null) } as any;
    const resolveAgentKey = vi.fn(() => null);
    const mw = createGithubAuthMiddleware({ authService, resolveAgentKey });
    const req = {
      path: '/api/cluster/build-gate/health',
      url: '/api/cluster/build-gate/health',
      originalUrl: '/api/cluster/build-gate/health',
      headers: { accept: 'application/json' },
    } as unknown as Request;
    const res = mockRes();
    const next = vi.fn();

    await mw(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(0);
    expect(authService.validateSession).not.toHaveBeenCalled();
  });
});
