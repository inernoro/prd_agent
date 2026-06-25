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

  it('round-trips verdict + deploy-context metadata (WS1/E1)', () => {
    const meta = service.createAcceptanceReport({
      title: 'With metadata',
      format: 'html',
      content: '<p>ok</p>',
      projectId: 'proj-1',
      verdict: 'conditional',
      tier: 'P0 冒烟',
      defectCounts: { p0: 0, p1: 2 },
      commitSha: 'abc1234',
      branch: 'claude/feature-x',
      prNumber: 922,
      deployMode: 'fast',
    });
    expect(meta.verdict).toBe('conditional');
    expect(meta.tier).toBe('P0 冒烟');
    expect(meta.defectCounts).toEqual({ p0: 0, p1: 2 });
    expect(meta.commitSha).toBe('abc1234');
    expect(meta.branch).toBe('claude/feature-x');
    expect(meta.prNumber).toBe(922);
    expect(meta.deployMode).toBe('fast');

    // Defaults to null when omitted.
    const bare = service.createAcceptanceReport({ title: 'Bare', format: 'md', content: '# x' });
    expect(bare.verdict).toBeNull();
    expect(bare.commitSha).toBeNull();
    expect(bare.defectCounts).toBeNull();

    // PATCH-style metadata update (verdict flip + pr number backfill).
    const patched = service.updateAcceptanceReport(bare.id, { verdict: 'pass', prNumber: 7 });
    expect(patched!.verdict).toBe('pass');
    expect(patched!.prNumber).toBe(7);
  });

  it('mints, looks up and revokes an anonymous share token (E6)', () => {
    const meta = service.createAcceptanceReport({ title: 'Shareable', format: 'html', content: '<p>s</p>' });
    expect(meta.shareToken == null).toBe(true);

    const shared = service.enableReportShare(meta.id);
    expect(shared!.shareToken).toMatch(/^[0-9a-f]{32}$/);
    const token = shared!.shareToken!;

    // Idempotent: enabling again returns the same token.
    expect(service.enableReportShare(meta.id)!.shareToken).toBe(token);
    // Reverse lookup resolves the report.
    expect(service.getReportByShareToken(token)?.id).toBe(meta.id);
    expect(service.getReportByShareToken('deadbeef')).toBeUndefined();

    // Revoke invalidates the token.
    const revoked = service.disableReportShare(meta.id);
    expect(revoked!.shareToken).toBeNull();
    expect(service.getReportByShareToken(token)).toBeUndefined();
  });

  it('filters by updatedSince for incremental consumption (WS3)', async () => {
    const a = service.createAcceptanceReport({ title: 'A', format: 'md', content: '# a' });
    await new Promise((r) => setTimeout(r, 10));
    const cursor = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 10));
    const b = service.createAcceptanceReport({ title: 'B', format: 'md', content: '# b' });

    const since = service.listAcceptanceReports(null, undefined, cursor);
    expect(since.map((r) => r.id)).toEqual([b.id]);
    // Touching A bumps updatedAt so it reappears after the cursor.
    service.updateAcceptanceReport(a.id, { verdict: 'pass' });
    const after = service.listAcceptanceReports(null, undefined, cursor).map((r) => r.id).sort();
    expect(after).toEqual([a.id, b.id].sort());
  });
});
