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

  it('updates report format and moves the content file extension', () => {
    const meta = service.createAcceptanceReport({ title: 'Format switch', format: 'html', content: '<h1>old</h1>' });
    const oldPath = path.join(service.getReportsBase(), `${meta.id}.html`);
    expect(fs.existsSync(oldPath)).toBe(true);

    const md = '# New source\n\nMarkdown body';
    const updated = service.updateAcceptanceReport(meta.id, { format: 'md', content: md });

    expect(updated).not.toBeNull();
    expect(updated!.format).toBe('md');
    expect(service.readAcceptanceReportContent(meta.id)).toBe(md);
    expect(fs.existsSync(path.join(service.getReportsBase(), `${meta.id}.md`))).toBe(true);
    expect(fs.existsSync(oldPath)).toBe(false);
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
    const patched = service.updateAcceptanceReport(bare.id, {
      verdict: 'pass',
      prNumber: 7,
      sourceId: 'acceptance.rule.enterprise',
      sourcePath: 'doc/rule.acceptance.map-enterprise.md',
      contentHash: 'sha256:abc',
      publishedAt: '2026-07-07T00:00:00.000Z',
    });
    expect(patched!.verdict).toBe('pass');
    expect(patched!.prNumber).toBe(7);
    expect(patched!.sourceId).toBe('acceptance.rule.enterprise');
    expect(patched!.sourcePath).toBe('doc/rule.acceptance.map-enterprise.md');
    expect(patched!.contentHash).toBe('sha256:abc');
    expect(patched!.publishedAt).toBe('2026-07-07T00:00:00.000Z');
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

  // ── Content-addressed report image assets (base64 → object storage) ──
  it('writes a report asset content-addressed and reads it back with content-type', () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'); // PNG magic prefix
    service.writeReportAsset('abc123def4560011.png', png);
    const file = path.join(service.getReportAssetsBase(), 'abc123def4560011.png');
    expect(fs.existsSync(file)).toBe(true);
    const read = service.readReportAsset('abc123def4560011.png');
    expect(read).toBeTruthy();
    expect(read!.contentType).toBe('image/png');
    expect(read!.data.equals(png)).toBe(true);
  });

  it('rejects illegal asset names (path traversal / non-hex) and missing files', () => {
    expect(service.readReportAsset('../state.json')).toBeUndefined();
    expect(service.readReportAsset('nope.png')).toBeUndefined(); // not hex
    expect(service.readReportAsset('deadbeef.png')).toBeUndefined(); // legal name, no file
  });

  it('dedups identical bytes (immutable, no-op re-write)', () => {
    const buf = Buffer.from('ffd8ffe000104a464946', 'hex'); // JPEG magic prefix
    const name = 'aabbccddeeff0011.jpg';
    service.writeReportAsset(name, buf);
    const file = path.join(service.getReportAssetsBase(), name);
    const mtime1 = fs.statSync(file).mtimeMs;
    service.writeReportAsset(name, Buffer.from('different bytes ignored')); // existing file untouched
    expect(fs.statSync(file).mtimeMs).toBe(mtime1);
    expect(service.readReportAsset(name)!.data.equals(buf)).toBe(true);
    expect(service.readReportAsset(name)!.contentType).toBe('image/jpeg');
  });

  // ── Nested report folders (项目 = 根目录，技能自取多层子文件夹) ──
  it('findOrCreateFolderPath creates a nested chain under a project and is idempotent', () => {
    const leaf1 = service.findOrCreateFolderPath('prd-agent', '视觉创作/2026-06-22');
    expect(leaf1).toBeTruthy();
    const all = service.listReportFolders('prd-agent');
    const visual = all.find((f) => f.name === '视觉创作' && (f.parentId ?? null) === null);
    const day = all.find((f) => f.name === '2026-06-22');
    expect(visual).toBeTruthy();
    expect(day).toBeTruthy();
    expect(day!.parentId).toBe(visual!.id);
    expect(leaf1).toBe(day!.id);
    // 再次同路径不应重复建（find-or-create 幂等）。
    const leaf2 = service.findOrCreateFolderPath('prd-agent', '视觉创作/2026-06-22');
    expect(leaf2).toBe(leaf1);
    expect(service.listReportFolders('prd-agent').filter((f) => f.name === '视觉创作')).toHaveLength(1);
  });

  it('findOrCreateFolderPath isolates folders per project (same path, different scope)', () => {
    const a = service.findOrCreateFolderPath('proj-a', '视觉创作');
    const b = service.findOrCreateFolderPath('proj-b', '视觉创作');
    expect(a).not.toBe(b);
    expect(service.getReportFolder(a!)!.projectId).toBe('proj-a');
    expect(service.getReportFolder(b!)!.projectId).toBe('proj-b');
    expect(service.findOrCreateFolderPath('proj-a', '')).toBeNull();
  });

  it('deleting a parent promotes children one level and unfiles its direct reports', () => {
    const parent = service.createReportFolder({ name: '功能', projectId: 'p' });
    const child = service.createReportFolder({ name: '子', projectId: 'p', parentId: parent.id });
    const rep = service.createAcceptanceReport({ title: 'r', format: 'md', content: '# r', projectId: 'p', folderId: parent.id });
    service.deleteReportFolder(parent.id);
    // child 上提为根级（parentId → parent 的父级 = null），内容不丢
    expect(service.getReportFolder(parent.id)).toBeUndefined();
    expect(service.getReportFolder(child.id)!.parentId ?? null).toBeNull();
    expect(service.getAcceptanceReport(rep.id)!.folderId).toBeNull();
  });
});
