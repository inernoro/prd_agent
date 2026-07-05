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

interface Res { status: number; body: any; headers: http.IncomingHttpHeaders; }

async function call(
  server: http.Server,
  method: string,
  urlPath: string,
  opts: { projectKey?: string; body?: unknown } = {},
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (opts.projectKey) headers['x-test-project-key'] = opts.projectKey;
    const payload = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(payload));
    }
    const req = http.request(
      { hostname: '127.0.0.1', port: addr.port, path: urlPath, method, headers },
      (res) => {
        let raw = '';
        res.on('data', (c: Buffer) => (raw += c.toString()));
        res.on('end', () => {
          let body: any = raw;
          try { body = JSON.parse(raw); } catch { /* keep raw */ }
          resolve({ status: res.statusCode!, body, headers: res.headers });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe('Acceptance report routes — project-scoped key access', () => {
  let server: http.Server;
  let stateFile: string;
  let service: StateService;
  let reportA: { id: string };
  let reportB: { id: string };
  let reportGlobal: { id: string };

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
    reportGlobal = service.createAcceptanceReport({
      title: 'Global report', format: 'md', content: '# g', projectId: null, branchId: null, createdBy: 't',
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

  it('HTML raw reports allow target=_blank links to open from the sandbox', async () => {
    const report = service.createAcceptanceReport({
      title: 'HTML report',
      format: 'html',
      content: '<!doctype html><a target="_blank" href="https://example.com">open</a>',
      projectId: 'proj-a',
      branchId: null,
      createdBy: 't',
    });
    const res = await call(server, 'GET', `/api/reports/${report.id}/raw`, { projectKey: 'proj-a' });
    expect(res.status).toBe(200);
    expect(res.headers['content-security-policy']).toContain('sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox');
  });

  it('project key cannot read/delete a global (null-project) report (403)', async () => {
    const meta = await call(server, 'GET', `/api/reports/${reportGlobal.id}`, { projectKey: 'proj-a' });
    expect(meta.status).toBe(403);
    const raw = await call(server, 'GET', `/api/reports/${reportGlobal.id}/raw`, { projectKey: 'proj-a' });
    expect(raw.status).toBe(403);
    const del = await call(server, 'DELETE', `/api/reports/${reportGlobal.id}`, { projectKey: 'proj-a' });
    expect(del.status).toBe(403);
    expect(service.getAcceptanceReport(reportGlobal.id)).toBeTruthy();
  });

  it('human auth can read the global report', async () => {
    const res = await call(server, 'GET', `/api/reports/${reportGlobal.id}`);
    expect(res.status).toBe(200);
    expect(res.body.report.id).toBe(reportGlobal.id);
  });

  it('project key create is forced into its own project (no orphan/global), then listable', async () => {
    const created = await call(server, 'POST', '/api/reports', {
      projectKey: 'proj-a',
      body: { title: 'no-project', format: 'md', content: '# x' }, // no projectId given
    });
    expect(created.status).toBe(201);
    expect(created.body.report.projectId).toBe('proj-a');
    // The same scoped key can now see it in its list.
    const list = await call(server, 'GET', '/api/reports', { projectKey: 'proj-a' });
    const ids = (list.body.reports as Array<{ id: string }>).map((r) => r.id);
    expect(ids).toContain(created.body.report.id);
  });

  it('project key cannot create a report under another project', async () => {
    const created = await call(server, 'POST', '/api/reports', {
      projectKey: 'proj-a',
      body: { title: 'cross', format: 'md', content: '# x', projectId: 'proj-b' },
    });
    expect(created.status).toBe(201);
    expect(created.body.report.projectId).toBe('proj-a'); // forced back to the key's project
  });

  it('PATCH with invalid folderId rejects before mutating content (atomic, Codex P2)', async () => {
    // 同时改 title 和给一个非法 folderId（不存在）→ 必须 400 且 title 不被改。
    const res = await call(server, 'PATCH', `/api/reports/${reportA.id}`, {
      body: { title: '被改后的标题', folderId: 'nonexistent-folder' },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_folder');
    // 内容/标题未被部分修改。
    expect(service.getAcceptanceReport(reportA.id)!.title).toBe('A report');
  });

  it('PATCH with cross-project folderId rejects before mutating content (Codex P2)', async () => {
    // proj-b 的文件夹不能用于 proj-a 的报告。
    const folderB = service.createReportFolder({ name: 'B 夹', projectId: 'proj-b' });
    const res = await call(server, 'PATCH', `/api/reports/${reportA.id}`, {
      body: { title: '跨项目改名', folderId: folderB.id },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_folder');
    expect(service.getAcceptanceReport(reportA.id)!.title).toBe('A report');
    expect(service.getAcceptanceReport(reportA.id)!.folderId ?? null).toBeNull();
  });

  it('PATCH with valid same-project folderId moves and applies title together', async () => {
    const folderA = service.createReportFolder({ name: 'A 夹', projectId: 'proj-a' });
    const res = await call(server, 'PATCH', `/api/reports/${reportA.id}`, {
      body: { title: '新标题', folderId: folderA.id },
    });
    expect(res.status).toBe(200);
    expect(service.getAcceptanceReport(reportA.id)!.title).toBe('新标题');
    expect(service.getAcceptanceReport(reportA.id)!.folderId).toBe(folderA.id);
  });

  it('extracts inline base64 images into content-addressed assets on ingest', async () => {
    // Minimal valid 1x1 PNG.
    const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const html = `<html><body><img src="data:image/png;base64,${b64}"></body></html>`;
    const created = await call(server, 'POST', '/api/reports', {
      body: { title: 'with image', format: 'html', content: html },
    });
    expect(created.status).toBe(201);
    const id = created.body.report.id as string;

    // Stored body no longer carries base64; it points at a content-addressed asset.
    const stored = service.readAcceptanceReportContent(id)!;
    expect(stored).not.toContain('data:image');
    const m = stored.match(/\/api\/reports\/assets\/([a-f0-9]{64}\.png)/);
    expect(m).toBeTruthy();
    const name = m![1];

    // Bytes round-trip exactly through the state asset store.
    const asset = service.readReportAsset(name);
    expect(asset!.data.equals(Buffer.from(b64, 'base64'))).toBe(true);

    // The public asset route serves it (200).
    const got = await call(server, 'GET', `/api/reports/assets/${name}`);
    expect(got.status).toBe(200);
  });
});
