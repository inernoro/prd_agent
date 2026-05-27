import { describe, expect, it } from 'vitest';
import { classifyDockerLifecycleEvent } from '../../src/services/docker-lifecycle-classifier.js';

const base = {
  containerName: 'cds-prd-agent-main-api-prd-agent',
  attrs: {},
};

describe('classifyDockerLifecycleEvent', () => {
  it('classifies CDS lifecycle intent as intentional and traceable', () => {
    const result = classifyDockerLifecycleEvent({
      ...base,
      action: 'die',
      exitCode: 137,
      attrs: { signal: '9' },
      lifecycleIntent: {
        containerName: base.containerName,
        kind: 'cds-pre-run-replace',
        reason: '部署前替换同名旧容器',
        requestedAt: new Date().toISOString(),
        requestId: 'req-123',
        operationId: 'op-123',
        actor: 'system:webhook',
        trigger: 'webhook',
        operation: 'deploy-pre-run-replace',
        source: 'container.runService',
      },
    });

    expect(result.source).toBe('cds');
    expect(result.unexpected).toBe(false);
    expect(result.nextServiceStatus).toBe('stopped');
    expect(result.stopClass).toBe('cds-pre-run-replace');
    expect(result.reason).toContain('requestId=req-123');
    expect(result.reason).toContain('operation=deploy-pre-run-replace');
    expect(result.reason).toContain('trigger=webhook');
  });

  it('classifies OOM evidence as oom even when exit code is 137', () => {
    const result = classifyDockerLifecycleEvent({
      ...base,
      action: 'die',
      exitCode: 137,
      oomKilled: true,
      attrs: {},
    });

    expect(result.source).toBe('oom');
    expect(result.unexpected).toBe(true);
    expect(result.nextServiceStatus).toBe('error');
    expect(result.stopClass).toBe('oom-kill');
    expect(result.reason).toContain('OOMKilled=true');
  });

  it('classifies SIGKILL without OOM or CDS intent as external', () => {
    const result = classifyDockerLifecycleEvent({
      ...base,
      action: 'die',
      exitCode: 137,
      attrs: { signal: '9' },
    });

    expect(result.source).toBe('external');
    expect(result.unexpected).toBe(true);
    expect(result.nextBranchStatus).toBe('error');
    expect(result.stopClass).toBe('sigkill-no-oom-evidence');
    expect(result.reason).toContain('没有 OOMKilled 证据');
  });

  it('classifies docker kill events without intent as external docker kill', () => {
    const result = classifyDockerLifecycleEvent({
      ...base,
      action: 'kill',
      exitCode: 137,
      attrs: { signal: '9' },
    });

    expect(result.source).toBe('external');
    expect(result.unexpected).toBe(true);
    expect(result.stopClass).toBe('external-docker-kill');
  });

  it('classifies nonzero die events as application crash', () => {
    const result = classifyDockerLifecycleEvent({
      ...base,
      action: 'die',
      exitCode: 2,
      attrs: {},
    });

    expect(result.source).toBe('crash');
    expect(result.unexpected).toBe(true);
    expect(result.nextServiceStatus).toBe('error');
    expect(result.stopClass).toBe('process-exit-error');
  });

  it('classifies normal exit as system stop, not crash', () => {
    const result = classifyDockerLifecycleEvent({
      ...base,
      action: 'die',
      exitCode: 0,
      attrs: {},
    });

    expect(result.source).toBe('system');
    expect(result.unexpected).toBe(false);
    expect(result.nextBranchStatus).toBe('idle');
    expect(result.stopClass).toBe('normal-exit');
  });
});
