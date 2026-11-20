import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { protectControlBrowser } from '../../src/middleware/browser-origin.js';

const authority = new URL('https://cds.shared.test');
const protect = protectControlBrowser(authority);

function request(method: string, path: string, headers: Record<string, string> = {}) {
  const req = { method, path, get: (name: string) => name === 'host' ? authority.host : headers[name] } as Request;
  const next = vi.fn();
  const res = { set: vi.fn(), json: vi.fn(), status: vi.fn().mockReturnThis() };
  protect(req, res as unknown as Response, next);
  return { next, res };
}

describe('CDS browser origin boundary on a shared domain', () => {
  it('rejects sibling-origin reads and writes even with an ambient browser session', () => {
    const headers = { 'sec-fetch-site': 'same-site', cookie: '__Host-cds_gh_session=fixture' };
    for (const method of ['GET', 'POST', 'DELETE']) {
      const result = request(method, '/api/projects/fixture', headers);
      expect(result.next).not.toHaveBeenCalled();
      expect(result.res.status).toHaveBeenCalledWith(403);
      expect(result.res.set).toHaveBeenCalledWith('X-Frame-Options', 'SAMEORIGIN');
    }
    expect(request('GET', '/api/users', { referer: 'https://app.shared.test/' }).res.status).toHaveBeenCalledWith(403);
  });

  it('allows the intended top-level authorization redirect and rejects sibling fetches of the same entry', () => {
    const headers = { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
    expect(request('GET', '/api/oidc/auth', headers).next).toHaveBeenCalledOnce();
    expect(request('GET', '/api/hosted-sso/interaction/example', headers).next).toHaveBeenCalledOnce();
    expect(request('GET', '/api/oidc/auth', { ...headers, 'sec-fetch-dest': 'iframe' }).res.status).toHaveBeenCalledWith(403);
    expect(request('POST', '/api/hosted-sso/interaction/example', headers).res.status).toHaveBeenCalledWith(403);
  });

  it('keeps same-origin and machine-to-machine requests available', () => {
    const local = { 'sec-fetch-site': 'same-origin', cookie: '__Host-cds_gh_session=fixture', origin: authority.origin };
    expect(request('POST', '/api/projects', local).next).toHaveBeenCalledOnce();
    expect(request('POST', '/api/oidc/token').next).toHaveBeenCalledOnce();
    expect(request('POST', '/api/projects', { cookie: local.cookie }).res.status).toHaveBeenCalledWith(403);
    expect(request('POST', '/api/auth/login', { origin: 'https://app.shared.test' }).res.status).toHaveBeenCalledWith(403);
  });
});
