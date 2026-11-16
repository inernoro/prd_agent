import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StateService } from '../../src/services/state.js';
import { mergeBranchProfiles } from '../../src/services/branch-extra-services.js';
import { resolveEffectiveProfile } from '../../src/services/container.js';
import type { BranchEntry, BuildProfile } from '../../src/types.js';

let root: string, state: StateService;
const profile = (id: string, extra: Partial<BuildProfile> = {}): BuildProfile => ({
  id, projectId: 'p', name: id, dockerImage: 'node:22-alpine', workDir: '.', command: 'run', containerPort: 8080, ...extra,
});
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-service-isolation-'));
  state = new StateService(path.join(root, 'state.json'), root); state.load();
  state.addProject({ id: 'p', slug: 'p', name: 'test', kind: 'git', createdAt: '2026-01-01', updatedAt: '2026-01-01' });
  for (const p of [profile('legacy', { cacheMounts: [{ hostPath: 'retained-documents', containerPath: '/documents', kind: 'volume' }] }),
    profile('knowledge', { dependsOn: ['legacy'] }), profile('help'), profile('open'), profile('foundation')]) state.addBuildProfile(p);
  for (const id of ['target', 'sibling']) state.addBranch({ id, projectId: 'p', branch: id, worktreePath: path.join(root, id),
    services: {}, status: 'idle', createdAt: '2026-01-01' });
  state.setBranchExtraProfiles('target', [profile('synthetic')]);
});
afterEach(async () => { await state.flush(); fs.rmSync(root, { recursive: true, force: true }); });
const target = () => state.getBranch('target')!;
const input = () => ({ expectedRevision: state.getBranchServiceIsolationRevision(target()),
  excludedProjectProfileIds: ['legacy'], dependsOnOverrides: { knowledge: ['synthetic'] } });
const isolate = () => state.setBranchServiceIsolation('target', input());

