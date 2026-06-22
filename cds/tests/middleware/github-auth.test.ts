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
  const res: any = { statusCode: 0, body: undefined, redirectedTo: undefined };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  res.redirect = (_c: number, url: string) => { res.redirectedTo = url; return res; };
  return res as Response & { statusCode: number; body: any; redirectedTo?: string };
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
});
