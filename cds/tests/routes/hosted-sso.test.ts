import http from 'node:http';
import type { Collection } from 'mongodb';
import type { OidcArtifact } from '../../src/infra/auth-store/oidc-store.js';
import express from 'express';
import { describe, it, expect } from 'vitest';
import { MemoryAuthStore } from '../../src/infra/auth-store/memory-store.js';
import { AuthService } from '../../src/services/auth-service.js';
import { HostedSso } from '../../src/services/hosted-sso.js';
import { createHostedSsoRouter } from '../../src/routes/hosted-sso.js';
import type { BranchEntry } from '../../src/types.js';
import type { StateService } from '../../src/services/state.js';

const origin = new URL('https://cds.example.net');
const siteAddress = 'https://preview.example.net';

describe('hosted SSO administration', () => {
  it('requires a supported runtime, a published same-domain origin and verified owner step-up', async () => {
    const auth = new AuthService({ store: new MemoryAuthStore(), github: null, config: {} });
    const owner = await auth.createLocalUser({ username: 'site-owner', password: 'isolated-owner-password', isSystemOwner: true });
    const meta = { userAgent: null, ipAddress: null };
    const ordinary = await auth.createSessionForUser(owner.id, meta);
    const verified = await auth.createSessionForUser(owner.id, { ...meta, passkeyAuthenticated: true });
    const branch = { id: 'site-a', projectId: 'project-a', branch: 'feat/test', services: {} } as BranchEntry;
    const state = {
      getBranch: (id: string) => id === branch.id ? branch : undefined,
      getProject: () => ({ id: branch.projectId, kind: 'git' }),
      getAllBranches: () => [branch],
      save: () => {},
      flush: async () => {},
    } as unknown as StateService;
    const routes = [{ _id: 'a', branchId: branch.id, host: 'preview.example.net', upstreamPort: 9000, weight: 100 }];
    const sso = new HostedSso(origin, state, auth, () => routes);
    const app = express();
    app.use(express.json());
    app.use('/api', createHostedSsoRouter({
      auth, state, sso, accepting: () => true, oidcStore: {} as Collection<OidcArtifact>,
    }));
    const server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing test listener');

    const request = (path: string, token: string, body?: object, headers: http.OutgoingHttpHeaders = {}): Promise<{ status: number; body: string }> => new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: address.port, path, method: body ? 'PUT' : 'GET',
        headers: { Host: origin.host, Origin: origin.origin, Cookie: '__Host-cds_gh_session=' + token, 'Content-Type': 'application/json', ...headers } }, res => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
      });
      req.on('error', reject);
      req.end(body && JSON.stringify(body));
    });
    try {
      const sites = '/api/hosted-sso/sites';
      const payload = { origin: siteAddress, deniedUserIds: [], application: { loginPath: '/auth/start', callbackPath: '/auth/callback' } };
      const panel = '/api/hosted-sso/panel';
      const projectProxy = { 'X-CDS-Internal': '1', 'X-CDS-Source-Host': 'preview.example.net' };
      expect((await request(sites + '/site-a', ordinary.token, payload)).status).toBe(403);
      if (Number(process.versions.node.split('.')[0]) < 22) {
        expect((await request(sites + '/site-a', verified.token, payload)).status).toBe(400);
        expect(branch.hostedSso).toBeUndefined();
        expect(JSON.parse((await request(panel + '/status', '', undefined, projectProxy)).body)).toEqual({ enabled: false });
        return;
      }
      expect((await request(sites + '/site-a', verified.token, { ...payload, origin: 'https://unpublished.example.net' })).status).toBe(409);
      expect((await request(sites + '/site-a', verified.token, payload)).status).toBe(200);
      expect(sso.site(branch.id)?.origin.origin).toBe(siteAddress);
      const read = JSON.parse((await request(sites, verified.token)).body) as { sites: unknown[] };
      expect(read.sites).toMatchObject([{ id: 'site-a', origins: [siteAddress], config: { origin: siteAddress } }]);
      expect(JSON.parse((await request(panel + '/status', '', undefined, projectProxy)).body)).toEqual({ enabled: true });
      expect(JSON.parse((await request(panel + '/status', '')).body)).toEqual({ enabled: false });
      expect((await request(panel + '/start?returnUrl=/work&switchAccount=true', '', undefined, projectProxy)).status).toBe(303);
      expect((await request(sites + '/site-a', verified.token, { ...payload, suspended: true })).status).toBe(200);
      expect(sso.site(branch.id)).toBeUndefined();
      expect((await request(panel + '/start', '', undefined, projectProxy)).status).toBe(404);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});
