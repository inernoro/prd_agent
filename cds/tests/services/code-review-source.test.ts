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

describe('code review source snapshots', () => {
  it('preserves real source directory paths when a sanitized snapshot is checked again', async () => {
    const first = await validateCodeReviewZip(buildZip([{ name: 'repository/src/a.ts', data: 'const a = 1' }]));
    const second = await readCodeReviewSnapshot(first.zip);
    expect(second.files.map((file) => file.name)).toEqual(['src/a.ts']);
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
});
