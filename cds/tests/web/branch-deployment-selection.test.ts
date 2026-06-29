import { describe, expect, it } from 'vitest';
import {
  pickActiveDeployment,
  ACTIVE_DEPLOYMENT_TAIL_MS,
} from '../../web/src/components/branchDeploymentSelection.js';
import type { BranchDeploymentItem } from '../../web/src/components/BranchDetailDrawer.js';

// Minimal factory — only the fields pickActiveDeployment reads matter.
function item(p: Partial<BranchDeploymentItem> & { key: string; startedAt: number }): BranchDeploymentItem {
  return {
    branchId: 'b',
    branchName: 'b',
    kind: 'deploy',
    status: 'success',
    message: '',
    log: [],
    finishedAt: undefined,
    ...p,
  } as BranchDeploymentItem;
}

describe('pickActiveDeployment — stale running guard uses finish time (Bugbot Medium)', () => {
  const now = 1_000_000;

  it('returns null for empty input', () => {
    expect(pickActiveDeployment([], now)).toBeNull();
  });

  it('treats a genuine in-progress running (started after everything finished) as active', () => {
    const finishedDeploy = item({ key: 'd1', kind: 'deploy', status: 'success', startedAt: 100, finishedAt: 200 });
    const live = item({ key: 'r1', kind: 'deploy', status: 'running', startedAt: 300, finishedAt: undefined });
    expect(pickActiveDeployment([finishedDeploy, live], now)?.key).toBe('r1');
  });

  it('does NOT pick a stuck running that started before a later-finishing deploy completed', () => {
    // The exact regression Bugbot flagged (realistic timing): a healthy deploy just finished
    // (within the tail window), while a zombie running lingers from an earlier dispatch. The zombie
    // started AFTER the finished deploy's START (now-20s) but BEFORE its FINISH (now-5s). A
    // start-time comparison wrongly keeps the zombie active → 「疑似卡住」; a finish-time comparison
    // treats it as a superseded orphan and surfaces the freshly-finished healthy deploy instead.
    const finishedDeploy = item({ key: 'd1', kind: 'deploy', status: 'success', startedAt: now - 20_000, finishedAt: now - 5_000 });
    const stuck = item({ key: 'zombie', kind: 'deploy', status: 'running', startedAt: now - 8_000, finishedAt: undefined });
    const picked = pickActiveDeployment([finishedDeploy, stuck], now);
    expect(picked?.key).not.toBe('zombie');
    expect(picked?.key).toBe('d1');
  });

  it('falls back to the most recently finished deploy within the tail window when no live running', () => {
    const recent = item({ key: 'd1', kind: 'deploy', status: 'success', startedAt: 100, finishedAt: now - 5_000 });
    expect(now - (recent.finishedAt as number)).toBeLessThanOrEqual(ACTIVE_DEPLOYMENT_TAIL_MS);
    expect(pickActiveDeployment([recent], now)?.key).toBe('d1');
  });

  it('falls back to the newest item when nothing is live or recently finished', () => {
    const old = item({ key: 'd-old', kind: 'deploy', status: 'success', startedAt: 100, finishedAt: 200 });
    const newer = item({ key: 'd-new', kind: 'deploy', status: 'success', startedAt: 500, finishedAt: 600 });
    // Both finished long before `now` (outside tail) → newest by startedAt wins.
    expect(pickActiveDeployment([old, newer], now)?.key).toBe('d-new');
  });
});
