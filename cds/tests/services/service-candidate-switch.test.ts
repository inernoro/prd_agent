import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StateService } from '../../src/services/state.js';
import { DeploymentRunService } from '../../src/services/deployment-run.js';
import { CandidateJournal } from '../../src/services/service-candidate-journal.js';
import { createCandidateRuntime } from '../../src/services/service-candidate.js';
import { CandidateSwitchCoordinator } from '../../src/services/service-candidate-switch.js';
import type { BranchEntry, BuildProfile } from '../../src/types.js';
const sha = 'a'.repeat(40);
let dir: string; let state: StateService; let branch: BranchEntry; let graph: BranchEntry; let runId: string;
const reload = () => { const restored = new StateService(path.join(dir, 'state.json')); restored.load(); return restored; };
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-candidate-switch-'));
  state = new StateService(path.join(dir, 'state.json')); state.load();
  branch = { id: 'branch', branch: 'test', projectId: 'project', githubCommitSha: sha, deploymentTargetSha: sha,
    status: 'running', createdAt: '2026-10-11', worktreePath: '/unused',
    services: { api: { profileId: 'api', containerName: 'old', hostPort: 10001, status: 'running', deployedCommitSha: 'b'.repeat(40) } } };
  state.addBranch(branch);
  runId = (await new DeploymentRunService(state).begin({ projectId: 'project', branchId: 'branch', trigger: 'manual',
    commitSha: sha, operationId: 'operation', configHash: 'frozen' })).id;
  graph = createCandidateRuntime(branch, [{ id: 'api' } as BuildProfile], 'operation', () => 10002);
  const journal = new CandidateJournal(state);
  await journal.prepare(runId, graph);
  await journal.advance(runId, 'prepared', 'starting', graph);
  graph.services.api.status = 'running';
  Object.assign(graph.services.api, { deployedCommitSha: sha, deployedMode: 'prebuilt', deployedPrebuilt: true, deployedImage: 'image:sha-' + sha });
  await journal.advance(runId, 'starting', 'ready', graph);
});
afterEach(async () => { await state.flush(); fs.rmSync(dir, { recursive: true, force: true }); });

