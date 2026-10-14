import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
// 旧已核验范围保留；把其他已上线版本与本阶段变化分别固定，新增文件不能混入旧黄金。
const previousQualifiedHead = '7b964b87bf8e3c176ece89ccba2d3d160eb0b76b';
const inheritedProductionHead = '88ee2a544c46be567009892bf651e665a608c52c';
const inheritedProductionSourceChanges = ["cds/src/config/known-env-keys.ts", "cds/src/index.ts", "cds/src/infra/state-store/mongo-handle.ts", "cds/src/infra/state-store/mongo-split-handle.ts", "cds/src/middleware/human-project-access.ts", "cds/src/routes/auth-local.ts", "cds/src/routes/bootstrap.ts", "cds/src/routes/branches.ts", "cds/src/routes/deployment-runs.ts", "cds/src/routes/github-webhook.ts", "cds/src/routes/identity.ts", "cds/src/routes/legacy-cleanup.ts", "cds/src/routes/pending-import.ts", "cds/src/routes/project-infra-resync.ts", "cds/src/routes/projects.ts", "cds/src/routes/releases.ts", "cds/src/routes/topology.ts", "cds/src/routes/user-project-access.ts", "cds/src/server.ts", "cds/src/services/agent-workspace-session-runtime.ts", "cds/src/services/artifact-admission.ts", "cds/src/services/credential-self-check.ts", "cds/src/services/cross-project-refs.ts", "cds/src/services/forwarder-route-publisher.ts", "cds/src/services/github-webhook-dispatcher.ts", "cds/src/services/human-project-access.ts", "cds/src/services/managed-project.ts", "cds/src/services/preview-entrypoints.ts", "cds/src/services/preview-instance-seed.ts", "cds/src/services/preview-mirror.ts", "cds/src/services/preview-slug.ts", "cds/src/services/project-identity-history.ts", "cds/src/services/proxy.ts", "cds/src/services/public-exposure-policy.ts", "cds/src/services/release-strategy.ts", "cds/src/services/state.ts", "cds/src/types.ts"];
const memoryStageSourceChanges = ["cds/src/index.ts", "cds/src/infra/state-store/mongo-split-store.ts", "cds/src/services/container.ts", "cds/src/services/orphan-container-reaper.ts", "cds/src/services/resource-usage-sampler.ts", "cds/src/services/scheduler-service-stop.ts", "cds/src/services/scheduler.ts", "cds/src/services/service-replacement.ts", "cds/src/services/service-runtime.ts"];

export function assertCurrentSourceQualification(expectedPreviousSources: readonly string[], report: Record<string, any>, native = true): void {
  if (native) execFileSync('/usr/bin/git', ['fetch', '--depth', '1', 'origin', previousQualifiedHead, inheritedProductionHead], { stdio: 'pipe', timeout: 120000 });
  const changedSince = (from: string, to: string): string[] => execFileSync('/usr/bin/git', ['diff', '--name-only', from, to, '--', ':(top)cds/src'],
    { encoding: 'utf8' }).trim().split('\n').filter(Boolean).sort();
  report.previousQualifiedHead = previousQualifiedHead;
  report.inheritedProductionHead = inheritedProductionHead;
  assert.deepEqual(changedSince('2884f9a9cffdb6447658b25497beb4f3cacdc6c7', previousQualifiedHead), expectedPreviousSources.map(name => `cds/${name}`).sort());
  report.inheritedCurrentProductionSources = changedSince(previousQualifiedHead, inheritedProductionHead);
  assert.deepEqual(report.inheritedCurrentProductionSources, inheritedProductionSourceChanges.slice().sort());
  report.memoryStageProductionSources = changedSince(inheritedProductionHead, report.head);
  assert.deepEqual(report.memoryStageProductionSources, memoryStageSourceChanges.slice().sort());
}
