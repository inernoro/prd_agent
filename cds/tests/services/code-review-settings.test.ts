import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { Server } from 'node:http';
import { StateService } from '../../src/services/state.js';
import { CodeReviewService } from '../../src/services/code-review.js';
import { createCodeReviewsRouter } from '../../src/routes/code-reviews.js';
import { currentCodeReviewEngineBinding, resolveCodeReviewEngineConfig } from '../../src/services/code-review-settings.js';
import { buildZip } from '../../src/utils/zip.js';

describe('持久化审查引擎绑定', () => {
  let dir: string, state: StateService, service: CodeReviewService, server: Server, base: string;
  const binding = { engineProjectId: 'engine', engineBaseUrl: 'http://deepaudit.internal:8000' };
  const runtimeBinding = { ...binding, engineBranchId: 'engine-branch', engineServiceId: 'backend' };
  const account = { CDS_SERVICE_EMAIL: 'cds-service@example.invalid', CDS_SERVICE_PASSWORD: 'private-service-password' };
  beforeEach(async () => {
    vi.stubEnv('CDS_DEEPAUDIT_BASE_URL', ''); vi.stubEnv('CDS_DEEPAUDIT_TOKEN', '');
    vi.stubEnv('CDS_DEEPAUDIT_USERNAME', ''); vi.stubEnv('CDS_DEEPAUDIT_PASSWORD', '');
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cds-review-settings-'));
    vi.stubEnv('CDS_CACHE_BASE', path.join(dir, 'cache'));
    state = new StateService(path.join(dir, 'state.json')); state.load();
    for (const id of ['source', 'engine', 'other']) state.addProject({ id, name: id, slug: id, kind: 'manual', dockerNetwork: `cds-${id}`,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    state.setCustomEnv(account, 'engine');
    for (const [id, projectId] of [['engine-branch', 'engine'], ['other-branch', 'other']]) state.addBranch({
      id, projectId, branch: 'main', worktreePath: path.join(dir, id), status: 'running', createdAt: new Date().toISOString(),
      services: { backend: { profileId: 'backend', containerName: `${id}-backend`, hostPort: 47391, status: 'running' } },
    });
    const blobs = new Map<string, Buffer>();
    const reports = new Map<string, string>();
    state.setReportObjectStore({ isConfigured: () => true,
      put: async (meta, content) => { reports.set(meta.id, content); return meta.id; },
      get: async (key) => reports.get(key) ?? null, remove: async (key) => { reports.delete(key); } });
    service = new CodeReviewService({ state, autoStart: false, publicBaseUrl: 'https://cds.example', ownerScope: 'settings-test',
      inputs: { configured: () => true, put: async (id, _projectId, zip) => { blobs.set(id, zip); return id; }, get: async (id) => blobs.get(id)! },
      mail: { configured: () => false, send: vi.fn() } });
    const app = express();
    // Model trusted auth middleware stamps; user-supplied JSON never controls these fields.
    app.use((req, _res, next) => {
      const auth = req as unknown as Record<string, unknown>;
      switch (req.get('x-auth')) {
        case 'project': auth.cdsProjectKey = { projectId: 'engine', keyId: 'project-key' }; break;
        case 'scoped': auth.cdsAccess = { keyId: 'scoped-key', access: { projects: ['engine'] } }; break;
        case 'create-only': auth.cdsAccess = { keyId: 'create-key', access: { projects: [] } }; break;
        case 'all': auth.cdsAccess = { keyId: 'all-key', access: { projects: 'all' } }; break;
        case 'member': auth.cdsUser = { isSystemOwner: false }; auth.cdsSession = {}; break;
        case 'sso': auth.cdsUser = { isSystemOwner: true, authProvider: 'sso' }; auth.cdsSession = {}; break;
        case 'unverified': auth.cdsUser = { isSystemOwner: true }; break;
        case 'owner': auth.cdsUser = { isSystemOwner: true, authProvider: 'local' }; auth.cdsSession = {}; break;
      }
      next();
    });
    app.use('/api', createCodeReviewsRouter({ state, service }));
    server = await new Promise<Server>((resolve) => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/code-reviews`;
  });
  afterEach(async () => {
    service.stop(); await new Promise<void>((resolve) => server.close(() => resolve()));
    await state.flush(); await fs.rm(dir, { recursive: true, force: true });
    vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  });
  const put = (auth = 'bootstrap', body: unknown = binding) => fetch(`${base}/settings`, {
    method: 'PUT', headers: { 'content-type': 'application/json', 'x-auth': auth }, body: JSON.stringify(body),
  });
  it.each(['project', 'scoped', 'create-only', 'member', 'sso', 'unverified'])('%s 不能读取或修改系统引擎配置', async (auth) => {
    expect((await fetch(`${base}/settings`, { headers: { 'x-auth': auth } })).status).toBe(403);
    expect((await put(auth)).status).toBe(403);
    expect(state.getCodeReviewSettings()).toBeUndefined();
  });
  it.each(['bootstrap', 'owner', 'all'])('%s 可保存引用且返回和持久化内容不包含凭据', async (auth) => {
    const pumping = vi.spyOn(service, 'pump').mockResolvedValue();
    const response = await put(auth);
    expect(response.status).toBe(200);
    const summary = await response.json();
    expect(summary).toEqual({ ...binding, engineConfigured: true });
    expect(JSON.stringify(summary)).not.toContain(account.CDS_SERVICE_PASSWORD);
    expect(JSON.stringify(summary)).not.toContain(account.CDS_SERVICE_EMAIL);
    expect(pumping).toHaveBeenCalledOnce();
    const read = await fetch(`${base}/settings`, { headers: { 'x-auth': auth } });
    expect(await read.json()).toEqual(summary);
    const reload = new StateService(path.join(dir, 'state.json')); reload.load();
    expect(reload.getCodeReviewSettings()).toEqual(binding);
    await reload.flush();
    const detached = state.getCodeReviewSettings()!; detached.engineProjectId = 'other';
    expect(state.getCodeReviewSettings()).toEqual(binding);
  });
  it.each([
    { ...binding, engineProjectId: 'missing' },
    { ...binding, engineProjectId: 'other' },
    { ...binding, engineBaseUrl: 'file:///etc/passwd' },
    { ...binding, engineBaseUrl: 'https://user:password@example.invalid' },
    { ...binding, engineBaseUrl: 'https://example.invalid?token=private' },
    { ...binding, engineBaseUrl: 'https://example.invalid#fragment' },
    { ...binding, engineBaseUrl: 'invalid' },
    { ...binding, password: 'client-supplied-secret' },
    { engineProjectId: 'engine' },
    { ...binding, engineBranchId: 'engine-branch' },
    { ...binding, engineServiceId: 'backend' },
    { ...runtimeBinding, engineBranchId: 'other-branch' },
    { ...runtimeBinding, engineBranchId: 'missing' },
    { ...runtimeBinding, engineServiceId: 'missing' },
  ])('拒绝无效或含凭据的绑定 %#', async (body) => {
    const response = await put('bootstrap', body);
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain('client-supplied-secret');
    expect(state.getCodeReviewSettings()).toBeUndefined();
  });
  it('有非终态任务时禁止切换，重复保存当前绑定可继续跟踪，取消后可切换', async () => {
    vi.spyOn(service, 'pump').mockResolvedValue();
    await put();
    await service.submit({ projectId: 'source', sourceType: 'zip', zip: buildZip([{ name: 'main.ts', data: Buffer.from('const value = 1;') }]), createdBy: 'test' });
    expect((await put('bootstrap', { ...binding, engineBaseUrl: 'http://different.internal' })).status).toBe(409);
    expect((await put('bootstrap', runtimeBinding)).status).toBe(409);
    expect((await put()).status).toBe(200);
    await service.cancel(service.list()[0].id);
    expect((await put('bootstrap', { ...binding, engineBaseUrl: 'http://different.internal' })).status).toBe(200);
  });
  it('分支服务引用归档和查询仅返回引用，不包含账号或运行资源凭据', async () => {
    const response = await put('owner', runtimeBinding);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ...runtimeBinding, engineConfigured: true });
    const read = await fetch(`${base}/settings`, { headers: { 'x-auth': 'owner' } });
    expect(await read.json()).toEqual({ ...runtimeBinding, engineConfigured: true });
    expect(state.getCodeReviewSettings()).toEqual(runtimeBinding);
  });
  it('部署端口改变后，新执行从资源台账解析当前地址，已排队任务不使用保存的旧 URL', async () => {
    await state.setCodeReviewSettings(runtimeBinding);
    const zip = buildZip([{ name: 'main.ts', data: Buffer.from('const value = 1;') }]);
    const submit = () => service.submit({ projectId: 'source', sourceType: 'zip', zip, createdBy: 'test' });
    const first = await submit();
    expect(resolveCodeReviewEngineConfig(state)?.baseUrl).toBe('http://127.0.0.1:47391');
    const hosts: string[] = [];
    const upstream = vi.fn(async (url: string, init?: RequestInit) => {
      hosts.push(new URL(url).origin);
      if (url.endsWith('/auth/login')) {
        expect((init?.body as URLSearchParams).get('password')).toBe(account.CDS_SERVICE_PASSWORD);
        return Response.json({ access_token: 'private-login-token' });
      }
      if (url.endsWith('/projects/')) return Response.json({ id: 'engine-project' });
      if (url.endsWith('/scan/upload-zip')) return Response.json({ task_id: 'engine-task' });
      if (url.endsWith('/issues')) return Response.json([]);
      return Response.json({ id: 'engine-task', status: 'completed', total_files: 1, scanned_files: 1 });
    });
    vi.stubGlobal('fetch', upstream);
    await service.pump();
    expect(service.get(first.id).status).toBe('completed');
    expect(new Set(hosts)).toEqual(new Set(['http://127.0.0.1:47391']));
    const queued = await submit();
    state.getBranch('engine-branch')!.services.backend.hostPort = 47425;
    hosts.length = 0;
    await service.pump();
    expect(service.get(queued.id).status).toBe('completed');
    expect(new Set(hosts)).toEqual(new Set(['http://127.0.0.1:47425']));
    expect(state.getCodeReviewSettings()?.engineBaseUrl).toBe(binding.engineBaseUrl);
    expect(JSON.stringify(service.list())).not.toContain(account.CDS_SERVICE_PASSWORD);
  });
  it.each(['stopped-service', 'stopped-branch', 'missing-service', 'missing-port', 'wrong-project', 'deleting-branch'])('动态引用 %s 不可用时禁止回退旧端口或环境引擎', async (failure) => {
    await state.setCodeReviewSettings(runtimeBinding);
    vi.stubEnv('CDS_DEEPAUDIT_BASE_URL', 'https://fallback.invalid'); vi.stubEnv('CDS_DEEPAUDIT_TOKEN', 'token');
    const branch = state.getBranch('engine-branch')!;
    if (failure === 'stopped-service') branch.services.backend.status = 'stopped';
    if (failure === 'stopped-branch') branch.status = 'idle';
    if (failure === 'missing-service') delete branch.services.backend;
    if (failure === 'missing-port') branch.services.backend.hostPort = 0;
    if (failure === 'wrong-project') branch.projectId = 'other';
    if (failure === 'deleting-branch') branch.deleting = true;
    expect(resolveCodeReviewEngineConfig(state)).toBeUndefined();
    expect(service.capabilities().engineConfigured).toBe(false);
  });
  it('保存和轮换账号后无需重启，实际任务以项目账号登录并完成归档', async () => {
    expect(service.capabilities().engineConfigured).toBe(false);
    await state.setCodeReviewSettings(binding);
    expect(service.capabilities().engineConfigured).toBe(true);
    const task = await service.submit({ projectId: 'source', sourceType: 'zip', zip: buildZip([{ name: 'main.ts', data: Buffer.from('const value = 1;') }]), createdBy: 'test' });
    const password = 'rotated-private-password';
    state.setCustomEnv({ ...account, CDS_SERVICE_PASSWORD: password }, 'engine');
    const upstream = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/auth/login')) {
        const form = init?.body as URLSearchParams;
        expect(form.get('username')).toBe(account.CDS_SERVICE_EMAIL);
        expect(form.get('password')).toBe(password);
        return Response.json({ access_token: 'private-login-token' });
      }
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer private-login-token');
      if (url.endsWith('/projects/')) return Response.json({ id: 'engine-project' });
      if (url.endsWith('/scan/upload-zip')) return Response.json({ task_id: 'engine-task' });
      if (url.endsWith('/issues')) return Response.json([]);
      return Response.json({ id: 'engine-task', status: 'completed', total_files: 1, scanned_files: 1 });
    });
    vi.stubGlobal('fetch', upstream);
    await service.pump();
    expect(service.get(task.id)).toMatchObject({ status: 'completed', engineTaskId: 'engine-task' });
    expect(state.listAcceptanceReports('source')).toHaveLength(1);
    expect(upstream).toHaveBeenCalledTimes(5);
    expect(JSON.stringify(service.list())).not.toContain(password);
    state.setCustomEnv({ CDS_SERVICE_EMAIL: account.CDS_SERVICE_EMAIL }, 'engine');
    expect(service.capabilities().engineConfigured).toBe(false);
  });
  it.each(['failed', 'cancelled', 'legacy-unbound'] as const)('%s 原断点跨引擎切换和重载仍只查询原引擎，新任务使用新引擎', async (status) => {
    await state.setCodeReviewSettings(binding);
    const localFetch = fetch, requests: string[] = [];
    let completing = false;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith(`${base}/`)) return localFetch(url, init);
      requests.push(url);
      if (url.endsWith('/auth/login')) return Response.json({ access_token: 'synthetic-login-token' });
      if (url.endsWith('/projects/')) return Response.json({ id: 'synthetic-project' });
      if (url.endsWith('/scan/upload-zip')) return Response.json({ task_id: 'original-checkpoint' });
      if (new URL(url).pathname.endsWith('/issues')) return Response.json([]);
      return Response.json({ id: 'original-checkpoint', status: completing ? 'completed' : 'failed',
        total_files: 1, scanned_files: completing ? 1 : 0, checkpoint_version: 1, resumable: true, issues_count: 0 });
    }));
    const submit = () => service.submit({ projectId: 'source', sourceType: 'zip',
      zip: buildZip([{ name: 'main.ts', data: Buffer.from('const value = 1;') }]), createdBy: 'test' });
    const original = await submit(); await service.pump();
    const checkpoint = service.get(original.id);
    expect(checkpoint).toMatchObject({ status: 'failed', engineTaskId: 'original-checkpoint' });
    if (status === 'cancelled') checkpoint.status = 'cancelled';
    if (status === 'legacy-unbound') delete (checkpoint as unknown as Record<string, unknown>).engineBinding;
    await state.putCodeReviewTask(checkpoint);
    const snapshot = { inputKey: checkpoint.inputKey, sourceHash: checkpoint.sourceHash };
    state.setCustomEnv({ ...account, CDS_SERVICE_PASSWORD: 'new-project-private-password' }, 'other');
    const switched = await put('owner', { engineProjectId: 'other', engineBaseUrl: 'http://new-engine.internal:8000' });
    expect(switched.status).toBe(200);
    // No retry or upstream request may be caused by changing the system selector.
    expect(requests.filter(url => url.endsWith('/scan/upload-zip'))).toHaveLength(1);
    service.stop(); service = new CodeReviewService({ ...service.deps });
    await service.retry(original.id);
    state.setCustomEnv({}, 'engine'); requests.length = 0;
    await service.pump(); expect(requests).toEqual([]); expect(service.get(original.id).status).toBe('queued');
    state.setCustomEnv(account, 'engine'); completing = true;
    await service.pump();
    expect(service.get(original.id)).toMatchObject({ ...snapshot, status: 'completed', engineTaskId: 'original-checkpoint' });
    expect(requests.some(url => url.includes('/tasks/original-checkpoint'))).toBe(true);
    expect(new Set(requests.map(url => new URL(url).origin))).toEqual(new Set([binding.engineBaseUrl]));
    expect(requests.some(url => url.endsWith('/scan/upload-zip') || url.endsWith('/resume'))).toBe(false);
    const visible = await (await fetch(`${base}/${original.id}`, { headers: { 'x-auth': 'owner' } })).json();
    expect(visible.task).not.toHaveProperty('engineBinding');
    expect(JSON.stringify(service.list())).not.toContain(account.CDS_SERVICE_PASSWORD);
    requests.length = 0;
    const next = await submit(); await service.pump();
    expect(service.get(next.id).status).toBe('completed');
    expect(new Set(requests.map(url => new URL(url).origin))).toEqual(new Set(['http://new-engine.internal:8000']));
  });
  it('环境来源断点保留原地址，只用原环境轮换凭据且不借新项目或新地址的凭据', async () => {
    vi.stubEnv('CDS_DEEPAUDIT_BASE_URL', 'https://legacy.example/api/v1/');
    vi.stubEnv('CDS_DEEPAUDIT_TOKEN', 'synthetic-old-token');
    const origin = currentCodeReviewEngineBinding(state)!;
    expect(JSON.stringify(origin)).not.toContain('synthetic-old-token');
    await state.setCodeReviewSettings(binding);
    vi.stubEnv('CDS_DEEPAUDIT_TOKEN', 'synthetic-rotated-token');
    expect(resolveCodeReviewEngineConfig(state, process.env, origin)).toMatchObject({
      baseUrl: 'https://legacy.example/api/v1', token: 'synthetic-rotated-token' });
    vi.stubEnv('CDS_DEEPAUDIT_BASE_URL', 'https://different.example');
    expect(resolveCodeReviewEngineConfig(state, process.env, origin)).toBeUndefined();
    expect(resolveCodeReviewEngineConfig(state)?.baseUrl).toBe(binding.engineBaseUrl);
  });
  it('切换时不改写其他实例的无绑定历史断点，保持原配置和任务', async () => {
    await state.setCodeReviewSettings(binding);
    const task = await service.submit({ projectId: 'source', sourceType: 'zip',
      zip: buildZip([{ name: 'main.ts', data: Buffer.from('const value = 1;') }]), createdBy: 'test' });
    task.status = 'failed'; task.engineTaskId = 'foreign-checkpoint'; task.ownerScope = 'other-instance';
    await state.putCodeReviewTask(task);
    expect((await put('owner', { ...binding, engineBaseUrl: 'http://new-engine.internal:8000' })).status).toBe(409);
    expect(state.getCodeReviewSettings()).toEqual(binding);
    expect(service.get(task.id)).toEqual(task);
  });
  it('保持 daemon 环境变量兼容，配置不完整不能声明已接通', async () => {
    vi.stubEnv('CDS_DEEPAUDIT_BASE_URL', 'https://legacy.example/api/v1');
    expect(service.capabilities().engineConfigured).toBe(false);
    vi.stubEnv('CDS_DEEPAUDIT_USERNAME', 'legacy@example.invalid');
    vi.stubEnv('CDS_DEEPAUDIT_PASSWORD', 'legacy-password');
    expect(resolveCodeReviewEngineConfig(state)).toMatchObject({ username: 'legacy@example.invalid', password: 'legacy-password' });
    expect(service.capabilities().engineConfigured).toBe(true);
    vi.stubEnv('CDS_DEEPAUDIT_USERNAME', ''); vi.stubEnv('CDS_DEEPAUDIT_PASSWORD', '');
    vi.stubEnv('CDS_DEEPAUDIT_TOKEN', 'explicit-token');
    expect(resolveCodeReviewEngineConfig(state)?.token).toBe('explicit-token');
    expect(service.capabilities().engineConfigured).toBe(true);
    await state.setCodeReviewSettings(binding);
    expect(resolveCodeReviewEngineConfig(state)).toEqual({ baseUrl: binding.engineBaseUrl, username: account.CDS_SERVICE_EMAIL, password: account.CDS_SERVICE_PASSWORD });
    state.setCustomEnv({}, 'engine');
    expect(service.capabilities().engineConfigured).toBe(false); // Broken binding cannot silently use another engine.
  });
});
