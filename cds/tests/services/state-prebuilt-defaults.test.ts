import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateService } from '../../src/services/state.js';
import { applyDefaultDeployModesToBranch } from '../../src/services/deploy-runtime.js';
import { resolveEffectiveProfile } from '../../src/services/container.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';
import type { BranchEntry, BuildProfile, Project } from '../../src/types.js';
let root: string; let state: StateService;
const profile = (id = 'api'): BuildProfile => ({ id, projectId: 'new-project', name: id,
  dockerImage: 'source:local', command: 'compile', workDir: '.', containerPort: 8080,
  activeDeployMode: 'dev', deployModes: { dev: { label: '源码', command: 'compile' },
    fast: { label: 'CI 制品', prebuilt: true, dockerImage: 'registry/app:sha-' + 'a'.repeat(40), command: '' } } });
const project = (defaults?: Record<string, string>): Project => ({ id: 'new-project', name: 'Project', slug: 'project',
  dockerNetwork: 'network', legacyFlag: false, createdAt: '2026-10-10', updatedAt: '2026-10-10',
  ...(defaults ? { defaultDeployModes: defaults } : {}) });
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-default-test-')); state = new StateService(path.join(root, 'state.json')); });
afterEach(async () => { await flushAllJsonStateStores(); fs.rmSync(root, { recursive: true, force: true }); });
describe('P1-05 new branch prebuilt defaults', () => {
  it('persists discovered prebuilt preference and creates an express branch without changing the source baseline', async () => {
    state.addProject(project()); state.addBuildProfile(profile()); state.save(); await flushAllJsonStateStores();
    const restored = new StateService(path.join(root, 'state.json')); restored.load();
    expect(restored.getProject('new-project')?.defaultDeployModes).toEqual({ api: 'fast' });
    const branch = { id: 'branch', branch: 'branch', projectId: 'new-project', worktreePath: '/unused', services: {},
      status: 'idle', createdAt: '2026-10-10' } as BranchEntry;
    applyDefaultDeployModesToBranch(branch, restored.getProject('new-project')!.defaultDeployModes!, restored.getBuildProfiles());
    expect(resolveEffectiveProfile(restored.getBuildProfile('api')!, branch).prebuiltImage).toBe(true);
    expect(restored.getBuildProfile('api')?.activeDeployMode).toBe('dev');
  });
  it('preserves explicit project exceptions and existing branch choices', () => {
    state.addProject(project({ api: 'dev' })); state.addBuildProfile(profile());
    const branch = { id: 'old', branch: 'old', projectId: 'new-project', worktreePath: '/unused', services: {},
      status: 'idle', createdAt: '2026-10-10', profileOverrides: { web: { activeDeployMode: 'dev' } } } as BranchEntry;
    state.addBranch(branch); state.addBuildProfile(profile('web'));
    expect(state.getProject('new-project')?.defaultDeployModes).toEqual({ api: 'dev', web: 'fast' });
    expect(state.getBranch('old')?.profileOverrides?.web?.activeDeployMode).toBe('dev');
  });
  it('fills a previously absent default when an existing profile first gains a prebuilt mode, without inventing one for source-only', () => {
    state.addProject(project()); const source = profile(); delete source.deployModes!.fast; state.addBuildProfile(source);
    expect(state.getProject('new-project')?.defaultDeployModes?.api).toBeUndefined();
    state.updateBuildProfile('api', { deployModes: profile().deployModes });
    expect(state.getProject('new-project')?.defaultDeployModes?.api).toBe('fast');
  });
});
