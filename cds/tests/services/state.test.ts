import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StateService } from '../../src/services/state.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('StateService', () => {
  let stateFile: string;
  let service: StateService;

  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-test-'));
    stateFile = path.join(tmpDir, 'state.json');
    service = new StateService(stateFile);
  });

  afterEach(() => {
    const dir = path.dirname(stateFile);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
  });

  describe('initialization', () => {
    it('should create empty state when file does not exist', () => {
      service.load();
      const state = service.getState();
      expect(state.defaultBranch).toBeNull();
      expect(state.routingRules).toEqual([]);
      expect(state.buildProfiles).toEqual([]);
      expect(state.branches).toEqual({});
      expect(state.nextPortIndex).toBe(0);
    });

    it('should load existing state from file', () => {
      const existing = {
        defaultBranch: 'main',
        routingRules: [],
        buildProfiles: [],
        branches: {
          main: {
            id: 'main', branch: 'main', worktreePath: '/tmp/wt/main',
            services: {}, status: 'running', createdAt: '2026-02-12T00:00:00Z',
          },
        },
        nextPortIndex: 2,
        logs: {},
      };
      fs.writeFileSync(stateFile, JSON.stringify(existing));
      service.load();
      expect(service.getState().defaultBranch).toBe('main');
      expect(service.getState().branches.main.status).toBe('running');
    });
  });

  describe('addBranch', () => {
    it('should add a new branch entry', () => {
      service.load();
      service.addBranch({
        id: 'feature-new-ui', branch: 'feature/new-ui',
        worktreePath: '/tmp/wt/feature-new-ui', services: {},
        status: 'idle', createdAt: '2026-02-12T10:00:00Z',
      });
      expect(service.getState().branches['feature-new-ui']).toBeDefined();
      expect(service.getState().branches['feature-new-ui'].branch).toBe('feature/new-ui');
    });

    it('should throw if branch id already exists', () => {
      service.load();
      const entry = {
        id: 'main', branch: 'main', worktreePath: '/tmp/wt/main',
        services: {}, status: 'idle' as const, createdAt: '2026-02-12T00:00:00Z',
      };
      service.addBranch(entry);
      expect(() => service.addBranch(entry)).toThrow('已存在');
    });
  });

  describe('removeBranch', () => {
    it('should remove an existing branch', () => {
      service.load();
      service.addBranch({
        id: 'test', branch: 'test', worktreePath: '/tmp/wt/test',
        services: {}, status: 'idle', createdAt: '2026-02-12T00:00:00Z',
      });
      service.removeBranch('test');
      expect(service.getState().branches['test']).toBeUndefined();
    });

    it('should throw if branch does not exist', () => {
      service.load();
      expect(() => service.removeBranch('nonexistent')).toThrow('不存在');
    });

    it('should clear defaultBranch if removing the default', () => {
      service.load();
      service.addBranch({
        id: 'default-one', branch: 'default-one', worktreePath: '/tmp/wt/a',
        services: {}, status: 'running', createdAt: '2026-02-12T00:00:00Z',
      });
      service.setDefaultBranch('default-one');
      service.removeBranch('default-one');
      expect(service.getState().defaultBranch).toBeNull();
    });
  });

  describe('allocatePort', () => {
    beforeEach(() => { service.load(); });

    it('should allocate first port when no services exist', () => {
      const port = service.allocatePort(10001);
      expect(port).toBe(10001);
    });

    it('should skip ports already in use', () => {
      service.addBranch({
        id: 'a', branch: 'a', worktreePath: '/a',
        services: { api: { profileId: 'api', containerName: 'c', hostPort: 10001, status: 'running' } },
        status: 'running', createdAt: '2026-02-12T00:00:00Z',
      });
      const port = service.allocatePort(10001);
      expect(port).toBeGreaterThan(10001);
    });
  });

  describe('routing rules', () => {
    beforeEach(() => { service.load(); });

    it('should add and retrieve routing rules', () => {
      service.addRoutingRule({
        id: 'r1', name: 'Test', type: 'domain',
        match: '{{feature_*}}.dev.example.com', branch: '$1',
        priority: 0, enabled: true,
      });
      expect(service.getRoutingRules()).toHaveLength(1);
      expect(service.getRoutingRules()[0].id).toBe('r1');
    });

    it('should sort rules by priority', () => {
      service.addRoutingRule({ id: 'r2', name: 'Low', type: 'domain', match: 'b', branch: 'b', priority: 10, enabled: true });
      service.addRoutingRule({ id: 'r1', name: 'High', type: 'domain', match: 'a', branch: 'a', priority: 1, enabled: true });
      const rules = service.getRoutingRules();
      expect(rules[0].id).toBe('r1');
      expect(rules[1].id).toBe('r2');
    });

    it('should update routing rules', () => {
      service.addRoutingRule({ id: 'r1', name: 'Test', type: 'domain', match: 'a', branch: 'a', priority: 0, enabled: true });
      service.updateRoutingRule('r1', { enabled: false });
      expect(service.getRoutingRules()[0].enabled).toBe(false);
    });

    it('should remove routing rules', () => {
      service.addRoutingRule({ id: 'r1', name: 'Test', type: 'domain', match: 'a', branch: 'a', priority: 0, enabled: true });
      service.removeRoutingRule('r1');
      expect(service.getRoutingRules()).toHaveLength(0);
    });
  });

  describe('build profiles', () => {
    beforeEach(() => { service.load(); });

    it('should add and retrieve profiles', () => {
      service.addBuildProfile({
        id: 'api', name: 'API', dockerImage: 'dotnet/sdk:8.0',
        workDir: 'prd-api', runCommand: 'dotnet run', containerPort: 8080,
      });
      expect(service.getBuildProfiles()).toHaveLength(1);
      expect(service.getBuildProfile('api')?.name).toBe('API');
    });

    it('should throw on duplicate profile id', () => {
      const p = { id: 'api', name: 'API', dockerImage: 'x', workDir: '.', runCommand: 'x', containerPort: 8080 };
      service.addBuildProfile(p);
      expect(() => service.addBuildProfile(p)).toThrow('已存在');
    });

    it('should update and remove profiles', () => {
      service.addBuildProfile({ id: 'api', name: 'API', dockerImage: 'x', workDir: '.', runCommand: 'x', containerPort: 8080 });
      service.updateBuildProfile('api', { name: 'Updated API' });
      expect(service.getBuildProfile('api')?.name).toBe('Updated API');
      service.removeBuildProfile('api');
      expect(service.getBuildProfiles()).toHaveLength(0);
    });
  });

  describe('logs', () => {
    beforeEach(() => {
      service.load();
      service.addBranch({
        id: 'log-test', branch: 'log/test', worktreePath: '/tmp/lt',
        services: {}, status: 'idle', createdAt: '2026-02-12T00:00:00Z',
      });
    });

    it('should append and retrieve logs', () => {
      service.appendLog('log-test', {
        type: 'build', startedAt: '2026-02-12T10:00:00Z',
        status: 'completed', events: [{ step: 'env', status: 'done', timestamp: '2026-02-12T10:00:00Z' }],
      });
      const logs = service.getLogs('log-test');
      expect(logs).toHaveLength(1);
      expect(logs[0].type).toBe('build');
    });

    it('should return empty array for branch with no logs', () => {
      expect(service.getLogs('log-test')).toEqual([]);
    });

    it('should trim logs to max 10 per branch', () => {
      for (let i = 0; i < 15; i++) {
        service.appendLog('log-test', {
          type: 'run', startedAt: `2026-02-12T${String(i).padStart(2, '0')}:00:00Z`,
          status: 'completed', events: [],
        });
      }
      expect(service.getLogs('log-test')).toHaveLength(10);
      expect(service.getLogs('log-test')[0].startedAt).toBe('2026-02-12T05:00:00Z');
    });

    it('should remove logs for a branch', () => {
      service.appendLog('log-test', {
        type: 'build', startedAt: '2026-02-12T10:00:00Z',
        status: 'completed', events: [],
      });
      service.removeLogs('log-test');
      expect(service.getLogs('log-test')).toEqual([]);
    });

    it('should migrate old state without logs field', () => {
      const oldState = {
        defaultBranch: null, routingRules: [], buildProfiles: [],
        branches: {}, nextPortIndex: 0,
      };
      fs.writeFileSync(stateFile, JSON.stringify(oldState));
      service.load();
      expect(service.getLogs('anything')).toEqual([]);
    });
  });

  describe('persistence', () => {
    it('should save and reload state correctly', () => {
      service.load();
      service.addBranch({
        id: 'persist-test', branch: 'persist/test', worktreePath: '/tmp/pt',
        services: {}, status: 'idle', createdAt: '2026-02-12T00:00:00Z',
      });
      service.setDefaultBranch('persist-test');
      service.save();

      const service2 = new StateService(stateFile);
      service2.load();
      expect(service2.getState().defaultBranch).toBe('persist-test');
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
