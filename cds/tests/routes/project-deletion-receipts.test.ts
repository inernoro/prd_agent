import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateService } from '../../src/services/state.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import { cdsEventsBus } from '../../src/services/cds-events-bus.js';
import { createProjectsRouter } from '../../src/routes/projects.js';
import { createAccessRequestsRouter } from '../../src/routes/access-requests.js';
import type { StateBackingStore } from '../../src/infra/state-store/backing-store.js';
import type { CdsState } from '../../src/types.js';

describe('删除项目与历史回执的持久化边界', () => {
  let state: StateService, server: Server, shell: MockShellExecutor, dir: string;
  let persisted: CdsState | null, pending: CdsState | null;
  let mode: 'ok' | 'save-fail' | 'flush-fail' | 'hold';
  let release: (() => void) | undefined, entered: Promise<void>, enter: () => void;
  let store: StateBackingStore & { flush(): Promise<void> }, origin: string;
  const removed = (value: CdsState | null) => !!value && !value.projects?.some(p => p.id === 'target');
  async function receiptView() {
    const response = await fetch(`${origin}/api/access-requests`);
    expect(response.status).toBe(200);
    return (await response.json() as { requests: Array<Record<string, unknown>> }).requests.find(r => r.id === 'receipt')!;
  }
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-deletion-receipt-'));
    persisted = pending = null; mode = 'ok'; release = undefined;
    entered = new Promise(resolve => { enter = resolve; });
    store = {
      kind: 'json', load: () => structuredClone(persisted),
      save(value) {
        if (mode === 'save-fail' && removed(value)) throw new Error('injected save failure');
        pending = structuredClone(value);
      },
      async flush() {
        if (removed(pending)) {
          if (mode === 'hold') { enter(); await new Promise<void>(resolve => { release = resolve; }); }
          if (mode === 'flush-fail') throw new Error('injected persistence failure');
        }
        if (pending) { persisted = structuredClone(pending); pending = null; }
      },
    };
    state = new StateService(path.join(dir, 'state.json'), dir, store); state.load();
    const now = new Date().toISOString();
    for (const id of ['target', 'other']) state.addProject({ id, slug: id, name: id, kind: 'git', createdAt: now, updatedAt: now });
    state.addAccessRequest({ id: 'receipt', kind: 'bootstrap', projectId: '__new_project__', status: 'approved', agentName: 'regression',
      purpose: '删除与回执', pollTokenHash: 'a'.repeat(64), createdAt: now, decidedAt: now, deliveredAt: now,
      creationReceiptEnabled: true, createdProject: { id: 'target', name: 'target', createdAt: now } });
    state.addBranch({ id: 'target-branch', projectId: 'target', branch: 'lab', worktreePath: dir, services: {}, status: 'idle', createdAt: now });
    state.addProjectGrant({ id: 'grant-target', projectId: 'target', principalId: 'tester', origin: 'approved', grantedAt: now });
    (state.getState() as CdsState).customEnv.target = { RETAIN: 'original' };
    await state.flush(); shell = new MockShellExecutor();
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { Object.assign(req, { cdsUser: { id: 'owner', isSystemOwner: true, authProvider: 'local' }, cdsSession: {} }); next(); });
    app.use('/api', createProjectsRouter({ stateService: state, shell }));
    app.use('/api', createAccessRequestsRouter({ stateService: state }));
    server = app.listen(0); await new Promise<void>(resolve => server.once('listening', resolve));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterEach(async () => {
    release?.(); vi.restoreAllMocks();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it.each(['save-fail', 'flush-fail'] as const)('%s 时不归档、不广播成功、不清理容器，重启后仍有原项目', async failure => {
    const before = structuredClone(state.getAccessRequest('receipt'));
    const publish = vi.spyOn(cdsEventsBus, 'publish'); mode = failure;
    const response = await fetch(`${origin}/api/projects/target`, { method: 'DELETE' });
    expect(response.status).toBe(500);
    expect(state.getProject('target')).toBeDefined();
    expect(state.getBranch('target-branch')).toBeDefined();
    expect(state.getState().projectGrants?.find(g => g.id === 'grant-target')?.revokedAt).toBeUndefined();
    expect(state.getState().customEnv.target).toEqual({ RETAIN: 'original' });
    // 后续无关保存不能把失败的删除悄悄落盘。
    mode = 'ok'; state.updateProject('other', { name: 'other-updated' }); await state.flush();
    expect((await receiptView()).receiptArchived).not.toBe(true);
    expect((await receiptView()).creationReceiptEnabled).toBe(true);
    expect(state.getAccessRequest('receipt')).toEqual(before);
    expect(publish).not.toHaveBeenCalledWith('access-request.progress', expect.objectContaining({ stage: 'project-deleted' }));
    expect(shell.commands.some(c => /^docker (?:rm|network rm)/.test(c))).toBe(false);
    const restarted = new StateService(path.join(dir, 'state.json'), dir, store); restarted.load();
    expect(restarted.getProject('target')).toBeDefined();
    expect(restarted.getProject('other')?.name).toBe('other-updated');
    expect((await fetch(`${origin}/api/projects/target`, { method: 'DELETE' })).status).toBe(200);
    expect(restarted.getAccessRequest('receipt')).toEqual(before);
  });

  it('异步失败只恢复本项目，保留等待期间其他项目的修改', async () => {
    mode = 'hold';
    const deleting = fetch(`${origin}/api/projects/target`, { method: 'DELETE' });
    await entered;
    state.updateProject('other', { name: 'concurrent-edit' });
    mode = 'flush-fail'; release?.();
    expect((await deleting).status).toBe(500);
    expect(state.getProject('target')).toBeDefined();
    expect(state.getProject('other')?.name).toBe('concurrent-edit');
    mode = 'ok'; await state.flush(); state.load();
    expect(state.getProject('target')).toBeDefined();
    expect(state.getProject('other')?.name).toBe('concurrent-edit');
    expect((await receiptView()).receiptArchived).not.toBe(true);
  });

  it('落盘期间保持回执；确认成功才归档，其他项目和审计不变，重启后仍成立', async () => {
    const before = structuredClone(state.getAccessRequest('receipt')), other = structuredClone(state.getProject('other'));
    const publish = vi.spyOn(cdsEventsBus, 'publish'); mode = 'hold';
    const deleting = fetch(`${origin}/api/projects/target`, { method: 'DELETE' });
    await entered;
    try {
      expect((await receiptView()).receiptArchived).not.toBe(true);
      expect(publish).not.toHaveBeenCalledWith('access-request.progress', expect.objectContaining({ stage: 'project-deleted' }));
    } finally { mode = 'ok'; release?.(); }
    expect((await deleting).status).toBe(200);
    expect(await receiptView()).toMatchObject({ receiptArchived: true, creationReceiptEnabled: false, status: 'approved' });
    expect(publish).toHaveBeenCalledWith('access-request.progress', { projectId: 'target', stage: 'project-deleted' });
    expect(state.getAccessRequest('receipt')).toEqual(before); expect(state.getProject('other')).toEqual(other);
    state.load();
    expect(state.getProject('target')).toBeUndefined();
    expect(await receiptView()).toMatchObject({ receiptArchived: true, creationReceiptEnabled: false });
    expect(state.getAccessRequest('receipt')).toEqual(before);
  });
});