describe('P3 durable serving graph switch', () => {
  it.each(['image-during-ack', 'config-during-delete', 'image-during-delete'])('preserves both graphs when frozen facts drift: %s', async scenario => {
    const removed: string[] = [];
    const mutate = () => {
      if (scenario === 'config-during-delete') state.getDeploymentRun(runId)!.configHash = 'changed';
      else branch.services.api.deployedImage = 'changed-image';
      state.save();
    };
    await expect(new CandidateSwitchCoordinator(state).commit(runId, graph, {
      assertCurrent: () => {},
      acknowledge: async () => { if (scenario === 'image-during-ack') mutate(); return true; },
      remove: async (service, _kind, fence) => {
        await Promise.resolve(); mutate(); fence(); removed.push(service.containerName);
      },
    })).rejects.toThrow();
    expect(removed).toEqual([]);
    const restored = reload();
    expect(restored.getDeploymentRun(runId)!.candidate!.phase).not.toBe('released');
    expect(restored.allocatePort(10001)).not.toBe(10001);
    expect(restored.allocatePort(10002)).not.toBe(10002);
  });

  it('never recycles before durable intent and actual consumer acknowledgement', async () => {
    const events: string[] = [];
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    let reached!: () => void; const entered = new Promise<void>(resolve => { reached = resolve; });
    const pending = new CandidateSwitchCoordinator(state).commit(runId, graph, {
      assertCurrent: () => {}, acknowledge: async current => {
        const saved = reload();
        expect(saved.getDeploymentRun(runId)!.candidate!.phase).toBe('switch-intent');
        expect(saved.getBranch('branch')!.services.api.containerName).toBe(graph.services.api.containerName);
        expect(current.services.api.hostPort).toBe(10002);
        events.push('ack-start'); reached(); await gate; events.push('ack-done'); return true;
      }, remove: async (service, kind) => {
        expect(reload().getDeploymentRun(runId)!.candidate!.phase).toBe('routed');
        events.push('remove-' + kind + '-' + service.containerName);
      },
    });
    try { await entered; expect(events).toEqual(['ack-start']); expect(state.allocatePort(10001)).not.toBe(10001); }
    finally { release(); }
    await pending;
    expect(events).toEqual(['ack-start', 'ack-done', 'remove-serving-old']);
    expect(reload().getDeploymentRun(runId)!.candidate!.phase).toBe('released');
    const restored = reload();
    (restored.getState() as any).nextPortIndex = 0;
    expect(restored.allocatePort(10001)).toBe(10001);
  });

  it('restores and acknowledges the old graph before discarding rejected candidates', async () => {
    let calls = 0; const removed: string[] = [];
    await expect(new CandidateSwitchCoordinator(state).commit(runId, graph, {
      assertCurrent: () => {}, acknowledge: async current => {
        calls++; if (calls === 1) return false;
        expect(current.services.api.containerName).toBe('old');
        expect(reload().getDeploymentRun(runId)!.candidate!.phase).toBe('rollback-intent'); return true;
      }, remove: async (service, kind) => {
        expect(kind).toBe('candidate');
        expect(reload().getDeploymentRun(runId)!.candidate!.phase).toBe('rollback-verified');
        removed.push(service.containerName);
      },
    })).rejects.toThrow('candidate_switch_ack');
    expect(branch.services.api.containerName).toBe('old');
    expect(removed).toEqual([graph.services.api.containerName]);
    expect(reload().getDeploymentRun(runId)!.candidate!.phase).toBe('released');
  });

  it('preserves both reservations if rollback cannot be acknowledged', async () => {
    const removed: string[] = [];
    await expect(new CandidateSwitchCoordinator(state).commit(runId, graph, {
      assertCurrent: () => {}, acknowledge: async () => false,
      remove: async service => { removed.push(service.containerName); },
    })).rejects.toThrow('candidate_rollback_ack');
    expect(removed).toEqual([]);
    expect(reload().getDeploymentRun(runId)!.candidate!.phase).toBe('reconciling');
    expect(state.allocatePort(10001)).not.toBe(10001); expect(state.allocatePort(10002)).not.toBe(10002);
  });

  it('cannot overwrite a new owner after an awaited consumer read', async () => {
    let current = true; const next = { profileId: 'api', containerName: 'new-owner', hostPort: 10003, status: 'running' as const };
    const removed: string[] = [];
    await expect(new CandidateSwitchCoordinator(state).commit(runId, graph, {
      assertCurrent: () => { if (!current) throw new Error('superseded'); },
      acknowledge: async () => { current = false; branch.services = { api: next }; state.save(); return true; },
      remove: async service => { removed.push(service.containerName); },
    })).rejects.toThrow('superseded');
    expect(branch.services.api).toBe(next); expect(removed).toEqual([]);
    expect(reload().getDeploymentRun(runId)!.candidate!.phase).toBe('reconciling');
  });

  it('keeps old-container reservations when actual removal fails after routing', async () => {
    await expect(new CandidateSwitchCoordinator(state).commit(runId, graph, {
      assertCurrent: () => {}, acknowledge: async () => true, remove: async () => { throw new Error('daemon unavailable'); },
    })).rejects.toThrow('daemon unavailable');
    expect(branch.services.api.containerName).toBe(graph.services.api.containerName);
    expect(reload().getDeploymentRun(runId)!.candidate!.phase).toBe('reconciling');
    expect(state.allocatePort(10001)).not.toBe(10001);
  });

  it('rejects changed readiness, target, serving graph or candidate identity before publication', async () => {
    for (const mutate of [
      () => { graph.services.api.status = 'error'; },
      () => { graph.services.api.deployedCommitSha = 'b'.repeat(40); },
      () => { graph.services.api.deployedImage = 'different-image'; },
      () => { graph.services.api.hostPort = 10003; },
      () => { branch.deploymentTargetSha = 'c'.repeat(40); },
      () => { branch.services.api.containerName = 'foreign'; },
    ]) {
      const old = JSON.parse(JSON.stringify(graph.services.api)); const target = branch.deploymentTargetSha;
      mutate(); let acknowledged = false;
      await expect(new CandidateSwitchCoordinator(state).commit(runId, graph, {
        assertCurrent: () => {}, acknowledge: async () => { acknowledged = true; return true; }, remove: async () => {},
      })).rejects.toThrow();
      expect(acknowledged).toBe(false); graph.services.api = old; branch.deploymentTargetSha = target; branch.services.api.containerName = 'old';
    }
  });
});
