import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import { once } from 'node:events';
import { createJanitorObservationRouter } from '../../src/routes/janitor-observation.js';
const servers: http.Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(s => new Promise<void>(r => { s.closeAllConnections(); s.close(() => r()); }))); });
async function fixture(identity = {}) {
 const preview = vi.fn(async () => ({ candidates: [], held: [], scanned: 0 }));
 const app = express(); app.use((req, _res, next) => { Object.assign(req, identity); next(); });
 app.use(createJanitorObservationRouter({ previewDeploymentSources: preview } as any));
 const server = app.listen(0, '127.0.0.1'); servers.push(server); await once(server, 'listening');
 return { preview, url: `http://127.0.0.1:${(server.address() as any).port}/janitor/deployment-sources` };
}
describe('source retention observation HTTP contract', () => {
 it('binds project keys to their actual project and ignores attempted query overrides', async () => {
  const f = await fixture({ cdsProjectKey: { projectId: 'owned' } });
  const r = await fetch(f.url + '?project=foreign'); expect(r.status).toBe(200);
  expect(f.preview.mock.calls[0]).toEqual(['owned', expect.any(AbortSignal)]);
 });
 it('denies host-wide inventory to an unrelated persisted human', async () => {
  const f = await fixture({ cdsUser: { isSystemOwner: false }, cdsSession: {} });
  expect((await fetch(f.url)).status).toBe(403); expect(f.preview).not.toHaveBeenCalled();
 });
 it('reports unavailable queries without a fake successful empty result or raw errors', async () => {
  const f = await fixture(); f.preview.mockRejectedValueOnce(new Error('/private/path credentials'));
  const r = await fetch(f.url); expect(r.status).toBe(503);
  const b = await r.text(); expect(b).not.toContain('private'); expect(b).not.toContain('scanned');
 });
});
