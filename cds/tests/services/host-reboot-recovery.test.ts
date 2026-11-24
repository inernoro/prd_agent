import { describe, expect, it } from 'vitest';
import type { BranchEntry } from '../../src/types.js';
import { reconcileHostRebootBranch, type DiscoveredAppContainer } from '../../src/services/startup-reconcile.js';
import { isAutoWakeEligible } from '../../src/services/branch-wake-eligibility.js';
import fs from 'node:fs';

const boot = Date.parse('2026-10-01T00:46:00Z');
function fixture() {
  const branch = { id: 'app-main', projectId: 'app', branch: 'main', status: 'error',
    services: Object.fromEntries(['api', 'web'].map((profileId) => [profileId, {
      profileId, containerName: `c-${profileId}`, hostPort: 1234, status: 'error',
      errorMessage: '容器异常退出，疑似崩溃，需重新部署',
    }])),
  } as BranchEntry;
  const containers = new Map<string, DiscoveredAppContainer>(['api', 'web'].map((profileId) => [`app-main/${profileId}`, {
    profileId, branchId: branch.id, containerName: `c-${profileId}`, running: false,
    exitCode: 255, oomKilled: false, finishedAt: '2026-10-01T00:45:59Z',
  }]));
  return { branch, containers };
}

describe('host reboot recovery', () => {
  it('migrates real reboot exits to demand-driven wake without starting anything on boot', () => {
    const { branch, containers } = fixture();
    expect(reconcileHostRebootBranch(branch, containers, boot, false)).toBe(true);
    expect(branch.status).toBe('idle');
    expect(Object.values(branch.services).map((s) => s.status)).toEqual(['stopped', 'stopped']);
    expect(isAutoWakeEligible(branch, { projectPaused: false })).toBe(true);
    expect(branch.errorMessage).toBeUndefined();
    // A further CDS process restart must not reclassify this intentional idle.
    expect(reconcileHostRebootBranch(branch, containers, boot, false)).toBe(false);
  });

  it.each(['paused', 'user', 'remote', 'missing', 'oom', 'old-exit', 'build-failed', 'unknown-state', 'ci-failed', 'live-sibling', 'deleted'])(
    'preserves %s and does not turn it into an auto-wake candidate', (scenario) => {
      const { branch, containers } = fixture();
      const api = containers.get('app-main/api')!;
      if (scenario === 'user') branch.lastStopSource = 'user';
      if (scenario === 'remote') branch.executorId = 'remote';
      if (scenario === 'missing') containers.delete('app-main/api');
      if (scenario === 'oom') api.oomKilled = true;
      if (scenario === 'old-exit') api.finishedAt = '2026-09-30T12:00:00Z';
      if (scenario === 'build-failed') branch.services.api.errorMessage = '编译失败';
      if (scenario === 'unknown-state') api.exitCode = undefined;
      if (scenario === 'ci-failed') branch.ciImageStatus = 'failed';
      if (scenario === 'live-sibling') api.running = true;
      if (scenario === 'deleted') branch.deleting = true;
      const before = JSON.stringify(branch);
      expect(reconcileHostRebootBranch(branch, containers, boot, scenario === 'paused')).toBe(false);
      expect(JSON.stringify(branch)).toBe(before);
    },
  );

  it('wires Docker evidence, boot reconciliation and admission into the actual wake path', () => {
    const index = fs.readFileSync(new URL('../../src/index.ts', import.meta.url), 'utf8');
    const container = fs.readFileSync(new URL('../../src/services/container.ts', import.meta.url), 'utf8');
    expect(index).toContain('reconcileHostRebootBranch(branch, appContainers, hostBootedAtMs');
    expect(index).toContain('autoWakeAdmission.tryAcquire(slug)');
    expect(index).toContain('finally { releaseAdmission(); }');
    expect(container).toContain('{{.State.OOMKilled}}|{{.State.FinishedAt}}');
  });
});
