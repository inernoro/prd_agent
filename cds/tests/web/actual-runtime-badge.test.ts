import { describe, expect, it } from 'vitest';
import { branchRuntimeBadge, isFullyPrebuilt } from '../../web/src/lib/deploy-runtime-badge.js';

describe('P4-05/P4-06: yellow all actual, blue partial actual', () => {
  const runtime = { kind: 'release' as const, activeProfiles: 2, title: 'actual evidence', prebuiltCoverage: 'all' as const };
  it('configuration alone cannot light any express lightning', () => {
    expect(isFullyPrebuilt(runtime)).toBe(false);
    expect(branchRuntimeBadge({ status: 'stopped', deployRuntime: runtime })?.prebuilt).not.toBe(true);
  });
  it('all actual express is yellow even when a version update is pending', () => {
    const badge = branchRuntimeBadge({ status: 'running', deployRuntime: { ...runtime, actualPrebuiltCoverage: 'all', pendingPublish: true } });
    expect(badge?.lightning).toBe('yellow');
    expect(badge?.label).toContain('配置待生效');
    expect(badge?.className).toContain('text-express-all');
  });
  it('partial express uses a blue lightning and names unknown/source exceptions', () => {
    const badge = branchRuntimeBadge({ status: 'running', deployRuntime: {
      ...runtime, actualPrebuiltCoverage: 'partial', actualPrebuiltProfileIds: ['api'],
      actualSourceProfileIds: ['bootstrap'], unknownRuntimeProfileIds: [],
    } });
    expect(badge?.lightning).toBe('blue');
    expect(badge?.prebuilt).toBe(true);
    expect(badge?.label).toContain('1/2');
    expect(badge?.title).toContain('bootstrap');
  });
  it('does not light stale all/partial runtime evidence on a stopped branch', () => {
    for (const status of ['stopped', 'cold', 'idle']) {
      expect(branchRuntimeBadge({ status, deployRuntime: { ...runtime, actualPrebuiltCoverage: 'all' } })?.lightning).toBeUndefined();
    }
  });
  it('uses the actual denominator including surviving orphan services', () => {
    const badge = branchRuntimeBadge({ status: 'running', deployRuntime: {
      ...runtime, activeProfiles: 1, actualRuntimeProfiles: 2,
      actualPrebuiltCoverage: 'partial', actualPrebuiltProfileIds: ['api'], actualSourceProfileIds: ['bootstrap'],
    } });
    expect(badge?.label).toContain('1/2');
  });

  it('does not invent express configuration for an unknown source branch', () => {
    for (const status of ['running', 'stopped']) {
      const badge = branchRuntimeBadge({ status, deployRuntime: {
        kind: 'source', activeProfiles: 1, prebuilt: false, prebuiltCoverage: 'none', actualPrebuiltCoverage: 'unknown',
      } });
      expect(badge?.label).not.toContain('极速');
      expect(badge?.lightning).toBeUndefined();
    }
  });

});

it('P4-06 yellow coverage remains yellow while an actual target-version mismatch is shown separately', () => {
  const badge = branchRuntimeBadge({ status: 'running', deployRuntime: {
    kind: 'release', activeProfiles: 1, actualPrebuiltCoverage: 'all', actualVersionStatus: 'outdated',
  } });
  expect(badge?.lightning).toBe('yellow');
  expect(badge?.label).toContain('版本待更新');
});
