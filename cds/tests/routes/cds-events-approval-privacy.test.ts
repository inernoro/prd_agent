import express from 'express';
import http from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { createCdsEventsRouter } from '../../src/routes/cds-events.js';
import { cdsEventsBus } from '../../src/services/cds-events-bus.js';
import { selfStatusCache } from '../../src/services/self-status-cache.js';

let server: http.Server | undefined;
const clients: http.ClientRequest[] = [];
afterEach(async () => {
  clients.splice(0).forEach(client => client.destroy());
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  server = undefined; vi.restoreAllMocks();
});

it('broadcasts approval SQL/results only to a verified human owner; other authenticated streams still receive heartbeat', async () => {
  vi.spyOn(selfStatusCache, 'enqueueRefresh').mockReturnValue({} as any);
  const app = express();
  app.use((req, _res, next) => {
    const role = req.headers['x-test-role'];
    const ctx = req as any;
    if (role === 'owner') { ctx._cdsBasicHumanAuth = true; ctx.cdsUser = { isSystemOwner: true, authProvider: 'legacy' }; }
    if (role === 'local-owner') { ctx.cdsSession = { id: 'owner-session' }; ctx.cdsUser = { isSystemOwner: true, authProvider: 'local' }; }
    if (role === 'member') { ctx.cdsSession = { id: 'member' }; ctx.cdsUser = { isSystemOwner: false, authProvider: 'local' }; }
    if (role === 'sso') { ctx.cdsSession = { id: 'sso' }; ctx.cdsUser = { isSystemOwner: true, authProvider: 'sso' }; }
    if (role === 'unverified-owner') ctx.cdsUser = { isSystemOwner: true, authProvider: 'legacy' };
    if (role === 'project-key') ctx.cdsProjectKey = { projectId: 'p1', keyId: 'k1' };
    if (role === 'global-key') ctx.cdsAccess = { scope: 'global' };
    next();
  });
  app.use('/api', createCdsEventsRouter());
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  const port = (server!.address() as { port: number }).port;
  const roles = ['owner', 'local-owner', 'member', 'sso', 'unverified-owner', 'project-key', 'global-key'];
  const streams = await Promise.all(roles.map(role => new Promise<{ role: string; done: Promise<string> }>((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port, path: '/api/cds-events', headers: { 'x-test-role': role } }, response => {
      const done = new Promise<string>((finish, fail) => {
        let raw = '';
        response.on('data', chunk => { raw += chunk.toString(); if (raw.includes('privacy-barrier')) finish(raw); });
        response.on('error', error => { if ((error as NodeJS.ErrnoException).code !== 'ECONNRESET') fail(error); });
      });
      resolve({ role, done });
    });
    clients.push(request); request.on('error', reject);
  })));
  for (const type of ['operator.request.created', 'operator.request.approved', 'operator.request.rejected', 'operator.request.log', 'operator.request.completed', 'operator.request.failed'] as const) {
    cdsEventsBus.publish(type, { projectId: 'p1', request: { sql: 'private-sql-canary', result: 'private-result-canary' } });
  }
  cdsEventsBus.publish('heartbeat', { barrier: 'privacy-barrier' });
  for (const stream of streams) {
    const raw = await stream.done;
    expect(raw).toContain('privacy-barrier');
    if (['owner', 'local-owner'].includes(stream.role)) { expect(raw).toContain('private-sql-canary'); expect(raw).toContain('private-result-canary'); }
    else { expect(raw).not.toContain('operator.request.'); expect(raw).not.toContain('private-sql-canary'); expect(raw).not.toContain('private-result-canary'); }
  }
});
