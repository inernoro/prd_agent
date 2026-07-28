/**
 * github-mode gate must accept machine credentials (cdsp_/cdsg_/static AI key)
 * alongside the human session cookie — equal standing, both work. Previously the
 * gate only validated cds_gh_session, so agent keys 401'd before reaching
 * key-aware routes like /api/reports (PR #865 Codex P2). These tests pin:
 *   - no session + valid agent key  -> next() (key auth accepted)
 *   - no session + no key           -> 401
 *   - valid cookie session          -> next(), key resolver NOT consulted
 */
import { describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';
import { createGithubAuthMiddleware } from '../../src/middleware/github-auth.js';

function mockRes() {
  const res: any = { statusCode: 0, body: undefined, redirectedTo: undefined, headers: {} as Record<string, string> };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  res.redirect = (_c: number, url: string) => { res.redirectedTo = url; return res; };
  res.setHeader = (name: string, value: string) => { res.headers[name] = value; return res; };
  return res as Response & { statusCode: number; body: any; redirectedTo?: string; headers: Record<string, string> };
}

function apiReq(headers: Record<string, string> = {}): Request {
  return {
    path: '/api/reports',
    url: '/api/reports',
    originalUrl: '/api/reports',
    headers: { accept: 'application/json', ...headers },
  } as unknown as Request;
}

describe('github auth middleware — agent key coexistence', () => {
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

  it('re-issues the session cookie when the session slid forward', async () => {
    const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
    const authService = {
      validateSession: vi.fn(async () => ({
        user: { id: 'u1' },
        session: { token: 'valid', expiresAt },
        renewed: true,
      })),
    } as any;
    const mw = createGithubAuthMiddleware({ authService, cookieSecure: true });
    const req = apiReq({ cookie: 'cds_gh_session=valid' });
    const res = mockRes();
    const next = vi.fn();

    await mw(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    const cookie = res.headers['Set-Cookie'];
    expect(cookie).toContain('cds_gh_session=valid');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain(`Expires=${new Date(expiresAt).toUTCString()}`);
  });

  it('does not touch the cookie when the session was not renewed', async () => {
    const authService = {
      validateSession: vi.fn(async () => ({
        user: { id: 'u1' },
        session: { token: 'valid', expiresAt: new Date().toISOString() },
        renewed: false,
      })),
    } as any;
    const mw = createGithubAuthMiddleware({ authService });
    const req = apiReq({ cookie: 'cds_gh_session=valid' });
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
