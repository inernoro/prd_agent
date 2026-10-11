import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StateService } from '../../src/services/state.js';
import { AcceptanceResourceRunService } from '../../src/services/acceptance-resource-run.js';
import { createReportsRouter } from '../../src/routes/reports.js';

describe('P5-05 real report producer binds registered resource ownership', () => {
  let dir: string, state: StateService, server: http.Server, ledger: AcceptanceResourceRunService;
  const sha = 'a'.repeat(40);
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-owned-report-'));
    state = new StateService(path.join(dir, 'state.json')); state.load();
    state.addProject({ id: 'p1', slug: 'owned', name: 'owned' } as any);
    ledger = new AcceptanceResourceRunService(state);
    const app = express();
    // Trusted auth stamps: actual server authentication is a separate execution group.
    app.use((req, _res, next) => {
      const key = req.header('x-test-project');
      if (key) (req as any).cdsProjectKey = { projectId: key, keyId: 'owned' };
      const projects = req.header('x-test-global');
      if (projects !== undefined) (req as any).cdsAccess = { keyId: 'global', access: { projects: projects ? projects.split(',') : [], canCreateProjects: true } };
      next();
    });
    app.use('/api', createReportsRouter({ stateService: state }));
    server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  });
  afterEach(async () => {
    vi.restoreAllMocks(); await new Promise<void>(resolve => server.close(() => resolve()));
    await state.flush(); fs.rmSync(dir, { recursive: true, force: true });
  });
  function post(body: unknown, headers: Record<string, string> = {}, raw?: string) {
    return new Promise<{ status: number; body: any; raw: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
      const payload = raw ?? JSON.stringify(body);
      const req = http.request({ host: '127.0.0.1', port: (server.address() as any).port, path: '/api/reports', method: 'POST', agent: false,
        headers: { 'content-type': 'application/json', ...headers, 'content-length': Buffer.byteLength(payload) } }, res => {
        let raw = ''; res.setEncoding('utf8'); res.on('data', chunk => { raw += chunk; });
        res.on('end', () => { resolve({ status: res.statusCode!, body: JSON.parse(raw), raw, headers: res.headers }); });
      });
      req.setTimeout(5000, () => req.destroy(new Error('owned report HTTP deadline'))); req.on('error', reject); req.end(payload);
    });
  }
  async function owner(index = 0, register = true) {
    const branchId = 'b' + index, profileId = 'init' + index, isolationRunId = 'owned_run_' + index;
    state.addBranch({ id: branchId, projectId: 'p1', branch: 'owned/' + index, worktreePath: dir, createdAt: '2026-10-10T00:00:00.000Z', status: 'idle', services: {} });
    const o = await ledger.begin({ projectId: 'p1', branchId, profileId, isolationRunId, targetSha: sha });
    const b = state.getBranch(branchId)!;
    b.extraProfiles = [{ id: profileId, projectId: 'p1', env: { IMP_HEALTH_RUN_ID: isolationRunId, IMP_TARGET_SHA: sha } } as any];
    b.services[profileId] = { profileId, containerId: index.toString(16).padStart(64, '0'), containerName: profileId, hostPort: 10000 + index, status: 'running', deployedCommitSha: sha };
    state.addDeploymentRun({ id: 'dr_' + index, projectId: 'p1', branchId, commitSha: sha, status: 'running', startedAt: new Date(Date.parse(o.run.startedAt) + 1000).toISOString(), seq: 1, events: [] } as any);
    if (register) await ledger.register(o.run.id, o.ownerToken);
    return { ...o, body: { title: 'owned producer', format: 'md', content: '# actual report body', verdict: 'fail', projectId: 'p1', branchId,
      commitSha: sha, acceptanceRunId: o.run.id, acceptanceOwnerToken: o.ownerToken } };
  }
  it('archives exact binding, reads actual file, finishes separately and never stores capability', async () => {
    const o = await owner(); const r = await post(o.body, { 'x-test-project': 'p1' });
    expect(r.status).toBe(201); expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body.report).toMatchObject({ acceptanceRunId: o.run.id, projectId: 'p1', branchId: 'b0', commitSha: sha, verdict: 'fail' });
    expect(await state.readAcceptanceReportContentAsync(r.body.report.id)).toBe(o.body.content);
    expect(ledger.get(o.run.id)?.stage).toBe('registered');
    expect((await ledger.finish(o.run.id, o.ownerToken, r.body.report.id)).stage).toBe('finished');
    expect(r.raw + fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).not.toContain(o.ownerToken);
  });
  it.each(['project', 'global', 'create-only'])('rejects %s foreign scope before checking capability', async kind => {
    const o = await owner(); const r = await post({ ...o.body, acceptanceOwnerToken: 'f'.repeat(64) }, kind === 'project' ? { 'x-test-project': 'p2' } : { 'x-test-global': kind === 'global' ? 'p2' : '' });
    expect(r.status).toBe(403); expect(r.body.error).toBe(kind === 'project' ? 'project_mismatch' : 'project_out_of_scope');
    expect(state.listAcceptanceReports()).toHaveLength(0);
  });
  it.each([
    ['acceptanceOwnerToken', 'f'.repeat(64), 403], ['acceptanceOwnerToken', undefined, 400], ['acceptanceRunId', '', 400],
    ['commitSha', 'aaaaaaa', 400], ['commitSha', 'b'.repeat(40), 409], ['branchId', 'missing', 409],
    ['projectId', 'owned', 409], ['verdict', 'PASS', 400], ['verdict', undefined, 400],
  ])('does not downgrade invalid bound %s=%s', async (key, value, status) => {
    const o = await owner(); const r = await post({ ...o.body, [key]: value });
    expect(r.status).toBe(status); expect(state.listAcceptanceReports()).toHaveLength(0);
    expect(ledger.get(o.run.id)?.stage).toBe('registered');
  });
  it('rejects active run and preserves ordinary unbound report compatibility', async () => {
    const o = await owner(0, false); expect((await post(o.body)).status).toBe(409);
    const r = await post({ title: 'ordinary', format: 'md', content: 'ordinary', projectId: 'missing', branchId: 'missing' });
    expect(r.status).toBe(201); expect(r.body.report.projectId).toBeNull(); expect(r.body.report.acceptanceRunId).toBeUndefined();
  });
  it.each(['normalize', 'archive'])('rechecks original resource after %s IO; no successful terminal qualification', async kind => {
    const o = await owner(); let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }); const waiting = new Promise<void>(resolve => { entered = resolve; });
    if (kind === 'normalize') {
      const original = state.writeReportAssetAsync.bind(state);
      vi.spyOn(state, 'writeReportAssetAsync').mockImplementation(async (...args) => { entered(); await gate; return original(...args); });
      o.body.content = '![test](data:image/png;base64,iVBORw0KGgo=)';
    } else {
      const original = state.createAcceptanceReportAsync.bind(state);
      vi.spyOn(state, 'createAcceptanceReportAsync').mockImplementation(async (...args) => { entered(); await gate; return original(...args); });
    }
    const pending = post(o.body); await waiting;
    state.getBranch('b0')!.services.init0.containerId = 'e'.repeat(64);
    release(); const r = await pending;
    expect(r.status).toBe(409); expect(r.body.error).toBe('acceptance_resource_changed');
    expect(ledger.get(o.run.id)?.stage).toBe('registered');
    if (kind === 'normalize') expect(state.listAcceptanceReports()).toHaveLength(0);
  });
  it('binds multipart fields without persisting owner capability', async () => {
    const o = await owner(); const boundary = 'owned-boundary';
    const raw = Object.entries(o.body).map(([key, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`).join('') + `--${boundary}--\r\n`;
    const r = await post({}, { 'content-type': 'multipart/form-data; boundary=' + boundary }, raw);
    expect(r.status).toBe(201); expect(r.body.report.acceptanceRunId).toBe(o.run.id);
    expect((await ledger.finish(o.run.id, o.ownerToken, r.body.report.id)).stage).toBe('finished');
    expect(r.raw + fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).not.toContain(o.ownerToken);
  });
  it.each(['branch', 'record'])('rejects equivalent %s replacement during archive IO', async kind => {
    const o = await owner(); let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }); const waiting = new Promise<void>(resolve => { entered = resolve; });
    const original = state.createAcceptanceReportAsync.bind(state);
    vi.spyOn(state, 'createAcceptanceReportAsync').mockImplementation(async (...args) => { entered(); await gate; return original(...args); });
    const pending = post(o.body); await waiting;
    if (kind === 'branch') state.getState().branches.b0 = structuredClone(state.getBranch('b0')!);
    else state.getState().acceptanceResourceRuns![o.run.id] = structuredClone(state.getState().acceptanceResourceRuns![o.run.id]);
    release(); const r = await pending;
    expect(r.status).toBe(409); expect(r.body.error).toBe(kind === 'branch' ? 'acceptance_branch_changed' : 'acceptance_run_conflict');
    expect(ledger.get(o.run.id)?.stage).toBe('registered');
  });
  it('bounds unknown archive errors without disclosing capability or storage', async () => {
    const o = await owner(); vi.spyOn(state, 'createAcceptanceReportAsync').mockRejectedValueOnce(new Error('/private/storage ' + o.ownerToken));
    const r = await post(o.body); expect(r.status).toBe(500); expect(r.body).toEqual({ error: 'internal' });
    expect(r.raw).not.toContain(o.ownerToken); expect(ledger.get(o.run.id)?.stage).toBe('registered');
  });
  it('waits for report metadata ACK before 201 and survives a fresh State loader', async () => {
    const o = await owner(); let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const original = state.flush.bind(state); let calls = 0;
    vi.spyOn(state, 'flush').mockImplementation(async () => { calls++; await gate; return original(); });
    let response: unknown; const pending = post(o.body).then(result => { response = result; return result; });
    await new Promise(resolve => setTimeout(resolve, 40)); const before = response, held = calls;
    release(); const r = await pending;
    expect(before).toBeUndefined(); expect(held).toBe(1); expect(r.status).toBe(201);
    const restored = new StateService(path.join(dir, 'state.json')); restored.load();
    expect(restored.getAcceptanceReport(r.body.report.id)).toMatchObject({ acceptanceRunId: o.run.id, commitSha: sha });
    expect(await restored.readAcceptanceReportContentAsync(r.body.report.id)).toBe(o.body.content);
    expect(new AcceptanceResourceRunService(restored).get(o.run.id)?.stage).toBe('registered'); await restored.flush();
  });
  it.each(['resource', 'metadata'])('rechecks %s while metadata ACK is held', async kind => {
    const o = await owner(); let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const original = state.flush.bind(state); let calls = 0;
    vi.spyOn(state, 'flush').mockImplementation(async () => { calls++; await gate; return original(); });
    let response: unknown; const pending = post(o.body).then(result => { response = result; return result; });
    await new Promise(resolve => setTimeout(resolve, 40));
    const held = calls, before = response;
    if (kind === 'resource') state.getBranch('b0')!.services.init0.containerId = 'd'.repeat(64);
    else state.getState().acceptanceReports![0].title = 'replaced during ACK';
    release(); const r = await pending;
    expect(before).toBeUndefined(); expect(held).toBe(1); expect(r.status).toBe(409);
    expect(r.body.error).toBe(kind === 'resource' ? 'acceptance_resource_changed' : 'acceptance_report_changed');
    expect(ledger.get(o.run.id)?.stage).toBe('registered');
  });
  it('does not return 201 after a real report metadata disk failure', async () => {
    const o = await owner(); fs.rmSync(path.join(dir, 'state.json')); fs.mkdirSync(path.join(dir, 'state.json'));
    const r = await post(o.body); fs.rmSync(path.join(dir, 'state.json'), { recursive: true }); state.save(); await state.flush();
    expect(r.status).toBe(500); expect(r.body).toEqual({ error: 'internal' }); expect(ledger.get(o.run.id)?.stage).toBe('registered');
  });
  it('shares eight-operation budget with receipt services and rejects same-run overlap without queueing', async () => {
    const owners = []; for (let i = 0; i < 9; i++) owners.push(await owner(i));
    const original = state.createAcceptanceReportAsync.bind(state); let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }); let calls = 0;
    vi.spyOn(state, 'createAcceptanceReportAsync').mockImplementation(async (...args) => { calls++; await gate; return original(...args); });
    const requests = owners.slice(0, 8).map(o => post(o.body).catch(error => ({ error }))); 
    while (calls < 8) await new Promise(resolve => setTimeout(resolve, 2));
    const ninthRequest = post(owners[8].body);
    let ninth: any, overlap: unknown;
    try { ninth = await Promise.race([ninthRequest, new Promise(resolve => setTimeout(() => resolve('unexpectedly queued'), 80))]); overlap = await ledger.finish(owners[0].run.id, owners[0].ownerToken, 'missing').catch(e => e.message); }
    finally { release(); }
    await Promise.all([...requests, ninthRequest]); expect(ninth!.status).toBe(429); expect(ninth!.body.error).toBe('acceptance_operation_capacity');
    expect(overlap).toBe('acceptance_run_busy'); expect(calls).toBe(8);
  });
});
