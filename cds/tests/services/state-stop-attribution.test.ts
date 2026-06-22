import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateService } from '../../src/services/state.js';

describe('StateService legacy stop attribution migration', () => {
  it('repairs old webhook stops that were stored as user stops', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-state-stop-'));
    const stateFile = path.join(tmpDir, 'state.json');
    try {
      const now = new Date().toISOString();
      const service = new StateService(stateFile, tmpDir);
      service.load();
      service.addProject({
        id: 'default',
        slug: 'default',
        name: 'Default',
        kind: 'git',
        createdAt: now,
        updatedAt: now,
      });
      service.addBranch({
        id: 'webhook-stop',
        projectId: 'default',
        branch: 'feature/webhook-stop',
        worktreePath: path.join(tmpDir, 'worktrees', 'webhook-stop'),
        status: 'idle',
        createdAt: now,
        lastStoppedAt: now,
        lastStopReason: '用户手动停止',
        lastStopSource: 'user',
        services: {},
      });
      service.appendActivityLog('default', {
        type: 'stop',
        branchId: 'webhook-stop',
        branchName: 'feature/webhook-stop',
        actor: 'system:webhook',
        at: now,
      });
      service.save();

      const reloaded = new StateService(stateFile, tmpDir);
      reloaded.load();

      expect(reloaded.getBranch('webhook-stop')?.lastStopSource).toBe('webhook');
      expect(reloaded.getBranch('webhook-stop')?.lastStopReason).toBe('GitHub webhook 触发停止');
    } finally {
      if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('keeps old user stops unchanged when the activity log does not prove automation', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-state-stop-'));
    const stateFile = path.join(tmpDir, 'state.json');
    try {
      const now = new Date().toISOString();
      const service = new StateService(stateFile, tmpDir);
      service.load();
      service.addProject({
        id: 'default',
        slug: 'default',
        name: 'Default',
        kind: 'git',
        createdAt: now,
        updatedAt: now,
      });
      service.addBranch({
        id: 'manual-stop',
        projectId: 'default',
        branch: 'feature/manual-stop',
        worktreePath: path.join(tmpDir, 'worktrees', 'manual-stop'),
        status: 'idle',
        createdAt: now,
        lastStoppedAt: now,
        lastStopReason: '用户手动停止',
        lastStopSource: 'user',
        services: {},
      });
      service.appendActivityLog('default', {
        type: 'stop',
        branchId: 'manual-stop',
        branchName: 'feature/manual-stop',
        actor: 'user',
        at: now,
      });
      service.save();

      const reloaded = new StateService(stateFile, tmpDir);
      reloaded.load();

      expect(reloaded.getBranch('manual-stop')?.lastStopSource).toBe('user');
      expect(reloaded.getBranch('manual-stop')?.lastStopReason).toBe('用户手动停止');
    } finally {
      if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
