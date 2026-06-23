import { afterEach, describe, expect, it } from 'vitest';
import {
  recordBuild,
  countBuildsSince,
  summarizeBuildActivity,
  __resetBuildActivityForTests,
} from '../../src/services/build-activity-tracker.js';

afterEach(() => __resetBuildActivityForTests());

describe('build-activity-tracker', () => {
  it('counts builds per project within the recent window', () => {
    recordBuild('p1', 'p1-main', 'webhook');
    recordBuild('p1', 'p1-feat', 'manual');
    recordBuild('p2', 'p2-main', 'webhook');

    const summary = summarizeBuildActivity();
    expect(summary.get('p1')?.recentBuilds1h).toBe(2);
    expect(summary.get('p1')?.recentBuilds24h).toBe(2);
    expect(summary.get('p2')?.recentBuilds1h).toBe(1);
    expect(summary.get('p1')?.lastBuildAt).not.toBeNull();
  });

  it('countBuildsSince respects the since cutoff', () => {
    recordBuild('p1', 'p1-main');
    expect(countBuildsSince('p1', Date.now() - 60_000)).toBe(1);
    // A cutoff in the future excludes everything already recorded.
    expect(countBuildsSince('p1', Date.now() + 60_000)).toBe(0);
  });

  it('falls back to the default project id when none provided', () => {
    recordBuild('', 'orphan-branch');
    expect(summarizeBuildActivity().get('default')?.recentBuilds1h).toBe(1);
  });
});
