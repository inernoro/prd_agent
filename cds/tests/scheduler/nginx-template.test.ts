import { describe, it, expect } from 'vitest';
import { generateUpstreamBlock, generateBranchMap, generateFullConfig } from '../../src/scheduler/nginx-template.js';
import type { ExecutorNode } from '../../src/types.js';

function makeExecutor(id: string, host: string, extras: Partial<ExecutorNode> = {}): ExecutorNode {
  return {
    id,
    host,
    port: 9900,
    status: 'online',
    capacity: { maxBranches: 10, memoryMB: 8192, cpuCores: 4 },
    load: { memoryUsedMB: 0, cpuPercent: 0 },
    labels: [],
    branches: [],
    lastHeartbeat: new Date().toISOString(),
    registeredAt: new Date().toISOString(),
    ...extras,
  };
}

describe('Nginx template generator', () => {
  describe('generateUpstreamBlock', () => {
    it('emits one server line per online executor', () => {
      const executors = [
        makeExecutor('a', 'exec-a.local'),
        makeExecutor('b', 'exec-b.local'),
      ];
      const config = generateUpstreamBlock(executors, { previewDomain: 'miduo.org' });
      expect(config).toContain('upstream cds_executors');
      expect(config).toContain('server exec-a.local:9900');
      expect(config).toContain('server exec-b.local:9900');
      expect(config).toContain('max_fails=3 fail_timeout=30s');
    });

    it('marks draining executors as backup', () => {
      const executors = [
        makeExecutor('a', 'exec-a.local'),
        makeExecutor('b', 'exec-b.local', { status: 'draining' }),
      ];
      const config = generateUpstreamBlock(executors, { previewDomain: 'miduo.org' });
      expect(config).toMatch(/server exec-b\.local:9900 [^;]*backup/);
      expect(config).not.toMatch(/server exec-a\.local:9900 [^;]*backup/);
    });

    it('omits offline executors entirely', () => {
      const executors = [
        makeExecutor('a', 'exec-a.local'),
        makeExecutor('b', 'exec-b.local', { status: 'offline' }),
      ];
      const config = generateUpstreamBlock(executors, { previewDomain: 'miduo.org' });
      expect(config).toContain('exec-a.local');
      expect(config).not.toContain('exec-b.local');
    });

    it('emits sentinel server when no executors available', () => {
      const config = generateUpstreamBlock([], { previewDomain: 'miduo.org' });
      expect(config).toContain('127.0.0.1:1 down');
      expect(config).toContain('no healthy executors');
    });

    it('uses override port when specified', () => {
      const executors = [makeExecutor('a', 'exec-a.local')];
      const config = generateUpstreamBlock(executors, {
        previewDomain: 'miduo.org',
        executorPort: 5500,  // point at worker proxy instead of master
      });
      expect(config).toContain('exec-a.local:5500');
      expect(config).not.toContain('exec-a.local:9900');
    });

    it('supports custom upstream name', () => {
      const executors = [makeExecutor('a', 'exec-a.local')];
      const config = generateUpstreamBlock(executors, {
        previewDomain: 'miduo.org',
        upstreamName: 'my_backend',
      });
      expect(config).toContain('upstream my_backend');
      expect(config).not.toContain('upstream cds_executors');
    });

    it('supports custom max_fails / fail_timeout', () => {
      const executors = [makeExecutor('a', 'exec-a.local')];
      const config = generateUpstreamBlock(executors, {
        previewDomain: 'miduo.org',
        maxFails: 5,
        failTimeoutSeconds: 60,
      });
      expect(config).toContain('max_fails=5');
      expect(config).toContain('fail_timeout=60s');
    });
  });

  describe('generateBranchMap', () => {
    it('maps each branch to its executor host:port', () => {
      const executors = [
        makeExecutor('a', 'exec-a.local', { branches: ['feature-x', 'feature-y'] }),
        makeExecutor('b', 'exec-b.local', { branches: ['feature-z'] }),
      ];
      const map = generateBranchMap(executors, { previewDomain: 'miduo.org' });
      expect(map).toContain('map $http_x_branch $cds_backend');
      expect(map).toContain('"feature-x" exec-a.local:9900');
      expect(map).toContain('"feature-y" exec-a.local:9900');
      expect(map).toContain('"feature-z" exec-b.local:9900');
      expect(map).toContain('default cds_executors');
    });

    it('skips offline executors', () => {
      const executors = [
        makeExecutor('a', 'exec-a.local', { status: 'offline', branches: ['feature-x'] }),
      ];
      const map = generateBranchMap(executors, { previewDomain: 'miduo.org' });
      expect(map).not.toContain('feature-x');
    });
  });

  describe('generateFullConfig', () => {
    it('combines upstream + map + server block', () => {
      const executors = [makeExecutor('a', 'exec-a.local', { branches: ['test'] })];
      const config = generateFullConfig(executors, { previewDomain: 'miduo.org' });

      expect(config).toContain('upstream cds_executors');
      expect(config).toContain('map $http_x_branch');
      expect(config).toContain('server {');
      expect(config).toContain('server_name *.miduo.org');
      expect(config).toContain('proxy_pass http://cds_executors');
      expect(config).toContain('proxy_buffering off');  // SSE support
    });

    it('escapes dots in preview domain regex', () => {
      const config = generateFullConfig([], { previewDomain: 'my.example.org' });
      // The regex inside `if ($host ~ ...)` must escape dots
      expect(config).toContain('my\\.example\\.org');
    });
  });
});
