import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
// 旧已核验范围保留；把其他已上线版本与本阶段变化分别固定，新增文件不能混入旧黄金。
const previousQualifiedHead = '7b964b87bf8e3c176ece89ccba2d3d160eb0b76b';
const inheritedProductionHead = '0ad65ae3db114c4abf372b7721ef62a53fced681';
const inheritedProductionSourceChanges = ["cds/src/config/known-env-keys.ts", "cds/src/index.ts", "cds/src/infra/state-store/mongo-handle.ts", "cds/src/infra/state-store/mongo-split-handle.ts", "cds/src/middleware/human-project-access.ts", "cds/src/routes/auth-local.ts", "cds/src/routes/bootstrap.ts", "cds/src/routes/branches.ts", "cds/src/routes/deployment-runs.ts", "cds/src/routes/github-webhook.ts", "cds/src/routes/identity.ts", "cds/src/routes/legacy-cleanup.ts", "cds/src/routes/pending-import.ts", "cds/src/routes/project-infra-resync.ts", "cds/src/routes/projects.ts", "cds/src/routes/releases.ts", "cds/src/routes/topology.ts", "cds/src/routes/user-project-access.ts", "cds/src/server.ts", "cds/src/services/agent-workspace-session-runtime.ts", "cds/src/services/artifact-admission.ts", "cds/src/services/credential-self-check.ts", "cds/src/services/cross-project-refs.ts", "cds/src/services/deployment-version.ts", "cds/src/services/forwarder-route-publisher.ts", "cds/src/services/github-webhook-dispatcher.ts", "cds/src/services/human-project-access.ts", "cds/src/services/managed-project.ts", "cds/src/services/preview-entrypoints.ts", "cds/src/services/preview-instance-seed.ts", "cds/src/services/preview-mirror.ts", "cds/src/services/preview-slug.ts", "cds/src/services/project-identity-history.ts", "cds/src/services/proxy.ts", "cds/src/services/public-exposure-policy.ts", "cds/src/services/release-strategy.ts", "cds/src/services/state.ts", "cds/src/types.ts"];
const memoryStageHead = '1b84130d1d636ca4553de95f76c43693f3d0465e';
const onboardingProductionHead = 'ccc5dcae5bd1ceda070024d734de8615787efb3e';
const onboardingProductionSourceChanges = ["cds/src/routes/access-requests.ts", "cds/src/routes/projects.ts", "cds/src/services/bootstrap-target.ts", "cds/src/types.ts"];
const notificationProductionHead = '18b49cfc20b18e4d92b4a163575d94e4461dd8c7';
const notificationProductionSourceChanges = ["cds/src/index.ts", "cds/src/routes/alarm-channels.ts", "cds/src/services/alarm-dispatch.ts", "cds/src/services/alarm-identity.ts", "cds/src/services/alarm-relay.ts", "cds/src/services/alarm-route.ts", "cds/src/services/map-notifier.ts", "cds/src/services/monitor-reconcile.ts", "cds/src/services/self-check.ts", "cds/src/services/uptime-custom-monitor.ts", "cds/src/services/uptime-metrics.ts", "cds/src/services/uptime-monitor.ts"];
const cpuStageHead = '09b799cbb47e8439062b0979b68f88c4c4ff1bce';
const coldRecoveryBase = 'f42255b11efc5c1d82b56f86684d283722089699';
const coldRecoveryHead = 'f73832ee568a1134c7f2be521e3fad0813450a68';
const latestProductionHead = '740a5364f13dbd81be2599b8b41fada407a17362';
const latestProductionSourceChanges = ['cds/src/executor/routes.ts', 'cds/src/routes/branches.ts', 'cds/src/services/worktree.ts', 'cds/src/services/bootstrap-target.ts'];
const coldRecoverySourceChanges = ['cds/src/executor/routes.ts', 'cds/src/routes/branches.ts', 'cds/src/services/worktree.ts'];
const cleanupStageSourceChanges = ['cds/src/services/project-admission-order.ts', 'cds/src/routes/branches.ts', 'cds/src/services/isolated-shell-executor.ts', 'cds/src/services/observation-executor-process.ts', 'cds/src/services/observation-process-group.ts', 'cds/src/services/observation-process.ts', 'cds/src/services/observation-supervisor-process.ts', 'cds/src/services/shell-executor.ts', 'cds/src/services/self-update-checkout.ts', 'cds/src/services/self-update-failure-diagnosis.ts'];
const cpuStageSourceChanges = ["cds/src/executor/routes.ts", "cds/src/routes/branches.ts", "cds/src/services/build-gate.ts", "cds/src/services/container.ts", "cds/src/services/deployment-phase-budget.ts", "cds/src/services/docker-lifecycle-classifier.ts", "cds/src/services/project-admission-order.ts"];
const memoryStageSourceChanges = ["cds/src/index.ts", "cds/src/infra/state-store/mongo-split-store.ts", "cds/src/services/container.ts", "cds/src/services/orphan-container-reaper.ts", "cds/src/services/resource-usage-sampler.ts", "cds/src/services/scheduler-service-stop.ts", "cds/src/services/scheduler.ts", "cds/src/services/service-replacement.ts", "cds/src/services/service-runtime.ts"];

