import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ReleaseRun } from '../../src/types.js';
import { StateService } from '../../src/services/state.js';
import {
  runWithAgentOperationContext,
  type AgentOperationContext,
} from '../../src/services/agent-operation-context.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';

describe('Agent identity correlation for durable operations', () => {
  let repoRoot: string;
  let service: StateService;
  const context: AgentOperationContext = {
    requestId: 'req_declared_1',
    operationId: 'op_declared_1',
    identity: {
      identityVersion: 1,
      confidence: 'declared',
      agentSessionId: 'cdscli_session_1',
      threadId: 'thread-1',
      turnId: 'turn-1',
      skillName: 'cds-release',
      skillVersion: '0.10.0',
      operationReason: 'test correlation',
    },
  };

  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-agent-identity-'));
    fs.mkdirSync(path.join(repoRoot, '.cds'), { recursive: true });
    service = new StateService(path.join(repoRoot, '.cds', 'state.json'), repoRoot);
    service.load();
  });

  afterEach(async () => {
    await flushAllJsonStateStores();
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  it('persists request, operation and identity on release runs', () => {
    const run = {
      releaseId: 'rel_identity_test',
      projectId: 'prd-agent',
      branchId: 'prd-agent-main',
      commitSha: 'a'.repeat(40),
      artifact: {
        branchId: 'prd-agent-main',
        commitSha: 'a'.repeat(40),
        previewUrl: 'https://example.invalid',
      },
      targetId: 'target-prod',
      planId: 'plan-prod',
      status: 'queued',
      startedAt: new Date().toISOString(),
      logs: [],
      seq: 0,
    } as ReleaseRun;

    runWithAgentOperationContext(context, () => service.addReleaseRun(run));

    expect(service.getReleaseRun(run.releaseId)).toMatchObject({
      requestId: context.requestId,
      operationId: context.operationId,
      agentIdentity: context.identity,
    });
  });

  it('carries identity from active self-update into history after context loss', () => {
    runWithAgentOperationContext(context, () => service.markSelfUpdateActive({
      startedAt: new Date().toISOString(),
      branch: 'main',
      trigger: 'manual',
      actor: 'ai',
    }));

    service.recordSelfUpdate({
      ts: new Date().toISOString(),
      branch: 'main',
      fromSha: 'aaaaaaa',
      toSha: 'bbbbbbb',
      trigger: 'manual',
      status: 'success',
    });

    expect(service.getSelfUpdateHistory(1)[0]).toMatchObject({
      requestId: context.requestId,
      operationId: context.operationId,
      agentIdentity: context.identity,
    });
  });

  it('keeps the originating self-update identity when another context finalizes history', () => {
    runWithAgentOperationContext(context, () => service.markSelfUpdateActive({
      startedAt: new Date().toISOString(),
      branch: 'main',
      trigger: 'manual',
      actor: 'ai',
    }));

    const unrelated: AgentOperationContext = {
      requestId: 'req_unrelated',
      operationId: 'op_unrelated',
      identity: { identityVersion: 0, confidence: 'legacy' },
    };
    runWithAgentOperationContext(unrelated, () => service.recordSelfUpdate({
      ts: new Date().toISOString(),
      branch: 'main',
      fromSha: 'aaaaaaa',
      toSha: 'bbbbbbb',
      trigger: 'manual',
      status: 'success',
    }));

    expect(service.getSelfUpdateHistory(1)[0]).toMatchObject({
      requestId: context.requestId,
      operationId: context.operationId,
      agentIdentity: context.identity,
    });
  });
});
