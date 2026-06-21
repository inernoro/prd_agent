/**
 * Route-level access control for CDS self-hosted acceptance reports.
 *
 * Pins PR #865 Bugbot finding: a project-scoped agent key (cdsp_) must only be
 * able to list / read / patch / delete reports tied to its own project — not
 * any report cluster-wide. Cookie / bootstrap (human owner) auth leaves
 * req.cdsProjectKey undefined and stays unrestricted, per the feature's
 * "CDS 登录即可、无需单独权限" design.
 *
 * The gate normally stamps req.cdsProjectKey; here a tiny middleware simulates
 * it from an x-test-project-key header so we can exercise the router directly.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import { StateService } from '../../src/services/state.js';
import { createReportsRouter } from '../../src/routes/reports.js';

interface Res { status: number; body: any; }

async function call(
  server: http.Server,
  method: string,
  urlPath: string,
  opts: { projectKey?: string } = {},
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (opts.projectKey) headers['x-test-project-key'] = opts.projectKey;
    const req = http.request(
      { hostname: '127.0.0.1', port: addr.port, path: urlPath, method, headers },
      (res) => {
        let raw = '';
        res.on('data', (c: Buffer) => (raw += c.toString()));
        res.on('end', () => {
          let body: any = raw;
          try { body = JSON.parse(raw); } catch { /* keep raw */ }
          resolve({ status: res.statusCode!, body });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('Acceptance report routes — project-scoped key access', () => {
  let server: http.Server;
  let stateFile: string;
  let service: StateService;
  let reportA: { id: string };
  let reportB: { id: string };

  beforeEach(async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-reports-access-'));
    stateFile = path.join(tmpDir, 'state.json');
    process.env.CDS_CACHE_BASE = path.join(tmpDir, 'cache');
    service = new StateService(stateFile);
    service.load();
    reportA = service.createAcceptanceReport({
      title: 'A report', format: 'md', content: '# a', projectId: 'proj-a', branchId: null, createdBy: 't',
    });
    reportB = service.createAcceptanceReport({
      title: 'B report', format: 'md', content: '# b', projectId: 'proj-b', branchId: null, createdBy: 't',
    });

    const app = express();
    // Simulate the auth gate stamping a project-scoped key from a test header.
    app.use((req, _res, next) => {
      const pk = req.headers['x-test-project-key'];
      if (typeof pk === 'string' && pk) {
        (req as unknown as { cdsProjectKey?: { projectId: string; keyId: string } }).cdsProjectKey =
          { projectId: pk, keyId: 'test-key' };
      }
      next();
    });
    app.use('/api', createReportsRouter({ stateService: service }));
    server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
  });

  afterEach(() => {
    server?.close();
    delete process.env.CDS_CACHE_BASE;
    const dir = path.dirname(stateFile);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
  });

  it('project-a key cannot read another project report (403)', async () => {
    const res = await call(server, 'GET', `/api/reports/${reportB.id}`, { projectKey: 'proj-a' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('project_mismatch');
  });

  it('project-a key can read its own project report (200)', async () => {
    const res = await call(server, 'GET', `/api/reports/${reportA.id}`, { projectKey: 'proj-a' });
    expect(res.status).toBe(200);
    expect(res.body.report.id).toBe(reportA.id);
  });

  it('project-a key list is scoped to its project only', async () => {
    const res = await call(server, 'GET', '/api/reports', { projectKey: 'proj-a' });
    expect(res.status).toBe(200);
    const ids = (res.body.reports as Array<{ id: string }>).map((r) => r.id);
    expect(ids).toContain(reportA.id);
    expect(ids).not.toContain(reportB.id);
  });

  it('cookie/human auth (no project key) sees all reports', async () => {
    const res = await call(server, 'GET', '/api/reports');
    expect(res.status).toBe(200);
    const ids = (res.body.reports as Array<{ id: string }>).map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining([reportA.id, reportB.id]));
  });

  it('project-a key cannot delete another project report (403, report survives)', async () => {
    const res = await call(server, 'DELETE', `/api/reports/${reportB.id}`, { projectKey: 'proj-a' });
    expect(res.status).toBe(403);
    expect(service.getAcceptanceReport(reportB.id)).toBeTruthy();
  });

  it('project-a key cannot read another project report raw content (403)', async () => {
    const res = await call(server, 'GET', `/api/reports/${reportB.id}/raw`, { projectKey: 'proj-a' });
    expect(res.status).toBe(403);
  });
});
