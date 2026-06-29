import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { StateService } from '../../src/services/state.js';
import type { BuildProfile } from '../../src/types.js';

function newState(): StateService {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-extra-svc-'));
  const s = new StateService(path.join(tmpDir, 'state.json'), tmpDir);
  s.load();
  return s;
}

const profile = (id: string): BuildProfile => ({
  id, name: id, dockerImage: `img-${id}`, workDir: id, command: 'run', containerPort: 8080, projectId: 'p',
});

describe('StateService — branch extra services', () => {
  it('getEffectiveProfilesForBranch = project baseline when no extras (zero-regression)', () => {
    const s = newState();
    s.addBuildProfile(profile('api'));
    s.addBuildProfile(profile('admin'));
    s.addBranch({ id: 'b1', projectId: 'p', branch: 'feat/b1', worktreePath: '/wt/b1', services: {}, status: 'idle', createdAt: '2026-06-29T00:00:00Z' });
    const eff = s.getEffectiveProfilesForBranch(s.getBranch('b1')!);
    expect(eff.map((x) => x.id).sort()).toEqual(['admin', 'api']);
  });

  it('setBranchExtraProfiles adds a branch-local service that only this branch deploys', () => {
    const s = newState();
    s.addBuildProfile(profile('api'));
    s.addBranch({ id: 'b1', projectId: 'p', branch: 'feat/b1', worktreePath: '/wt/b1', services: {}, status: 'idle', createdAt: '2026-06-29T00:00:00Z' });
    s.addBranch({ id: 'b2', projectId: 'p', branch: 'feat/b2', worktreePath: '/wt/b2', services: {}, status: 'idle', createdAt: '2026-06-29T00:00:00Z' });

    s.setBranchExtraProfiles('b1', [profile('llmgw-serve')]);

    // b1 sees api + llmgw-serve
    expect(s.getEffectiveProfilesForBranch(s.getBranch('b1')!).map((x) => x.id).sort()).toEqual(['api', 'llmgw-serve']);
    // b2 (sibling) is completely unaffected
    expect(s.getEffectiveProfilesForBranch(s.getBranch('b2')!).map((x) => x.id)).toEqual(['api']);
    // the project baseline itself is unchanged
    expect(s.getBuildProfilesForProject('p').map((x) => x.id)).toEqual(['api']);
  });

  it('clearing extras (empty array) returns to pure baseline; field removed', () => {
    const s = newState();
    s.addBuildProfile(profile('api'));
    s.addBranch({ id: 'b1', projectId: 'p', branch: 'feat/b1', worktreePath: '/wt/b1', services: {}, status: 'idle', createdAt: '2026-06-29T00:00:00Z' });
    s.setBranchExtraProfiles('b1', [profile('extra')]);
    expect(s.getBranch('b1')!.extraProfiles).toHaveLength(1);
    s.setBranchExtraProfiles('b1', []);
    expect(s.getBranch('b1')!.extraProfiles).toBeUndefined();
    expect(s.getEffectiveProfilesForBranch(s.getBranch('b1')!).map((x) => x.id)).toEqual(['api']);
  });

  it('deleting the branch drops its extras (删分支即消失)', () => {
    const s = newState();
    s.addBuildProfile(profile('api'));
    s.addBranch({ id: 'b1', projectId: 'p', branch: 'feat/b1', worktreePath: '/wt/b1', services: {}, status: 'idle', createdAt: '2026-06-29T00:00:00Z' });
    s.setBranchExtraProfiles('b1', [profile('extra')]);
    s.removeBranch('b1');
    expect(s.getBranch('b1')).toBeUndefined();
    // re-adding a same-id branch starts clean (no leftover extras)
    s.addBranch({ id: 'b1', projectId: 'p', branch: 'feat/b1', worktreePath: '/wt/b1', services: {}, status: 'idle', createdAt: '2026-06-29T00:00:00Z' });
    expect(s.getBranch('b1')!.extraProfiles).toBeUndefined();
  });
});
