import { describe, expect, it } from 'vitest';
import { buildZip } from '../../src/utils/zip.js';
import { fetchCodeReviewGithubSnapshot, parseCodeReviewGithubUrl, validateCodeReviewZip, readCodeReviewSnapshot } from '../../src/services/code-review-source.js';
import type { CodeReviewAuditEvent } from '../../src/services/code-review-audit.js';

function rename(zip: Buffer, before: string, after: string): Buffer {
  if (before.length !== after.length) throw new Error('fixture length mismatch');
  const copy = Buffer.from(zip);
  let index = copy.indexOf(before);
  while (index !== -1) { copy.write(after, index); index = copy.indexOf(before, index + after.length); }
  return copy;
}

function symlinkEntry(zip: Buffer, name: string): { zip: Buffer; centralOffset: number } {
  const copy = Buffer.from(zip);
  let offset = copy.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  while (offset !== -1 && copy.readUInt32LE(offset) === 0x02014b50) {
    const nameLength = copy.readUInt16LE(offset + 28);
    if (copy.subarray(offset + 46, offset + 46 + nameLength).toString('utf8') === name) {
      copy.writeUInt16LE((3 << 8) | 20, offset + 4); // Git archive's Unix symlink metadata.
      copy.writeUInt32LE((0xa1ff << 16) >>> 0, offset + 38);
      return { zip: copy, centralOffset: offset };
    }
    offset += 46 + nameLength + copy.readUInt16LE(offset + 30) + copy.readUInt16LE(offset + 32);
  }
  throw new Error('fixture entry missing');
}

