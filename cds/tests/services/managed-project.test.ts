import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ManagedProjectService } from '../../src/services/managed-project.js';
import { StateService } from '../../src/services/state.js';
import type { BranchEntry } from '../../src/types.js';

describe('ManagedProjectService', () => {
  let tmpDir: string;
  let stateService: StateService;
  let branch: BranchEntry;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-managed-project-'));
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
      scripts: { build: 'vite build', start: 'vite --host 0.0.0.0' },
      dependencies: { vite: '^6.0.0', react: '^18.0.0' },
    }));
    stateService = new StateService(path.join(tmpDir, 'state.json'));
    stateService.load();
    stateService.addProject({
      id: 'p1', slug: 'p1', name: 'P1', kind: 'git', deliveryMode: 'managed',
      managedSpec: {
        apps: [{ id: 'web', appPath: '.', workload: 'web', health: { type: 'http', path: '/health' } }],
        capabilities: [{ id: 'cache', kind: 'cache', bindingId: 'redis' }],
      },
    } as any);
    stateService.getState().infraServices.push({
      id: 'redis', projectId: 'p1', name: 'Redis', dockerImage: 'redis:7', containerPort: 6379,
      hostPort: 16379, containerName: 'cds-redis', status: 'running', volumes: [], env: {}, createdAt: 't',
    });
    branch = {
      id: 'b1', projectId: 'p1', branch: 'main', worktreePath: tmpDir, status: 'idle',
      githubCommitSha: '1234567890abcdef', services: {}, createdAt: 't',
    };
    stateService.addBranch(branch);
  });

  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('generates a build/start separated profile and logical capability bindings', () => {
    const plan = new ManagedProjectService(stateService).ensurePlanForBranch(branch);

    expect(plan?.profiles).toHaveLength(1);
    expect(plan?.profiles[0]).toMatchObject({
      id: 'web',
      projectId: 'p1',
      dependsOn: ['redis'],
      env: { CACHE_HOST: '${CDS_REDIS_HOST}', CACHE_PORT: '${CDS_REDIS_PORT}' },
      readinessProbe: { path: '/health' },
      managedBuild: {
        startCommand: expect.stringContaining('serve'),
        artifactImage: expect.stringMatching(/^cds-managed\/p1-web:sha-[0-9a-f]{40}$/),
      },
    });
    expect(plan?.profiles[0].managedBuild?.buildCommand).toContain('build');
    expect(plan?.capabilities).toEqual([
      expect.objectContaining({ kind: 'cache', bindingId: 'redis', fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) }),
    ]);
    expect(stateService.getBuildProfilesForProject('p1')[0].id).toBe('web');
  });

  it('keeps compose projects on their hand-authored profiles', () => {
    const project = stateService.getProject('p1')!;
    project.deliveryMode = 'compose';
    stateService.addBuildProfile({
      id: 'legacy', projectId: 'p1', name: 'Legacy', dockerImage: 'node:22', workDir: '.',
      command: 'pnpm dev', containerPort: 3000,
    });

    expect(new ManagedProjectService(stateService).ensurePlanForBranch(branch)).toBeNull();
    expect(stateService.getBuildProfilesForProject('p1').map((profile) => profile.id)).toEqual(['legacy']);
  });

  it('refuses unresolved resource and secret capability bindings before deployment', () => {
    const project = stateService.getProject('p1')!;
    project.managedSpec!.capabilities = [
      { id: 'db', kind: 'database', bindingId: 'missing-db' },
      { id: 'auth', kind: 'secrets', bindingId: 'project-env', envKeys: ['AUTH_SECRET'] },
    ];

    expect(() => new ManagedProjectService(stateService).ensurePlanForBranch(branch)).toThrow(/资源不存在/);
    project.managedSpec!.capabilities = [
      { id: 'auth', kind: 'secrets', bindingId: 'project-env', envKeys: ['AUTH_SECRET'] },
    ];
    expect(() => new ManagedProjectService(stateService).ensurePlanForBranch(branch)).toThrow(/AUTH_SECRET/);
  });
});
