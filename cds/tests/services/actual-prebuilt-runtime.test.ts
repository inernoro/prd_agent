import { describe, expect, it } from 'vitest';
import { summarizeActualPrebuiltRuntime } from '../../src/services/deploy-runtime.js';

describe('P4-04/P4-05: actual prebuilt coverage', () => {
  const fast = { status: 'running', deployedMode: 'express', deployedPrebuilt: true, deployedImage: 'ghcr.io/imp/api:sha-123' };
  it('requires every expected service to have actual running evidence', () => {
    expect(summarizeActualPrebuiltRuntime(['api', 'worker'], { api: fast, worker: fast }).coverage).toBe('all');
    const missing = summarizeActualPrebuiltRuntime(['api', 'worker'], { api: fast });
    expect(missing.coverage).toBe('partial');
    expect(missing.unknownProfileIds).toEqual(['worker']);
  });
  it('never promotes missing legacy stamps or stopped services from config intent', () => {
    expect(summarizeActualPrebuiltRuntime(['api'], { api: { status: 'running', deployedMode: 'express', deployedImage: 'legacy' } }).coverage).toBe('unknown');
    expect(summarizeActualPrebuiltRuntime(['api'], { api: { ...fast, status: 'stopped' } }).coverage).toBe('unknown');
    expect(summarizeActualPrebuiltRuntime([], {}).coverage).toBe('none');
  });
  it('retains source auxiliary services in the denominator', () => {
    const result = summarizeActualPrebuiltRuntime(['api', 'bootstrap'], {
      api: fast, bootstrap: { status: 'running', deployedPrebuilt: false, deployedImage: 'node:20' },
    });
    expect(result.coverage).toBe('partial');
    expect(result.sourceProfileIds).toEqual(['bootstrap']);
    expect(result.prebuiltProfileIds).toEqual(['api']);
  });
  it('includes surviving containers removed from the configured profile list', () => {
    const result = summarizeActualPrebuiltRuntime(['api'], {
      api: fast, bootstrap: { status: 'running', deployedPrebuilt: false, deployedImage: 'node:20' },
    });
    expect(result.coverage).toBe('partial');
    expect(result.profileIds).toEqual(['api', 'bootstrap']);
    expect(summarizeActualPrebuiltRuntime([], { bootstrap: fast }).coverage).toBe('all');
  });
  it('requires mode stamps and rejects explicit source-mode contradictions', () => {
    expect(summarizeActualPrebuiltRuntime(['api'], { api: { ...fast, deployedMode: undefined } }).coverage).toBe('unknown');
    for (const mode of ['dev', 'dev ', '  ']) expect(summarizeActualPrebuiltRuntime(['api'], { api: { ...fast, deployedMode: mode } }).coverage).toBe('unknown');
  });

});

describe('P4-06: target version is separate from actual express coverage', () => {
  it('requires exact running commit evidence for every actual service', async () => {
    const { summarizeActualRuntimeVersions } = await import('../../src/services/deploy-runtime.js');
    const sha = 'a'.repeat(40);
    const summary = summarizeActualRuntimeVersions(sha, ['api', 'worker'], {
      api: { status: 'running', deployedCommitSha: sha }, worker: { status: 'running', deployedCommitSha: 'b'.repeat(40) },
    });
    expect(summary.status).toBe('outdated');
    expect(summary.outdatedProfileIds).toEqual(['worker']);
    expect(summarizeActualRuntimeVersions(sha, ['api'], { api: { status: 'running' } }).status).toBe('unknown');
    expect(summarizeActualRuntimeVersions('', ['api'], { api: { status: 'running', deployedCommitSha: sha } }).status).toBe('unknown');
    expect(summarizeActualRuntimeVersions(sha, ['api'], { api: { status: 'running', deployedCommitSha: sha } }).status).toBe('current');
  });
});
