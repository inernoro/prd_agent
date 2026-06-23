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

describe('shouldRetryInterruptedWebhookDispatch — 重试风暴护栏 (opt-in options)', () => {
  it('skips retry when the project is paused', () => {
    expect(shouldRetryInterruptedWebhookDispatch(branch(), result, { isProjectPaused: true })).toMatchObject({
      retry: false,
      reason: 'project-paused',
    });
  });

  it('skips retry while an operation is already in progress', () => {
    expect(shouldRetryInterruptedWebhookDispatch(branch({ status: 'building' }), result, {
      skipWhenOperationActive: true,
    })).toMatchObject({
      retry: false,
      reason: 'operation-in-progress:building',
    });
  });

  it('gives up once the retry cap is reached', () => {
    expect(shouldRetryInterruptedWebhookDispatch(branch({ deployDispatchRetryCount: 3 }), result, {
      maxRetries: 3,
    })).toMatchObject({
      retry: false,
      reason: 'retry-cap-reached',
    });
  });

  it('gives up once the dispatch is older than the age cap (anchored on first dispatch)', () => {
    expect(shouldRetryInterruptedWebhookDispatch(branch({
      deployDispatchFirstAt: '2026-05-26T00:00:00.000Z',
    }), result, {
      now: new Date('2026-05-26T12:30:00.000Z'),
      maxAgeMs: 6 * 60 * 60 * 1000,
    })).toMatchObject({
      retry: false,
      reason: 'dispatch-too-old',
    });
  });

  it('holds off during the exponential backoff window', () => {
    expect(shouldRetryInterruptedWebhookDispatch(branch({ deployDispatchRetryCount: 1 }), result, {
      now: new Date('2026-05-26T12:02:00.000Z'),
      baseBackoffMs: 5 * 60 * 1000,
    })).toMatchObject({
      retry: false,
      reason: 'backoff-pending',
    });
  });

  it('still retries when every guard is within budget', () => {
    expect(shouldRetryInterruptedWebhookDispatch(branch({
      deployDispatchRetryCount: 1,
      deployDispatchFirstAt: '2026-05-26T11:55:00.000Z',
    }), result, {
      now: new Date('2026-05-26T12:20:00.000Z'),
      isProjectPaused: false,
      skipWhenOperationActive: true,
      maxRetries: 3,
      maxAgeMs: 6 * 60 * 60 * 1000,
      baseBackoffMs: 5 * 60 * 1000,
    })).toMatchObject({
      retry: true,
      reason: 'stale-webhook-dispatch-safe-to-retry',
    });
  });
});