describe('code review source snapshots', () => {
  it.each(['src', 'app'])('preserves real %s directory paths when a sanitized snapshot is checked again', async (directory) => {
    const first = await validateCodeReviewZip(buildZip([{ name: `repository/${directory}/a.ts`, data: 'const a = 1' }]));
    const second = await readCodeReviewSnapshot(first.zip);
    expect(second.files.map((file) => file.name)).toEqual([`${directory}/a.ts`]);
    expect((await validateCodeReviewZip(first.zip)).zip).toEqual(first.zip);
  });
  it('removes dependencies, credentials, unsupported and oversized files and common wrapper', async () => {
    const result = await validateCodeReviewZip(buildZip([
      { name: 'repository/src/a.ts', data: 'const a = 1' },
      { name: 'repository/node_modules/x/index.js', data: 'secret' },
      { name: 'repository/.cds/credentials.json', data: '{"token":"secret"}' },
      { name: 'repository/.env.json', data: 'secret' },
      { name: 'repository/cert.pem', data: 'secret' },
      { name: 'repository/big.ts', data: Buffer.alloc(201 * 1024) },
      { name: 'repository/README.md', data: 'docs' },
      { name: 'repository/excluded.ts', data: 'no' },
    ]), ['**/excluded.ts']);
    expect(result.totalFiles).toBe(1);
    expect(result.skippedFiles).toBe(7);
    expect(result.zip.includes(Buffer.from('src/a.ts'))).toBe(true);
    expect(result.zip.includes(Buffer.from('credentials'))).toBe(false);
    expect(result.zip.includes(Buffer.from('repository/'))).toBe(false);
  });

  it.each([
    { name: 'deploy/nginx/conf.d/default.conf', exclude: ['deploy'] },
    { name: 'deploy/nginx/conf.d/default.conf', exclude: [] },
    { name: 'deploy/excluded.ts', exclude: ['deploy'] },
  ])('skips out-of-scope Git archive symlink $name without following or forwarding it', async ({ name, exclude }) => {
    const target = '../../../../outside-secret';
    const source = 'export const value = 1;';
    const archive = symlinkEntry(buildZip([{ name: 'cds/src/utils/zip.ts', data: source }, { name, data: target }]), name).zip;
    const result = await validateCodeReviewZip(archive, exclude);
    const sanitized = await readCodeReviewSnapshot(result.zip);
    expect(result.totalFiles).toBe(1);
    expect(result.skippedFiles).toBe(1);
    expect(sanitized.files.map((file) => file.name)).toEqual(['cds/src/utils/zip.ts']);
    expect(sanitized.files[0].data.toString()).toBe(source);
    expect(result.zip.includes(Buffer.from(name))).toBe(false);
    expect(result.zip.includes(Buffer.from(target))).toBe(false);
  });

  it.each(['deploy/nginx/conf.d/default.conf', 'deploy/excluded.ts'])('still verifies CRC of skipped symlink %s', async (name) => {
    const fixture = symlinkEntry(buildZip([{ name: 'a.ts', data: 'const value = 1;' }, { name, data: '../target' }]), name);
    fixture.zip.writeUInt32LE((fixture.zip.readUInt32LE(fixture.centralOffset + 16) ^ 1) >>> 0, fixture.centralOffset + 16);
    await expect(validateCodeReviewZip(fixture.zip, ['deploy'])).rejects.toThrow(/校验失败/);
  });

  it('normalizes a real GitHub archive wrapper while retaining the selected cds source path', async () => {
    const wrapper = 'inernoro-prd_agent-6b2dce4/';
    const linkName = `${wrapper}deploy/nginx/conf.d/default.conf`;
    const archive = symlinkEntry(buildZip([
      { name: `${wrapper}cds/src/utils/zip.ts`, data: 'export const value = 1;' },
      { name: linkName, data: '../../../../outside-secret' },
    ]), linkName).zip;
    const result = await validateCodeReviewZip(archive, ['deploy']);
    const checkedAgain = await readCodeReviewSnapshot(result.zip);
    expect(checkedAgain.files.map((file) => file.name)).toEqual(['cds/src/utils/zip.ts']);
  });

  it('rejects links in the selected source scope and excluded special device entries', async () => {
    const link = symlinkEntry(buildZip([{ name: 'cds/src/utils/zip.ts', data: '../outside.ts' }]), 'cds/src/utils/zip.ts');
    await expect(validateCodeReviewZip(link.zip)).rejects.toThrow(/符号链接/);
    const device = symlinkEntry(buildZip([{ name: 'a.ts', data: 'code' }, { name: 'deploy/device.conf', data: '' }]), 'deploy/device.conf');
    device.zip.writeUInt32LE((0x21ff << 16) >>> 0, device.centralOffset + 38);
    await expect(validateCodeReviewZip(device.zip, ['deploy'])).rejects.toThrow(/特殊文件/);
  });

  it.each(['../aa.ts', '/absx.ts', 'C:/aa.ts', 'src\\a.ts'])('rejects unsafe archive path %s', async (unsafe) => {
    const name = 'goodx.ts';
    expect(unsafe.length).toBe(name.length);
    const malformed = rename(buildZip([{ name, data: 'code' }]), name, unsafe);
    await expect(validateCodeReviewZip(malformed)).rejects.toThrow();
  });

  it('rejects symlink entries, encryption, duplicate paths, corruption and empty archives', async () => {
    const zip = buildZip([{ name: 'src/a.ts', data: 'original' }]);
    const central = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    const symlink = Buffer.from(zip);
    symlink.writeUInt32LE((0xa1ff << 16) >>> 0, central + 38);
    await expect(validateCodeReviewZip(symlink)).rejects.toThrow(/符号链接/);
    const encrypted = Buffer.from(zip);
    encrypted.writeUInt16LE(0x0801, central + 8);
    await expect(validateCodeReviewZip(encrypted)).rejects.toThrow();
    await expect(validateCodeReviewZip(buildZip([{ name: 'a.ts', data: '1' }, { name: 'a.ts', data: '2' }]))).rejects.toThrow(/重复/);
    const corrupted = Buffer.from(zip);
    corrupted[30 + Buffer.byteLength('src/a.ts')] ^= 1;
    await expect(validateCodeReviewZip(corrupted)).rejects.toThrow();
    await expect(validateCodeReviewZip(buildZip([]))).rejects.toThrow(/没有可审查/);
  });

  it('rejects oversized declared expansion before reading content', async () => {
    const zip = buildZip([{ name: 'a.ts', data: 'aaaaa'.repeat(100) }]);
    const central = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    zip.writeUInt32LE(1024 * 1024 * 1024 + 1, central + 24);
    await expect(validateCodeReviewZip(zip)).rejects.toThrow(/1 GiB/);
  });

  it('uses reproducible snapshot bytes rather than upload timestamps', async () => {
    const first = await validateCodeReviewZip(buildZip([{ name: 'src/a.ts', data: 'const a=1', modifiedAt: new Date(2000, 0, 1) }]));
    const second = await validateCodeReviewZip(buildZip([{ name: 'src/a.ts', data: 'const a=1', modifiedAt: new Date(2026, 0, 1) }]));
    expect(first.zip.equals(second.zip)).toBe(true);
  });

  it('rejects hostile GitHub hosts, credentials, deep URLs and unsupported schemes', () => {
    for (const url of ['http://github.com/a/b', 'https://github.com.evil.test/a/b', 'https://user:pass@github.com/a/b',
      'https://127.0.0.1/a/b', 'https://github.com/a/b/tree/main', 'https://github.com/a/b?q=token']) {
      expect(() => parseCodeReviewGithubUrl(url)).toThrow();
    }
    expect(parseCodeReviewGithubUrl('https://github.com/owner/repo.git')).toEqual({ owner: 'owner', repo: 'repo' });
  });

  it('pins default branch to SHA and never forwards GitHub credentials to archive origin', async () => {
    const events: CodeReviewAuditEvent[] = [];
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const sha = 'a'.repeat(40);
    const archive = buildZip([{ name: 'owner-repo-abc/a.ts', data: 'code' }]);
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (calls.length === 1) return Response.json({ default_branch: 'develop' });
      if (calls.length === 2) return Response.json({ sha });
      if (calls.length === 3) return new Response(null, { status: 302, headers: { location: `https://codeload.github.com/owner/repo/legacy.zip/${sha}` } });
      return new Response(new Uint8Array(archive));
    }) as typeof fetch;
    const result = await fetchCodeReviewGithubSnapshot({ githubUrl: 'https://github.com/owner/repo', token: 'private-token',
      signal: new AbortController().signal, audit: async (event) => { events.push(event); }, fetchImpl });
    expect(result.commitSha).toBe(sha);
    expect(calls[1].url).toMatch(/commits\/develop$/);
    expect(calls[2].url).toMatch(new RegExp(`/zipball/${sha}$`));
    expect(calls[2].init?.headers).toHaveProperty('Authorization', 'Bearer private-token');
    expect(calls[3].init?.headers).not.toHaveProperty('Authorization');
    expect(JSON.stringify(events)).not.toContain('private-token');
  });

  it('rejects archive redirects to arbitrary targets', async () => {
    let count = 0;
    const fetchImpl = (async () => ++count === 1 ? Response.json({ default_branch: 'main' }) : count === 2
      ? Response.json({ sha: 'a'.repeat(40) }) : new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/metadata' } })) as typeof fetch;
    await expect(fetchCodeReviewGithubSnapshot({ githubUrl: 'https://github.com/a/b', signal: new AbortController().signal,
      audit: async () => {}, fetchImpl })).rejects.toThrow(/不允许/);
    expect(count).toBe(3);
  });

  it.each([
    { redirect: false, status: 403, reason: 'Repository access blocked by policy' },
    { redirect: true, status: 502, reason: 'Archive upstream unavailable' },
  ])('retains redacted failure body and request identity for snapshot HTTP $status', async ({ redirect, status, reason }) => {
    const events: CodeReviewAuditEvent[] = []; let count = 0;
    const fetchImpl = (async () => {
      if (++count === 1) return Response.json({ default_branch: 'main' });
      if (count === 2) return Response.json({ sha: 'a'.repeat(40) });
      if (redirect && count === 3) return new Response(null, { status: 302, headers: { location: 'https://codeload.github.com/a/b/zip/main' } });
      return Response.json({ message: reason, password: 'private-password', email: 'private@example.com', authorization: 'Bearer private-token' },
        { status, headers: { 'x-request-id': 'snapshot-denied-request' } });
    }) as typeof fetch;
    await expect(fetchCodeReviewGithubSnapshot({ githubUrl: 'https://github.com/a/b', token: 'private-token',
      signal: new AbortController().signal, audit: async event => { events.push(event); }, fetchImpl })).rejects.toThrow(`HTTP ${status}`);
    const failure = events.at(-1)!;
    expect(failure).toMatchObject({ operation: 'github.download_snapshot', status, outcome: 'http_error', truncated: false,
      upstreamRequestId: 'snapshot-denied-request' });
    expect(failure.evidence).toContain(reason); expect(failure.responseBytes).toBeGreaterThan(0);
    for (const secret of ['private-token', 'private-password', 'private@example.com']) expect(JSON.stringify(events)).not.toContain(secret);
  });
  it('bounds and cancels oversized failed snapshot evidence while retaining the upstream reason', async () => {
    const events: CodeReviewAuditEvent[] = []; let count = 0, cancelled = false;
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode('Archive access denied ' + 'x'.repeat(20_000)));
    }, cancel() { cancelled = true; } });
    const fetchImpl = (async () => ++count === 1 ? Response.json({ default_branch: 'main' }) : count === 2
      ? Response.json({ sha: 'a'.repeat(40) }) : new Response(body, { status: 403 })) as typeof fetch;
    await expect(fetchCodeReviewGithubSnapshot({ githubUrl: 'https://github.com/a/b', signal: new AbortController().signal,
      audit: async event => { events.push(event); }, fetchImpl })).rejects.toThrow('HTTP 403');
    const failure = events.at(-1)!;
    expect(failure.truncated).toBe(true); expect(failure.evidence.length).toBeLessThanOrEqual(4096);
    expect(failure.evidence).toContain('Archive access denied'); expect(cancelled).toBe(true);
    expect(JSON.parse(failure.evidence.split('\n')[0])).toMatchObject({ capturedBytes: 8192, bodyReadFailed: false });
  });
  it('keeps received failure-body evidence when the error response stream itself fails', async () => {
    const events: CodeReviewAuditEvent[] = []; let count = 0, pulls = 0;
    const body = new ReadableStream<Uint8Array>({ pull(controller) {
      if (++pulls === 1) controller.enqueue(new TextEncoder().encode('Archive unavailable before stream ended'));
      else controller.error(new Error('private-reader-exception'));
    } });
    const fetchImpl = (async () => ++count === 1 ? Response.json({ default_branch: 'main' }) : count === 2
      ? Response.json({ sha: 'a'.repeat(40) }) : new Response(body, { status: 503 })) as typeof fetch;
    await expect(fetchCodeReviewGithubSnapshot({ githubUrl: 'https://github.com/a/b', signal: new AbortController().signal,
      audit: async event => { events.push(event); }, fetchImpl })).rejects.toThrow('HTTP 503');
    expect(events.at(-1)).toMatchObject({ outcome: 'http_error', status: 503, truncated: true });
    expect(events.at(-1)!.evidence).toContain('Archive unavailable before stream ended');
    expect(JSON.parse(events.at(-1)!.evidence.split('\n')[0])).toMatchObject({ bodyReadFailed: true });
    expect(JSON.stringify(events)).not.toContain('private-reader-exception');
  });
});
