import { describe, expect, it, vi } from 'vitest';
import { GitHubAppClient, type FetchLike } from '../../src/services/github-app-client.js';
const target = { installationId: 1, repository: 'owner/repo', branch: 'feature/x', headSha: 'a'.repeat(40) };
const rawRun = { id: 123, run_attempt: 2, path: '.github/workflows/branch-image.yml', event: 'push', head_sha: target.headSha, head_branch: target.branch, repository: { full_name: target.repository }, head_repository: { full_name: target.repository } };
const jobs = { total_count: 1, jobs: [{ id: 4, run_id: 123, run_attempt: 2, head_sha: target.headSha, status: 'completed', conclusion: 'success', created_at: '2026-10-11T00:00:00Z', started_at: '2026-10-11T00:00:10Z', completed_at: '2026-10-11T00:00:30Z', secret: 'DO_NOT_COPY' }] };
function client(fetch: FetchLike) { const c = new GitHubAppClient({ appId: '1', privateKey: '', fetchImpl: fetch }); vi.spyOn(c, 'getInstallationToken').mockResolvedValue('PRIVATE_TOKEN'); return c; }
function response(raw: unknown) { return { ok: true, status: 200, statusText: 'OK', json: async () => raw, text: async () => JSON.stringify(raw) }; }
describe('bounded exact GitHub attempt timing source', () => {
  it('selects only dedicated workflow and explicit attempt jobs with a shared deadline signal', async () => {
    const fetch = vi.fn(async (url: string) => response(url.includes('/jobs?') ? jobs : { total_count: 1, workflow_runs: [rawRun] }));
    const c = client(fetch); const signal = new AbortController().signal;
    const value = await c.getCiTiming(target, signal);
    expect(value).toMatchObject({ runId: 123, runAttempt: 2, headBranch: 'feature/x' });
    expect(fetch.mock.calls[0][0]).toContain('/actions/workflows/branch-image.yml/runs?');
    expect(fetch.mock.calls[0][0]).toContain('head_sha='+target.headSha); expect(fetch.mock.calls[0][0]).toContain('branch=feature%2Fx');
    expect(fetch.mock.calls[1][0]).toContain('/actions/runs/123/attempts/2/jobs?per_page=100');
    expect(c.getInstallationToken).toHaveBeenCalledWith(1, signal);
    expect(JSON.stringify(value)).not.toContain('PRIVATE_TOKEN'); expect(JSON.stringify(value)).not.toContain('DO_NOT_COPY');
  });
  it('refuses other-workflow and fork run instead of querying its jobs', async () => {
    const fetch = vi.fn(async () => response({ workflow_runs: [{ ...rawRun, head_repository: { full_name: 'fork/repo' } }] }));
    expect(await client(fetch).getCiTiming(target)).toBeNull(); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('bounds both run and jobs response bytes and contains permission/provider errors', async () => {
    for (const raw of ['x'.repeat(262145), null]) {
      const c = client(async () => raw === null ? { ...response({ secret: 'TOKEN' }), ok: false, status: 403 } : { ...response(''), text: async () => raw });
      expect(await c.getCiTiming(target)).toBeNull();
    }
    expect(await client(async () => { throw Error('PRIVATE_TOKEN'); }).getCiTiming(target)).toBeNull();
  });
  it('stops streamed oversized bodies without parsing or reading remaining chunks', async () => {
    let reads = 0, cancelled = false;
    const reader = { read: async () => { reads++; return { done: false, value: new Uint8Array(200000) }; }, cancel: async () => { cancelled = true; }, releaseLock: () => {} };
    const c = client(async () => ({ ...response({}), body: { getReader: () => reader } }));
    expect(await c.getCiTiming(target)).toBeNull(); expect(reads).toBe(2); expect(cancelled).toBe(true);
  });
  it('uses maximum exact run id from at most twenty candidates regardless of array order; duplicate ambiguity is unknown', async () => {
    for (const reversed of [false, true]) {
      const candidates = [{ ...rawRun, id: 100 }, { ...rawRun, id: 123 }]; if (reversed) candidates.reverse();
      const fetch = vi.fn(async (url: string) => response(url.includes('/jobs?') ? jobs : { workflow_runs: candidates }));
      expect((await client(fetch).getCiTiming(target))?.runId).toBe(123); expect(fetch.mock.calls[0][0]).toContain('per_page=20');
    }
    for (const candidates of [[rawRun, { ...rawRun, run_attempt: 3 }], Array.from({ length: 21 }, (_, n) => ({ ...rawRun, id: n+1 }))]) {
      const fetch = vi.fn(async () => response({ workflow_runs: candidates })); expect(await client(fetch).getCiTiming(target)).toBeNull(); expect(fetch).toHaveBeenCalledTimes(1);
    }
  });
  it('pins error redirect policy on every credentialed source request', async () => {
    const fetch = vi.fn(async (url: string) => response(url.includes('/jobs?') ? jobs : { workflow_runs: [rawRun] }));
    const c = client(fetch); await c.getCiTiming(target);
    expect((fetch.mock.calls as any[]).every(([, init]) => init.redirect === 'error')).toBe(true);
  });
  it('does not start HTTP after cancellation while token acquisition was pending', async () => {
    const fetch = vi.fn(async () => response({})); const c = client(fetch), controller = new AbortController();
    let token!: (v: string) => void; vi.mocked(c.getInstallationToken).mockImplementation(() => new Promise(r => { token = r; }));
    const pending = c.getCiTiming(target, controller.signal); controller.abort(); token('PRIVATE_TOKEN');
    expect(await pending).toBeNull(); expect(fetch).not.toHaveBeenCalled();
  });
});
