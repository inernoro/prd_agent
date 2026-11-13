import express from 'express';
import { once } from 'node:events';
import type http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOwnedResourceRetentionRouter } from '../../src/routes/owned-resource-retention.js';

const servers: http.Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections();await new Promise<void>(resolve => server.close(() => resolve())); } });
async function fixture(identity = {}) {
  const service = { inspect: vi.fn(async () => ({ scanStatus: 'partial', usageBytes: null })), getSnapshot: vi.fn(() => null), startReconcile: vi.fn(), cancel: vi.fn() };
  const images = { options: { budgetBytes: 0 }, inspect: vi.fn(async () => ({ scanStatus: 'partial', held: [{ reason: 'legacy-image-ownership-needs-review' }] })),
    getSnapshot: vi.fn(() => null), adopt: vi.fn(async () => ({ adopted: true })), startReconcile: vi.fn() };
  const state = { getProjects: () => [{ id: 'p', name: 'Owned project' }], getLegacyDataCases: () => [] };
  const app = express();app.use(express.json());app.use((req, _res, next) => { Object.assign(req, identity);next(); });app.use(createOwnedResourceRetentionRouter(service as any, state as any, images as any));
  const server = app.listen(0, '127.0.0.1');servers.push(server);await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as any).port}/janitor/tasks`;
  const adoption = { identity: 'sha256:' + 'a'.repeat(64), created: '2026-11-01T00:00:00Z', aliases: ['owned/repo:old'], digests: ['owned/repo@sha256:' + 'b'.repeat(64)], projectId: 'p', ownershipEvidence: 'Original build and registry config records', dataDisposition: 'reproducible-artifact' };
  const post = (suffix: string, body = adoption) => fetch(url + suffix, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { service, images, url, adoption, post };
}
describe('host-wide task and image ownership authorization', () => {
  it('allows global diagnostics while denying Agent self-adoption and cleanup', async () => {
    const f = await fixture();expect(await (await fetch(f.url + '/images')).json()).toMatchObject({ scanStatus: 'partial', canAdopt: false, canExecute: false });
    expect((await f.post('/images/adopt')).status).toBe(403);expect((await f.post('/reconcile')).status).toBe(403);expect(f.images.adopt).not.toHaveBeenCalled();expect(f.service.startReconcile).not.toHaveBeenCalled();
  });
  it('denies project credentials access to host-wide references', async () => {
    const f = await fixture({ cdsProjectKey: { projectId: 'p' } });expect((await fetch(f.url + '/images')).status).toBe(403);expect(f.images.inspect).not.toHaveBeenCalled();
  });
  it('separates owner adoption from enabling a destructive budget policy', async () => {
    const f = await fixture({ cdsSession: {}, cdsUser: { id: 'owner', isSystemOwner: true } });
    expect(await (await fetch(f.url + '/images')).json()).toMatchObject({ enabled: false, canAdopt: true, canExecute: false });
    expect((await f.post('/images/adopt')).status).toBe(200);expect(f.images.adopt).toHaveBeenCalledWith({ ...f.adoption, attestedBy: 'owner' });
    expect((await f.post('/images/reconcile')).status).toBe(409);expect(f.images.startReconcile).not.toHaveBeenCalled();
  });
  it('rejects missing data attestation and retains an identity that changed before adoption', async () => {
    const f = await fixture({ cdsSession: {}, cdsUser: { id: 'owner', isSystemOwner: true } });
    expect((await f.post('/images/adopt', { ...f.adoption, dataDisposition: 'business-data' })).status).toBe(400);expect(f.images.adopt).not.toHaveBeenCalled();
    f.images.adopt.mockRejectedValueOnce(new Error('upstream secret should remain private'));
    const response = await f.post('/images/adopt');expect(response.status).toBe(409);expect(await response.text()).not.toContain('secret');
  });
});
