import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StateService } from '../../src/services/state.js';
import { AcceptanceResourceRunService } from '../../src/services/acceptance-resource-run.js';

describe('P5-05 owned HTTP project authorization and receipt chain', () => {
  let dir: string, state: StateService, server: http.Server, ledger: AcceptanceResourceRunService;
  const targetSha = 'a'.repeat(40);
  const input = { projectId: 'p1', branchId: 'b1', profileId: 'owned-init', targetSha, isolationRunId: 'owned_run' };
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-acceptance-http-'));
    state = new StateService(path.join(dir, 'state.json')); state.load();
    state.addProject({ id: 'p1', slug: 'p1', name: 'owned' } as any);
    state.addBranch({ id: 'b1', projectId: 'p1', branch: 'owned/receipt', worktreePath: dir, createdAt: '2026-10-10T00:00:00.000Z', services: {}, status: 'idle' });
    ledger = new AcceptanceResourceRunService(state);
    const app = express();
    // Trusted stamps exercise project authorization, not actual login/key authentication.
    app.use((req, _res, next) => {
      const projectId = req.header('x-test-project');
      if (projectId) (req as any).cdsProjectKey = { projectId, keyId: 'owned-key' };
      const projects = req.header('x-test-global');
      if (projects !== undefined) (req as any).cdsAccess = { keyId: 'global', access: { projects: projects ? projects.split(',') : [], canCreateProjects: true } };
      next();
    });
    // Missing old route returns real HTTP 404, rather than using an import failure as the feature red.
    const routePath = '../../src/routes/acceptance-resource-runs.js';
    let router = express.Router();
    try { const module = await import(routePath); router = module.createAcceptanceResourceRunsRouter({ stateService: state }); }
    catch (error) { if (fs.existsSync(path.join(process.cwd(), 'src/routes/acceptance-resource-runs.ts'))) throw error; }
    app.use('/api', router);
    server = app.listen(0); await new Promise<void>(resolve => server.once('listening', resolve));
  });
  afterEach(async () => {
    vi.restoreAllMocks(); await new Promise<void>(resolve => server.close(() => resolve()));
    await state.flush(); fs.rmSync(dir, { recursive: true, force: true });
  });
  function request(method: string, route: string, body?: unknown, headers: Record<string, string> = {}) {
    return new Promise<{ status: number; body: any; raw: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
      const data = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
      const req = http.request({ host: '127.0.0.1', port: (server.address() as any).port, path: '/api' + route, method, agent: false,
        headers: { ...headers, ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}) } }, res => {
        let raw = ''; res.setEncoding('utf8'); res.on('data', chunk => { raw += chunk; });
        res.on('end', () => { let body: any; try { body = JSON.parse(raw); } catch { body = null; } resolve({ status: res.statusCode!, body, raw, headers: res.headers }); });
      });
      req.setTimeout(5000, () => req.destroy(new Error('owned HTTP deadline'))); req.on('error', reject); if (data) req.write(data); req.end();
    });
  }
  it('executes begin/register/real report/finish/readback/cleanup prerequisite over HTTP', async () => {
    const begun = await request('POST', '/acceptance-resource-runs', input, { 'x-test-project': 'p1' });
    expect(begun.status).toBe(201); expect(begun.headers['cache-control']).toBe('no-store');
    const owner = begun.body; expect(owner.ownerToken).toMatch(/^[a-f0-9]{64}$/);
    expect(owner.run.stage).toBe('active'); expect(state.getBranch('b1')!.extraProfiles).toBeUndefined();
    const b = state.getBranch('b1')!;
    b.extraProfiles = [{ id: input.profileId, projectId: 'p1', env: { IMP_HEALTH_RUN_ID: input.isolationRunId, IMP_TARGET_SHA: targetSha, SECRET: 'private-env' } } as any];
    b.services[input.profileId] = { profileId: input.profileId, containerId: 'b'.repeat(64), containerName: 'owned-container', hostPort: 10000, status: 'running', deployedCommitSha: targetSha };
    state.addDeploymentRun({ id: 'dr_owned', projectId: 'p1', branchId: 'b1', commitSha: targetSha, status: 'running', startedAt: new Date(Date.parse(owner.run.startedAt) + 1000).toISOString(), events: [], seq: 1 } as any);
    expect((await request('POST', `/acceptance-resource-runs/${owner.run.id}/register`, { ownerToken: owner.ownerToken })).status).toBe(200);
    const meta = await state.createAcceptanceReportAsync({ title: 'owned report', format: 'md', content: 'actual report file', projectId: 'p1', branchId: 'b1', commitSha: targetSha, acceptanceRunId: owner.run.id, verdict: 'fail' });
    expect((await request('POST', `/acceptance-resource-runs/${owner.run.id}/finish`, { ownerToken: owner.ownerToken, reportId: meta.id })).body.run.stage).toBe('finished');
    const read = await request('GET', `/acceptance-resource-runs/${owner.run.id}`);
    expect(read.body.run.stage).toBe('finished'); expect(read.raw).not.toMatch(/ownerHash|ownerToken|private-env/);
    const cleanup = await request('POST', `/acceptance-resource-runs/${owner.run.id}/cleanup-evidence`, { ownerToken: owner.ownerToken });
    expect(cleanup.status).toBe(200); expect(cleanup.body.daemonVerificationRequired).toBe(true);
    expect(b.services[input.profileId].containerId).toBe('b'.repeat(64));
    expect(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).not.toContain(owner.ownerToken);
    const restored = new StateService(path.join(dir, 'state.json')); restored.load(); await restored.flush();
    expect(new AcceptanceResourceRunService(restored).get(owner.run.id)?.stage).toBe('finished');
  });
  it.each(['project', 'global', 'create-only'])('enforces %s scope before capability for GET and every transition', async kind => {
    const owner = await ledger.begin(input);
    const headers: Record<string, string> = kind === 'project' ? { 'x-test-project': 'p2' } : { 'x-test-global': kind === 'global' ? 'p2' : '' };
    for (const suffix of ['', '/register', '/finish', '/cleanup-evidence']) {
      const r = await request(suffix ? 'POST' : 'GET', '/acceptance-resource-runs/' + owner.run.id + suffix, { ownerToken: owner.ownerToken, reportId: 'missing' }, headers);
      expect(r.status).toBe(403); expect(r.raw).not.toContain(owner.ownerToken);
    }
    expect(ledger.get(owner.run.id)?.stage).toBe('active');
  });
  it('rejects foreign begin even with fake actor headers, short SHA, and unknown project', async () => {
    expect((await request('POST', '/acceptance-resource-runs', input, { 'x-test-project': 'p2', 'x-cds-actor': 'owner' })).status).toBe(403);
    expect((await request('POST', '/acceptance-resource-runs', { ...input, targetSha: 'aaaaaaa' }, { 'x-test-global': 'p1' })).status).toBe(400);
    expect((await request('POST', '/acceptance-resource-runs', { ...input, projectId: 'missing' })).status).toBe(404);
    expect(state.getState().acceptanceResourceRuns).toBeUndefined();
  });
  it('rejects foreign capability, missing resource, and premature cleanup', async () => {
    const owner = await ledger.begin(input);
    expect((await request('POST', `/acceptance-resource-runs/${owner.run.id}/register`, { ownerToken: 'f'.repeat(64) })).status).toBe(403);
    expect((await request('POST', `/acceptance-resource-runs/${owner.run.id}/register`, { ownerToken: owner.ownerToken })).status).toBe(409);
    const cleanup = await request('POST', `/acceptance-resource-runs/${owner.run.id}/cleanup-evidence`, { ownerToken: owner.ownerToken });
    expect(cleanup.status).toBe(409); expect(cleanup.body.error).toBe('acceptance_terminal_receipt_required');
    expect(ledger.get(owner.run.id)?.stage).toBe('active');
  });
  it('does not expose storage paths or secrets for unexpected publication failure', async () => {
    vi.spyOn(state, 'writeAcceptanceResourceRunDurably').mockRejectedValueOnce(new Error('secret-token /private/storage/failed'));
    const r = await request('POST', '/acceptance-resource-runs', input);
    expect(r.status).toBe(500); expect(r.body).toEqual({ error: 'internal' }); expect(r.raw).not.toMatch(/secret-token|private\/storage/);
  });
  it('bounds parser failures without reflecting owner capability or parser stack', async () => {
    const oversized = await request('POST', '/acceptance-resource-runs', { ...input, ownerToken: 'sensitive-capability'.repeat(200) });
    expect(oversized.status).toBe(413); expect(oversized.body).toEqual({ error: 'acceptance_payload_too_large' });
    const malformed = await request('POST', '/acceptance-resource-runs', '{"ownerToken":"sensitive-capability"');
    expect(malformed.status).toBe(400); expect(malformed.body).toEqual({ error: 'acceptance_payload_invalid' });
    expect(oversized.raw + malformed.raw).not.toMatch(/sensitive-capability|SyntaxError|PayloadTooLargeError/);
  });
});
