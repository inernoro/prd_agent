import { describe, expect, it } from 'vitest';
import { shouldRetryInterruptedWebhookDispatch } from '../../src/services/deploy-dispatch-retry.js';
import type { BranchEntry } from '../../src/types.js';
import type { DeployDispatchReconcileResult } from '../../src/services/deploy-dispatch-reconciler.js';

function branch(overrides: Partial<BranchEntry> = {}): BranchEntry {
  return {
    id: 'prd-agent-main',
    projectId: 'prd-agent',
    branch: 'main',
    worktreePath: '/tmp/main',
    status: 'running',
    createdAt: '2026-05-26T10:00:00.000Z',
    lastDeployAt: '2026-05-26T11:00:00.000Z',
    lastDeployDispatchAt: '2026-05-26T12:00:00.000Z',
    lastDeployDispatchCommitSha: 'abc123',
    services: {
      api: {
        profileId: 'api',
        containerName: 'cds-prd-agent-main-api',
        hostPort: 10001,
        status: 'running',
      },
    },
    ...overrides,
  };
}

const result: DeployDispatchReconcileResult = {
  branchId: 'prd-agent-main',
  projectId: 'prd-agent',
  previousStatus: 'dispatching',
  nextStatus: 'interrupted',
  ageMin: 20,
  commitSha: 'abc123',
  dispatchAt: '2026-05-26T12:00:00.000Z',
  reason: 'stale',
};

describe('shouldRetryInterruptedWebhookDispatch', () => {
  it('retries a stale webhook dispatch when no newer terminal user intent exists', () => {
    expect(shouldRetryInterruptedWebhookDispatch(branch(), result)).toMatchObject({
      retry: true,
      reason: 'stale-webhook-dispatch-safe-to-retry',
    });
  });

  it('does not retry after a user stop that happened after the webhook dispatch', () => {
    expect(shouldRetryInterruptedWebhookDispatch(branch({
      status: 'idle',
      lastStoppedAt: '2026-05-26T12:05:00.000Z',
      lastStopSource: 'user',
    }), result)).toMatchObject({
      retry: false,
      reason: 'terminal-stop-after-dispatch:user',
    });
  });

  it('does not retry when a newer successful deploy already covers the dispatch', () => {
    expect(shouldRetryInterruptedWebhookDispatch(branch({
      lastDeployAt: '2026-05-26T12:10:00.000Z',
    }), result)).toMatchObject({
      retry: false,
      reason: 'already-deployed-after-dispatch',
    });
  });

  it('does not retry if the branch dispatch metadata changed since reconcile', () => {
    expect(shouldRetryInterruptedWebhookDispatch(branch({
      lastDeployDispatchCommitSha: 'newer',
    }), result)).toMatchObject({
      retry: false,
      reason: 'dispatch-commit-changed',
    });
  });
});
