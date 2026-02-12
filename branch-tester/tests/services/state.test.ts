import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StateService } from '../../src/services/state.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('StateService', () => {
  let stateFile: string;
  let service: StateService;

  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-test-'));
    stateFile = path.join(tmpDir, 'state.json');
    service = new StateService(stateFile);
  });

  afterEach(() => {
    const dir = path.dirname(stateFile);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true });
    }
  });

  describe('initialization', () => {
    it('should create empty state when file does not exist', () => {
      service.load();
      const state = service.getState();
      expect(state.activeBranchId).toBeNull();
      expect(state.history).toEqual([]);
      expect(state.branches).toEqual({});
      expect(state.nextPortIndex).toBe(1);
    });

    it('should load existing state from file', () => {
      const existing = {
        activeBranchId: 'main',
        history: ['main'],
        branches: {
          main: {
            id: 'main',
            branch: 'main',
            worktreePath: '/tmp/wt/main',
            containerName: 'prdagent-api-main',
            imageName: 'prdagent-server:main',
            dbName: 'prdagent',
            status: 'running' as const,
            createdAt: '2026-02-12T00:00:00Z',
          },
        },
        nextPortIndex: 2,
      };
      fs.writeFileSync(stateFile, JSON.stringify(existing));

      service.load();
      const state = service.getState();
      expect(state.activeBranchId).toBe('main');
      expect(state.branches.main.status).toBe('running');
    });
  });

  describe('addBranch', () => {
    it('should add a new branch entry', () => {
      service.load();
      service.addBranch({
        id: 'feature-new-ui',
        branch: 'feature/new-ui',
        worktreePath: '/tmp/wt/feature-new-ui',
        containerName: 'prdagent-api-feature-new-ui',
        imageName: 'prdagent-server:feature-new-ui',
        dbName: 'prdagent_1',
        status: 'idle',
        createdAt: '2026-02-12T10:00:00Z',
      });

      const state = service.getState();
      expect(state.branches['feature-new-ui']).toBeDefined();
      expect(state.branches['feature-new-ui'].branch).toBe('feature/new-ui');
    });

    it('should throw if branch id already exists', () => {
      service.load();
      const entry = {
        id: 'main',
        branch: 'main',
        worktreePath: '/tmp/wt/main',
        containerName: 'prdagent-api-main',
        imageName: 'prdagent-server:main',
        dbName: 'prdagent',
        status: 'idle' as const,
        createdAt: '2026-02-12T00:00:00Z',
      };
      service.addBranch(entry);
      expect(() => service.addBranch(entry)).toThrow('already exists');
    });
  });

  describe('removeBranch', () => {
    it('should remove an existing branch', () => {
      service.load();
      service.addBranch({
        id: 'test',
        branch: 'test',
        worktreePath: '/tmp/wt/test',
        containerName: 'c-test',
        imageName: 'i-test',
        dbName: 'db_test',
        status: 'idle',
        createdAt: '2026-02-12T00:00:00Z',
      });
      service.removeBranch('test');
      expect(service.getState().branches['test']).toBeUndefined();
    });

    it('should throw if branch does not exist', () => {
      service.load();
      expect(() => service.removeBranch('nonexistent')).toThrow('not found');
    });

    it('should clear activeBranchId if removing the active branch', () => {
      service.load();
      service.addBranch({
        id: 'active-one',
        branch: 'active-one',
        worktreePath: '/tmp/wt/a',
        containerName: 'c-a',
        imageName: 'i-a',
        dbName: 'db_a',
        status: 'running',
        createdAt: '2026-02-12T00:00:00Z',
      });
      service.activate('active-one');
      service.removeBranch('active-one');
      expect(service.getState().activeBranchId).toBeNull();
    });
  });

  describe('updateStatus', () => {
    it('should update branch status', () => {
      service.load();
      service.addBranch({
        id: 'b1',
        branch: 'b1',
        worktreePath: '/tmp/wt/b1',
        containerName: 'c-b1',
        imageName: 'i-b1',
        dbName: 'db_b1',
        status: 'idle',
        createdAt: '2026-02-12T00:00:00Z',
      });
      service.updateStatus('b1', 'running');
      expect(service.getState().branches['b1'].status).toBe('running');
    });

    it('should throw if branch does not exist', () => {
      service.load();
      expect(() => service.updateStatus('nope', 'running')).toThrow('not found');
    });
  });

  describe('activate & history', () => {
    beforeEach(() => {
      service.load();
      service.addBranch({
        id: 'a',
        branch: 'a',
        worktreePath: '/tmp/a',
        containerName: 'c-a',
        imageName: 'i-a',
        dbName: 'db_a',
        status: 'running',
        createdAt: '2026-02-12T00:00:00Z',
      });
      service.addBranch({
        id: 'b',
        branch: 'b',
        worktreePath: '/tmp/b',
        containerName: 'c-b',
        imageName: 'i-b',
        dbName: 'db_b',
        status: 'running',
        createdAt: '2026-02-12T00:00:00Z',
      });
    });

    it('should set activeBranchId and push to history', () => {
      service.activate('a');
      expect(service.getState().activeBranchId).toBe('a');
      expect(service.getState().history).toEqual(['a']);
    });

    it('should track history across multiple activations', () => {
      service.activate('a');
      service.activate('b');
      service.activate('a');
      expect(service.getState().history).toEqual(['a', 'b', 'a']);
      expect(service.getState().activeBranchId).toBe('a');
    });

    it('should set lastActivatedAt on activate', () => {
      service.activate('a');
      expect(service.getState().branches['a'].lastActivatedAt).toBeDefined();
    });

    it('should throw if activating non-existent branch', () => {
      expect(() => service.activate('nope')).toThrow('not found');
    });
  });

  describe('rollback', () => {
    beforeEach(() => {
      service.load();
      service.addBranch({
        id: 'x',
        branch: 'x',
        worktreePath: '/tmp/x',
        containerName: 'c-x',
        imageName: 'i-x',
        dbName: 'db_x',
        status: 'running',
        createdAt: '2026-02-12T00:00:00Z',
      });
      service.addBranch({
        id: 'y',
        branch: 'y',
        worktreePath: '/tmp/y',
        containerName: 'c-y',
        imageName: 'i-y',
        dbName: 'db_y',
        status: 'running',
        createdAt: '2026-02-12T00:00:00Z',
      });
    });

    it('should rollback to previous branch', () => {
      service.activate('x');
      service.activate('y');
      const rollbackId = service.rollback();
      expect(rollbackId).toBe('x');
      expect(service.getState().activeBranchId).toBe('x');
    });

    it('should return null if no history to rollback', () => {
      const result = service.rollback();
      expect(result).toBeNull();
    });

    it('should return null if only one entry in history', () => {
      service.activate('x');
      const result = service.rollback();
      expect(result).toBeNull();
    });
  });

  describe('allocateDbName', () => {
    it('should return default db name for first branch', () => {
      service.load();
      const name = service.allocateDbName('main', 'prdagent');
      expect(name).toBe('prdagent');
    });

    it('should return indexed db name for subsequent branches', () => {
      service.load();
      const name1 = service.allocateDbName('feature-a', 'prdagent');
      expect(name1).toBe('prdagent_1');
      const name2 = service.allocateDbName('feature-b', 'prdagent');
      expect(name2).toBe('prdagent_2');
    });
  });

  describe('persistence', () => {
    it('should save and reload state correctly', () => {
      service.load();
      service.addBranch({
        id: 'persist-test',
        branch: 'persist/test',
        worktreePath: '/tmp/pt',
        containerName: 'c-pt',
        imageName: 'i-pt',
        dbName: 'db_pt',
        status: 'idle',
        createdAt: '2026-02-12T00:00:00Z',
      });
      service.activate('persist-test');
      service.save();

      const service2 = new StateService(stateFile);
      service2.load();
      expect(service2.getState().activeBranchId).toBe('persist-test');
      expect(service2.getState().branches['persist-test'].branch).toBe('persist/test');
    });
  });

  describe('slugify', () => {
    it('should convert branch name to slug id', () => {
      expect(StateService.slugify('feature/new-ui')).toBe('feature-new-ui');
      expect(StateService.slugify('hotfix/bug#123')).toBe('hotfix-bug-123');
      expect(StateService.slugify('main')).toBe('main');
      expect(StateService.slugify('release/v1.2.3')).toBe('release-v1-2-3');
    });
  });
});
