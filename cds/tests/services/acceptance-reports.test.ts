/**
 * Tests for the CDS self-hosted acceptance report store (2026-06-20).
 *
 * Exercises the StateService methods directly:
 *   - create writes a content file to disk + persists lightweight metadata
 *   - list returns newest-first, filterable by project
 *   - get / readContent round-trip the persisted body
 *   - update rewrites the file + recomputes sizeBytes
 *   - delete removes both metadata and the on-disk file
 *
 * The route-layer format inference / size cap live in routes/reports.ts; this
 * suite pins the storage-layer contract.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { StateService } from '../../src/services/state.js';

describe('StateService acceptance reports', () => {
  let stateFile: string;
  let service: StateService;

  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-reports-test-'));
    stateFile = path.join(tmpDir, 'state.json');
    // Pin reports/cache base to a writable temp dir regardless of host so the
    // /data/cds default never interferes.
    process.env.CDS_CACHE_BASE = path.join(tmpDir, 'cache');
    service = new StateService(stateFile);
    service.load();
  });

  afterEach(() => {
    delete process.env.CDS_CACHE_BASE;
    const dir = path.dirname(stateFile);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
  });

  it('creates a report: writes content file + metadata, records sizeBytes', () => {
    const html = '<html><body><h1>verdict: pass</h1></body></html>';
    const meta = service.createAcceptanceReport({
      title: 'Login visual',
      format: 'html',
      content: html,
      createdBy: 'user',
    });

    expect(meta.id).toMatch(/^[0-9a-f]{32}$/);
    expect(meta.title).toBe('Login visual');
    expect(meta.format).toBe('html');
    expect(meta.projectId).toBeNull();
    expect(meta.branchId).toBeNull();
    expect(meta.sizeBytes).toBe(Buffer.byteLength(html, 'utf8'));
    expect(meta.createdBy).toBe('user');
    expect(meta.createdAt).toBeTruthy();

    // Content file exists on disk under reports/<id>.html
    const filePath = path.join(service.getReportsBase(), `${meta.id}.html`);
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.readFileSync(filePath, 'utf8')).toBe(html);
  });

  it('round-trips content via readAcceptanceReportContent', () => {
    const md = '# Heading\n\nbody text';
    const meta = service.createAcceptanceReport({ title: 'MD report', format: 'md', content: md });
    expect(service.readAcceptanceReportContent(meta.id)).toBe(md);
    // md format files get .md extension
    expect(fs.existsSync(path.join(service.getReportsBase(), `${meta.id}.md`))).toBe(true);
  });

  it('lists reports newest-first and filters by project', async () => {
    const a = service.createAcceptanceReport({ title: 'A', format: 'html', content: '<i>a</i>', projectId: 'proj-1' });
    // ensure distinct createdAt ordering
    await new Promise((r) => setTimeout(r, 5));
    const b = service.createAcceptanceReport({ title: 'B', format: 'md', content: '# b', projectId: 'proj-2' });
    await new Promise((r) => setTimeout(r, 5));
    const c = service.createAcceptanceReport({ title: 'C', format: 'html', content: '<i>c</i>', projectId: 'proj-1' });

    const all = service.listAcceptanceReports();
    expect(all.map((r) => r.id)).toEqual([c.id, b.id, a.id]);

    const proj1 = service.listAcceptanceReports('proj-1');
    expect(proj1.map((r) => r.title).sort()).toEqual(['A', 'C']);

    const proj2 = service.listAcceptanceReports('proj-2');
    expect(proj2.map((r) => r.title)).toEqual(['B']);
  });

  it('updates title and content, recomputing sizeBytes', () => {
    const meta = service.createAcceptanceReport({ title: 'Old', format: 'html', content: '<p>short</p>' });
    const longer = '<p>much longer content body</p>';
    const updated = service.updateAcceptanceReport(meta.id, { title: 'New', content: longer });
    expect(updated).not.toBeNull();
    expect(updated!.title).toBe('New');
    expect(updated!.sizeBytes).toBe(Buffer.byteLength(longer, 'utf8'));
    expect(service.readAcceptanceReportContent(meta.id)).toBe(longer);
    expect(updated!.updatedAt >= meta.createdAt).toBe(true);
  });

  it('deletes metadata and the on-disk content file', () => {
    const meta = service.createAcceptanceReport({ title: 'Doomed', format: 'html', content: '<x/>' });
    const filePath = path.join(service.getReportsBase(), `${meta.id}.html`);
    expect(fs.existsSync(filePath)).toBe(true);

    const removed = service.deleteAcceptanceReport(meta.id);
    expect(removed).toBe(true);
    expect(service.getAcceptanceReport(meta.id)).toBeUndefined();
    expect(fs.existsSync(filePath)).toBe(false);

    // Deleting a non-existent report returns false.
    expect(service.deleteAcceptanceReport('nope')).toBe(false);
  });

  it('persists metadata across a reload (file-backed state round-trip)', () => {
    const meta = service.createAcceptanceReport({ title: 'Persisted', format: 'md', content: '# kept' });

    const reloaded = new StateService(stateFile);
    reloaded.load();
    const got = reloaded.getAcceptanceReport(meta.id);
    expect(got?.title).toBe('Persisted');
    expect(reloaded.readAcceptanceReportContent(meta.id)).toBe('# kept');
  });

  it('returns undefined content for a missing report', () => {
    expect(service.readAcceptanceReportContent('does-not-exist')).toBeUndefined();
  });
});
