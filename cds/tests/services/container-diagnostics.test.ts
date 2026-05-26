import { afterEach, describe, expect, it } from 'vitest';
import {
  clearContainerLifecycleIntentsForTest,
  findRecentContainerLifecycleIntent,
  recordContainerLifecycleIntent,
} from '../../src/services/container-diagnostics.js';

describe('container lifecycle intent correlation', () => {
  afterEach(() => clearContainerLifecycleIntentsForTest());

  it('matches docker event container names with a leading slash', () => {
    recordContainerLifecycleIntent({
      containerName: 'cds-prd-agent-main-api-prd-agent',
      kind: 'cds-pre-run-replace',
      reason: 'deploy replacement',
      requestId: 'req-123',
      operation: 'deploy-pre-run-replace',
    });

    const intent = findRecentContainerLifecycleIntent('/cds-prd-agent-main-api-prd-agent');
    expect(intent?.kind).toBe('cds-pre-run-replace');
    expect(intent?.reason).toBe('deploy replacement');
    expect(intent?.requestId).toBe('req-123');
    expect(intent?.operation).toBe('deploy-pre-run-replace');
  });

  it('expires stale intents so old CDS actions cannot mask external kills', () => {
    recordContainerLifecycleIntent({
      containerName: 'cds-prd-agent-main-api-prd-agent',
      kind: 'cds-stop',
      reason: 'manual stop',
      requestedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    });

    expect(findRecentContainerLifecycleIntent('cds-prd-agent-main-api-prd-agent')).toBeUndefined();
  });
});
