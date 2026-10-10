import { describe, expect, it, vi } from 'vitest';
import { candidateRuntimeIdentity, createCandidateRuntime } from '../../src/services/service-candidate.js';
import type { BranchEntry, BuildProfile } from '../../src/types.js';
const profile = (id = 'api') => ({ id } as BuildProfile);
const entry = (): BranchEntry => ({ id: 'branch', branch: 'test', projectId: 'p', githubCommitSha: 'a'.repeat(40),
  status: 'running', createdAt: '2026-10-10', worktreePath: '/unused',
  services: { api: { profileId: 'api', containerName: 'old', hostPort: 10001, status: 'running', deployedImage: 'old-image' } } });

describe('P3-04 private candidate graph', () => {
  it('allocates distinct ports and clears old runtime facts while leaving the serving graph untouched', () => {
    const serving = entry(); const before = structuredClone(serving); let port = 10002;
    const candidate = createCandidateRuntime(serving, [profile(), profile('web')], 'op-test', reserved => {
      expect(reserved.has(10001)).toBe(true); return port++;
    });
    expect(serving).toEqual(before); expect(candidate.services).not.toBe(serving.services);
    expect(candidate.services.api).toEqual({ profileId: 'api', containerName: candidateRuntimeIdentity('branch', 'api', 'op-test').containerName, hostPort: 10002, status: 'idle' });
    expect(candidate.services.web.hostPort).toBe(10003); expect(candidate.status).toBe('building');
    candidate.services.api.status = 'error'; expect(serving.services.api.status).toBe('running');
  });
  it('rejects reuse of a currently serving generation before allocating any port', () => {
    const serving = entry(); serving.services.api.containerName = candidateRuntimeIdentity(serving.id, 'api', 'op-test').containerName;
    const allocate = vi.fn(() => 10002);
    expect(() => createCandidateRuntime(serving, [profile()], 'op-test', allocate)).toThrow('candidate_identity');
    expect(allocate).not.toHaveBeenCalled();
  });
  it('rejects duplicate profiles before any allocation and port collisions with either graph', () => {
    const allocate = vi.fn(() => 10002);
    expect(() => createCandidateRuntime(entry(), [profile(), profile()], 'op-test', allocate)).toThrow('duplicate');
    expect(allocate).not.toHaveBeenCalled();
    expect(() => createCandidateRuntime(entry(), [profile()], 'op-test', () => 10001)).toThrow('candidate_port');
    expect(() => createCandidateRuntime(entry(), [profile(), profile('web')], 'op-test', () => 10002)).toThrow('candidate_port');
  });
  it('keeps long owner identities bounded and collision-resistant; rejects malformed owners and targets', () => {
    const first = candidateRuntimeIdentity('b'.repeat(128), 'p'.repeat(128), 'a'.repeat(128));
    const second = candidateRuntimeIdentity('b'.repeat(128), 'p'.repeat(128), 'a'.repeat(127) + 'b');
    expect(first.containerName.length).toBeLessThanOrEqual(200); expect(first.containerName).not.toBe(second.containerName);
    expect(candidateRuntimeIdentity('branch-x', 'api', 'op-test').containerName).not.toBe(candidateRuntimeIdentity('branch', 'x-api', 'op-test').containerName);
    expect(first.networkName.startsWith('cds-br-')).toBe(false);
    expect(() => candidateRuntimeIdentity('branch', 'api', 'op; rm')).toThrow('candidate_identity');
    expect(() => createCandidateRuntime({ ...entry(), githubCommitSha: 'abc1234' }, [profile()], 'op-test', () => 10002)).toThrow('candidate_target');
    expect(() => createCandidateRuntime(entry(), [], 'op-test', () => 10002)).toThrow('candidate_graph');
  });
});
