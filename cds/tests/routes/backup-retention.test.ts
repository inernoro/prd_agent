import express from 'express';
import { once } from 'node:events';
import type http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBackupRetentionRouter } from '../../src/routes/backup-retention.js';
const servers: http.Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
async function fixture(identity = {}) {
  const service = {
    inspect: vi.fn(async () => ({ scanStatus: 'partial', counts: { unknown: 1 }, directories: [{ error: '未知' }] })),
    getSnapshot: vi.fn(() => null), startReconcile: vi.fn(() => ({ id: 'a'.repeat(32), status: 'running' })),
    cancel: vi.fn(async () => undefined), register: vi.fn(async () => undefined), ownershipOptions: vi.fn(() => ({ projects: [], services: [] })),
  };
  const app = express();app.use(express.json());app.use((req, _res, next) => { Object.assign(req, identity);next(); });app.use(createBackupRetentionRouter(service as any));
  const server = app.listen(0, '127.0.0.1');servers.push(server);await once(server, 'listening');
  return { service, url: `http://127.0.0.1:${(server.address() as any).port}/janitor/backups` };
}
describe('backup retirement authorization and execution HTTP', () => {
  it('exposes unknown state instead of a successful zero and denies Agent self-approval', async () => {
    const f = await fixture();const response = await fetch(f.url);expect(response.status).toBe(200);expect(await response.json()).toMatchObject({ scanStatus: 'partial', canExecute: false });
    expect((await fetch(f.url + '/reconcile', { method: 'POST' })).status).toBe(403);expect(f.service.startReconcile).not.toHaveBeenCalled();
  });
  it('keeps project credentials out of the host-wide backup inventory', async () => {
    const f = await fixture({ cdsProjectKey: { projectId: 'owned-project' } });expect((await fetch(f.url)).status).toBe(403);expect(f.service.inspect).not.toHaveBeenCalled();
  });
  it('starts a bounded owner job and binds cancellation to its actual identity', async () => {
    const f = await fixture({ cdsUser: { isSystemOwner: true }, cdsSession: {} });
    const response = await fetch(f.url + '/reconcile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ maxRemovals: 8 }) });expect(response.status).toBe(202);expect(f.service.startReconcile).toHaveBeenCalledWith(8);
    expect((await fetch(f.url + '/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'a'.repeat(32) }) })).status).toBe(200);expect(f.service.cancel).toHaveBeenCalledWith('a'.repeat(32));
    expect((await fetch(f.url + '/reconcile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ maxRemovals: 9999 }) })).status).toBe(400);
  });
  it('registers explicit historical ownership without granting deletion and keeps rejected integrity checks visible', async () => {
    const f = await fixture({ cdsUser: { isSystemOwner: true }, cdsSession: {} });f.service.register.mockRejectedValueOnce(new Error('raw credential must not leak'));
    const response = await fetch(f.url + '/adopt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: '/owned/incident.gz', projectId: 'p', serviceId: 'retired', origin: 'historical' }) });expect(response.status).toBe(409);expect(await response.text()).not.toContain('credential');expect(f.service.startReconcile).not.toHaveBeenCalled();
  });
  it('requires bounded explicit lineage evidence instead of silently inferring a historical source', async () => {
    const f = await fixture({ cdsUser: { id: 'owner', isSystemOwner: true }, cdsSession: {} });
    const body = { path: '/owned/old.gz', projectId: 'p', serviceId: 'db', origin: 'historical', lineageAttestation: ' ' };
    const post = (value: typeof body) => fetch(f.url + '/adopt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
    expect((await post(body)).status).toBe(400);expect(f.service.register).not.toHaveBeenCalled();
    expect((await post({ ...body, lineageAttestation: 'Original export record matches this physical source' })).status).toBe(200);
    expect(f.service.register).toHaveBeenCalledWith(body.path, 'p', 'db', 'historical', expect.objectContaining({ attestedBy: 'owner', lineageAttestation: 'Original export record matches this physical source' }));
  });
});
