import express from 'express';
import { once } from 'node:events';
import type http from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { createHostCapacityObservationRouter } from '../../src/routes/host-capacity-observation.js';
const servers: http.Server[] = [];
afterEach(async () => { for (const s of servers.splice(0)) { s.closeAllConnections(); await new Promise<void>(r => s.close(() => r())); } });
it('只允许正常系统所有者读取缓存，拒绝项目 key、SSO、未验证账号，不触发采样', async () => {
  for (const identity of [{}, { cdsUser: { isSystemOwner: true } }, { cdsProjectKey: { projectId: 'p' } },
    { cdsSession: {}, cdsUser: { isSystemOwner: false } }, { cdsSession: {}, cdsUser: { isSystemOwner: true, authProvider: 'sso' } },
    { _cdsBasicHumanAuth: true, cdsUser: { isSystemOwner: true } }]) {
    const getSnapshot = vi.fn(() => ({ status: 'unknown', sampledAt: null }));
    const app = express(); app.use((req, _res, next) => { Object.assign(req, identity); next(); });
    app.use(createHostCapacityObservationRouter({ getSnapshot } as any));
    const server = app.listen(0, '127.0.0.1'); servers.push(server); await once(server, 'listening');
    const r = await fetch(`http://127.0.0.1:${(server.address() as any).port}/host-capacity/observation?path=/etc/passwd`);
    const owner = '_cdsBasicHumanAuth' in identity;
    expect(r.status).toBe(owner ? 200 : 403); expect(getSnapshot).toHaveBeenCalledTimes(owner ? 1 : 0);
    expect(JSON.stringify(await r.json())).not.toContain('/etc/passwd');
  }
});
