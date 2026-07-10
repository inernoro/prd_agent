import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DeploymentDiagnosisService, type DeploymentExplanationFacts } from '../../src/services/deployment-diagnosis.js';
import { DeploymentRunService } from '../../src/services/deployment-run.js';
import { DeploymentVersionService } from '../../src/services/deployment-version.js';
import { StateService } from '../../src/services/state.js';

describe('DeploymentDiagnosisService', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function setup(provider?: { explain(facts: DeploymentExplanationFacts): Promise<{ summary: string; actions: string[] }> }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-diagnosis-'));
    dirs.push(dir);
    const state = new StateService(path.join(dir, 'state.json'));
    state.load();
    state.addProject({ id: 'p1', slug: 'p1', name: 'P1' } as any);
    state.addBranch({ id: 'b1', projectId: 'p1', branch: 'main', worktreePath: '/tmp/b1', services: {}, status: 'idle', createdAt: 't' });
    const runs = new DeploymentRunService(state, { idFactory: () => 'dr_1' });
    runs.begin({ projectId: 'p1', branchId: 'b1', trigger: 'manual' });
    runs.append('dr_1', {
      phase: 'build-api', level: 'error', status: 'error',
      message: 'API 失败 TOKEN=top-secret-value error TS2322',
      evidenceRefs: ['service:b1:api'],
    });
    runs.fail('dr_1', {
      code: 'build.compile.typescript', owner: 'code', retryable: false,
      summary: 'TOKEN=top-secret-value TypeScript 编译失败', serviceId: 'api', phase: 'build',
      evidenceRefs: ['deployment-run:dr_1:event:2'], suggestedAction: '修复类型错误',
    });
    return new DeploymentDiagnosisService(runs, new DeploymentVersionService(state), provider);
  }

  it('builds a deterministic explanation from terminal facts and evidence references', () => {
    const diagnosis = setup().deterministic('dr_1');
    expect(diagnosis).toMatchObject({
      runId: 'dr_1', status: 'failed',
      failure: { code: 'build.compile.typescript', owner: 'code', retryable: false },
      actions: ['修复类型错误'],
      ai: { status: 'disabled' },
    });
    expect(diagnosis.evidenceRefs).toContain('deployment-run:dr_1:event:2');
  });

  it('passes only redacted structured facts to the AI provider', async () => {
    let received: DeploymentExplanationFacts | undefined;
    const diagnosis = await setup({
      async explain(facts) {
        received = facts;
        return { summary: '类型检查失败', actions: ['修复首个 TS 错误'] };
      },
    }).explain('dr_1');

    expect(JSON.stringify(received)).not.toContain('top-secret-value');
    expect(received).toMatchObject({
      run: { id: 'dr_1', failure: { code: 'build.compile.typescript' } },
      eventTrail: expect.any(Array),
    });
    expect(diagnosis.ai).toMatchObject({
      status: 'ready', explanation: { summary: '类型检查失败', actions: ['修复首个 TS 错误'] },
    });
  });
});