export function assertCurrentSourceQualification(expectedPreviousSources: readonly string[], report: Record<string, any>, native = true): void {
  if (native) execFileSync('/usr/bin/git', ['fetch', '--depth', '1', 'origin', previousQualifiedHead, inheritedProductionHead, memoryStageHead, onboardingProductionHead, notificationProductionHead, cpuStageHead, coldRecoveryBase, coldRecoveryHead, latestProductionHead], { stdio: 'pipe', timeout: 120000 });
  const changedSince = (from: string, to: string): string[] => execFileSync('/usr/bin/git', ['diff', '--name-only', from, to, '--', ':(top)cds/src'],
    { encoding: 'utf8' }).trim().split('\n').filter(Boolean).sort();
  report.previousQualifiedHead = previousQualifiedHead;
  report.inheritedProductionHead = inheritedProductionHead;
  assert.deepEqual(changedSince('2884f9a9cffdb6447658b25497beb4f3cacdc6c7', previousQualifiedHead), expectedPreviousSources.map(name => `cds/${name}`).sort());
  report.inheritedCurrentProductionSources = changedSince(previousQualifiedHead, inheritedProductionHead);
  assert.deepEqual(report.inheritedCurrentProductionSources, inheritedProductionSourceChanges.slice().sort());
  report.memoryStageProductionSources = changedSince(inheritedProductionHead, memoryStageHead);
  assert.deepEqual(report.memoryStageProductionSources, memoryStageSourceChanges.slice().sort());
  report.memoryStageHead = memoryStageHead;
  report.onboardingProductionHead = onboardingProductionHead;
  report.onboardingProductionSources = changedSince(memoryStageHead, onboardingProductionHead);
  assert.deepEqual(report.onboardingProductionSources, onboardingProductionSourceChanges.slice().sort());
  report.notificationProductionHead = notificationProductionHead;
  report.notificationProductionSources = changedSince(onboardingProductionHead, notificationProductionHead);
  assert.deepEqual(report.notificationProductionSources, notificationProductionSourceChanges.slice().sort());
  report.cpuStageProductionSources = changedSince(notificationProductionHead, cpuStageHead);
  assert.deepEqual(report.cpuStageProductionSources, cpuStageSourceChanges.slice().sort());
  report.cpuStageHead = cpuStageHead;
  report.coldRecoveryHead = coldRecoveryHead;
  report.coldRecoveryBase = coldRecoveryBase;
  report.inheritedColdRecoverySources = changedSince(coldRecoveryBase, coldRecoveryHead);
  assert.deepEqual(report.inheritedColdRecoverySources, coldRecoverySourceChanges.slice().sort());
  report.latestProductionHead = latestProductionHead;
  report.latestProductionSources = changedSince(cpuStageHead, latestProductionHead);
  assert.deepEqual(report.latestProductionSources, latestProductionSourceChanges.slice().sort());
  report.cleanupStageSources = changedSince(latestProductionHead, report.head);
  assert.deepEqual(report.cleanupStageSources, cleanupStageSourceChanges.slice().sort());
}