describe('branch service isolation', () => {
  it('six becomes exactly five with no legacy mount, preserving baseline and sibling byte for byte', () => {
    const baseline = JSON.stringify(state.getBuildProfilesForProject('p')), sibling = JSON.stringify(state.getBranch('sibling'));
    expect(state.getEffectiveProfilesForBranch(target())).toHaveLength(6);
    isolate();
    const rows = state.getEffectiveProfilesForBranch(target());
    expect(rows.map(p => p.id)).toEqual(['knowledge', 'help', 'open', 'foundation', 'synthetic']);
    expect(rows.flatMap(p => p.cacheMounts || [])).toEqual([]);
    expect(resolveEffectiveProfile(rows[0], target()).dependsOn).toEqual(['synthetic']);
    expect(JSON.stringify(state.getBuildProfilesForProject('p'))).toBe(baseline);
    expect(JSON.stringify(state.getBranch('sibling'))).toBe(sibling);
    expect(state.getEffectiveProfilesForBranch(state.getBranch('sibling')!)).toHaveLength(5);
  });
  it('survives cold reload and can atomically restore inheritance and the original dependency', async () => {
    isolate(); await state.flush();
    const cold = new StateService(path.join(root, 'state.json'), root); cold.load();
    const b = cold.getBranch('target')!;
    expect(cold.getEffectiveProfilesForBranch(b).map(p => p.id)).not.toContain('legacy');
    cold.setBranchServiceIsolation(b.id, { expectedRevision: cold.getBranchServiceIsolationRevision(b),
      excludedProjectProfileIds: [], dependsOnOverrides: { knowledge: null } });
    expect(cold.getEffectiveProfilesForBranch(b)).toHaveLength(6);
    expect(b.profileOverrides?.knowledge?.dependsOn).toBeUndefined(); await cold.flush();
  });
  it.each([['missing'], ['synthetic'], ['legacy', 'legacy'], [42], 'legacy'])('rejects invalid exclusions %j without writes', ids => {
    const before = JSON.stringify(target());
    expect(() => state.setBranchServiceIsolation('target', { ...input(), excludedProjectProfileIds: ids as string[] })).toThrow();
    expect(JSON.stringify(target())).toBe(before);
  });
  it('rejects stale compare-and-set without mutating dependencies', () => {
    const request = input(); state.setBranchProfileOverride('target', 'help', { containerPort: 8081 });
    expect(() => state.setBranchServiceIsolation('target', request)).toThrow('配置已变化');
    expect(target().excludedProjectProfileIds).toBeUndefined();
  });
  it('rejects a dependency still pointing to the excluded baseline', () => {
    expect(() => state.setBranchServiceIsolation('target', { ...input(), dependsOnOverrides: {} })).toThrow('仍引用');
    expect(target().profileOverrides).toBeUndefined();
  });
  it('rejects new unknown targets and dependency cycles', () => {
    expect(() => state.setBranchServiceIsolation('target', { ...input(), dependsOnOverrides: { knowledge: ['typo'] } })).toThrow('不存在');
    expect(() => state.setBranchServiceIsolation('target', { ...input(), dependsOnOverrides: { knowledge: ['synthetic'], synthetic: ['knowledge'] } })).toThrow('循环');
  });
  it.each(['running', 'starting', 'error'])('rejects unreconciled branch %s', status => {
    target().status = status as BranchEntry['status']; expect(isolate).toThrow('停止并对账');
  });
  it('rejects excluded services with retained stopped container records', () => {
    target().services.legacy = { profileId: 'legacy', containerName: 'old', hostPort: 9000, status: 'stopped' };
    expect(isolate).toThrow('容器或复制集');
  });
  it('keeps subsequent override, baseline and extra changes from reintroducing excluded dependencies', () => {
    isolate();
    expect(() => state.setBranchProfileOverride('target', 'knowledge', { dependsOn: ['legacy'] })).toThrow('仍引用');
    expect(() => state.clearBranchProfileOverride('target', 'knowledge')).toThrow('仍引用');
    expect(() => state.updateBuildProfile('help', { calls: ['legacy'] })).toThrow('仍引用');
    expect(() => state.setBranchExtraProfiles('target', [])).toThrow('不存在');
    expect(() => state.removeBuildProfile('legacy')).toThrow('排除清单');
    expect(target().profileOverrides?.knowledge.dependsOn).toEqual(['synthetic']);
  });
  it('does not allow an extra profile to reuse an excluded baseline id', () => {
    const b = { extraProfiles: [profile('legacy', { command: 'changed' })], excludedProjectProfileIds: ['legacy'] };
    expect(mergeBranchProfiles([profile('legacy'), profile('help')], b).map(p => p.id)).toEqual(['help']);
  });
  it('snapshots capture exclusions and cannot silently restore an old service set', () => {
    const old = state.createConfigSnapshot({ trigger: 'manual', label: 'old', projectId: 'p' }); isolate();
    const current = state.createConfigSnapshot({ trigger: 'manual', label: 'current', projectId: 'p' });
    expect(current.payload.branchConfigs?.target.excludedProjectProfileIds).toEqual(['legacy']);
    expect(() => state.rollbackToConfigSnapshot(old.id)).toThrow('隔离入口');
    expect(() => state.rollbackToConfigSnapshot(current.id)).not.toThrow();
  });
});

// Physical runtime observation is independent from the state ledger above.
import { ContainerService } from '../../src/services/container.js';
import type { IShellExecutor } from '../../src/types.js';
import { vi } from 'vitest';
it.each([
  ['', 0, true], ['exited|synthetic\n', 0, true], ['running|synthetic', 0, false],
  ['exited|legacy', 0, false], ['created|synthetic', 0, false], ['unparseable', 0, false], ['', 1, false],
])('checks actual branch containers with no data or mutation access: %s', async (stdout, exitCode, accepted) => {
  const commands: string[] = [];
  const shell: IShellExecutor = { exec: vi.fn(async (command: string) => { commands.push(command); return { stdout, stderr: '', exitCode }; }) };
  const runtime = new ContainerService(shell, { repoRoot: root, worktreeBase: root, masterPort: 9900, workerPort: 5500,
    dockerNetwork: 'test', portStart: 18000, sharedEnv: {}, jwt: { secret: 'test-only', issuer: 'test' } });
  const result = runtime.assertBranchStoppedForIsolation(target(), ['legacy']);
  if (accepted) await expect(result).resolves.toBeUndefined(); else await expect(result).rejects.toThrow();
  expect(commands).toHaveLength(1); expect(commands[0]).toContain('docker ps -a');
  expect(commands[0]).toContain('cds.branch.id=target'); expect(commands[0]).not.toMatch(/docker (start|run|exec|inspect|volume)/);
});
