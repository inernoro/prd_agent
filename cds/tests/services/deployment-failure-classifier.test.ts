import { describe, expect, it } from 'vitest';
import { classifyDeploymentFailure } from '../../src/services/deployment-failure-classifier.js';
import type { DeploymentRun } from '../../src/types.js';

function runWithError(message: string, detail?: Record<string, unknown>): DeploymentRun {
  return {
    id: 'dr_1', projectId: 'p1', branchId: 'b1', trigger: 'manual', status: 'building', phase: 'build',
    seq: 2, firstEventSeq: 1, startedAt: 't', updatedAt: 't', operationId: 'op_1',
    events: [
      { seq: 1, at: 't', phase: 'accepted', level: 'info', status: 'pending', message: 'accepted' },
      { seq: 2, at: 't', phase: 'build-api', level: 'error', status: 'error', message, detail, evidenceRefs: ['container:b1:api'] },
    ],
  };
}

describe('classifyDeploymentFailure', () => {
  it('classifies compiler failures with responsibility and event evidence', () => {
    const failure = classifyDeploymentFailure({
      message: '部分服务启动失败: api',
      phase: 'ready',
      run: runWithError('API 失败\nProgram.cs(3,1): error CS1002: ; expected', { profileId: 'api' }),
    });
    expect(failure).toMatchObject({
      code: 'build.compile.csharp',
      owner: 'code',
      retryable: false,
      serviceId: 'api',
    });
    expect(failure.evidenceRefs).toEqual(expect.arrayContaining([
      'deployment-run:dr_1', 'operation:op_1', 'deployment-run:dr_1:event:2', 'container:b1:api',
    ]));
  });

  it.each([
    ['docker pull failed: manifest unknown', 'artifact.image.pull', 'external', true],
    ['listen EADDRINUSE: address already in use', 'runtime.port.conflict', 'config', true],
    ['readiness probe failed: timeout', 'runtime.readiness.timeout', 'code', false],
    ['state-flush timed out', 'cds.state.persist', 'cds', true],
    ['owning_executor_offline', 'cds.executor.unavailable', 'cds', true],
  ])('classifies %s', (message, code, owner, retryable) => {
    expect(classifyDeploymentFailure({ message, phase: code === 'cds.state.persist' ? 'state-flush' : 'ready' }))
      .toMatchObject({ code, owner, retryable });
  });

  it('falls back to an explicit unknown code instead of inventing a root cause', () => {
    expect(classifyDeploymentFailure({ message: 'unrecognized failure', phase: 'deploy' })).toMatchObject({
      code: 'deploy.unknown', owner: 'unknown', retryable: true,
    });
  });
});
