import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { BranchOperationCoordinator } from '../../src/services/branch-operation-coordinator.js';
import { captureDeploymentInput, deploymentInputBranch } from '../../src/services/deployment-input.js';
import { resolveEffectiveProfile } from '../../src/services/container.js';
import type { BranchEntry, BuildProfile } from '../../src/types.js';

function provider(coordinator: BranchOperationCoordinator, branch: BranchEntry): () => string[] {
  const file = ts.createSourceFile('index.ts', fs.readFileSync(new URL('../../src/index.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
  let expression: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === 'janitorService' && node.initializer && ts.isNewExpression(node.initializer)) expression = node.initializer.arguments?.[8];
    ts.forEachChild(node, visit);
  };
  visit(file); if (!expression) throw new Error('真实Janitor在途产物接线缺失');
  const context = { branchOperationCoordinator: coordinator, stateService: { getBranch: () => branch }, resolveEffectiveProfile, deploymentInputBranch } as Record<string, unknown>;
  vm.runInNewContext(ts.transpileModule('globalThis.read = (' + expression.getText(file) + ');', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  return context.read as () => string[];
}

describe('真实Janitor装配读取原部署代次输入', () => {
  it.each([false, true])('执行/产物等待期间保留原目标和已选回退，终态解除；waiting=%s', waiting => {
    const target = '2'.repeat(40), old = '1'.repeat(40);
    const branch = { id: 'owned-branch', projectId: 'owned', branch: 'feature', services: {}, status: 'running', githubCommitSha: old,
      createdAt: '2026-11-01T00:00:00Z', profileOverrides: { web: { dockerImage: 'ghcr.io/owned/web:sha-${CDS_COMMIT_SHA}' } } } as BranchEntry;
    const profile = { id: 'web', name: 'web', dockerImage: 'ghcr.io/other/base:latest', containerPort: 80 } as BuildProfile;
    const input = captureDeploymentInput(branch, [profile], { PRIVATE_CANARY: 'never-return-env' }, null, target);
    input.artifactAdmission = { state: 'ready', targetCommitSha: target, checkedAt: '2026-11-01T00:00:00Z', artifacts: [{ profileIds: ['web'], requestedImage: 'ghcr.io/owned/web:sha-' + target,
      selectedImage: 'ghcr.io/owned/web:sha-' + old, image: 'ghcr.io/owned/web@sha256:' + 'a'.repeat(64), revision: old, platform: 'linux/amd64', proof: { kind: 'component-unchanged', buildScope: ['web'] } }] };
    const coordinator = new BranchOperationCoordinator();
    const decision = coordinator.begin({ projectId: 'owned', branchId: branch.id, kind: 'deploy', trigger: 'manual', commitSha: target, commitPinned: true }, { waitForArtifacts: waiting });
    coordinator.rememberDeploymentInput(decision.operationId, decision.generation, input);
    branch.githubCommitSha = 'f'.repeat(40); branch.profileOverrides = { web: { dockerImage: 'ghcr.io/foreign/new:latest' } };
    const read = provider(coordinator, branch);
    expect(read().sort()).toEqual(['ghcr.io/owned/web:sha-' + old, 'ghcr.io/owned/web:sha-' + target].sort());
    expect(JSON.stringify(read())).not.toContain('never-return-env');
    if (decision.lease) coordinator.complete(decision.lease, 'completed'); else coordinator.cancelBranch(branch.id, 'owned cancellation');
    expect(read()).toEqual([]);
  });
});
