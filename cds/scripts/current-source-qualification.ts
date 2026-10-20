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
const queueProductionHead = '39b6d44764ec47ab916ad4134b2e574542059eac';
const queueProductionSourceChanges = ['cds/src/executor/routes.ts', 'cds/src/index.ts', 'cds/src/routes/branches.ts', 'cds/src/server.ts', 'cds/src/services/branch-operation-coordinator.ts', 'cds/src/services/container.ts', 'cds/src/services/deployment-phase-budget.ts', 'cds/src/services/deployment-run.ts'];
const localQueueProductionHead = '2db92a866e6b935efae35e320dc3777da810dfa4';
const localQueueProductionSourceChanges = ['cds/src/executor/routes.ts', 'cds/src/routes/branches.ts', 'cds/src/services/deployment-run.ts'];
const alarmQueueProductionHead = 'f5ed37799f95967d66b57c95c4d3425a68a3bed8';
const alarmQueueProductionSources = ['cds/src/index.ts', 'cds/src/routes/alarm-channels.ts', 'cds/src/services/alarm-dispatch.ts', 'cds/src/services/phone-dispatch-queue.ts'];
const cleanupQualificationProductionHead = '97dee9019981fe99b4a8ebb6cb280db53e56abb1';
const cleanupPublishedHead = 'a36cd0cfd32fb842ceba34dc2824391bcccdada4';
const combinedProductionHead = '5d7f3d71311b0805e9b8f081d333d96d180096fc';
const widgetStreamQualifiedHead = 'e90d801c80f9932e0a827c040bb8b8babd8c8200';
const widgetTerminalFixHead = '6691622edd78a372f9d8ee5892246bf8f481def2';
const frozenIntegrationHead = '4c156073c89644c202203ce989dd0d97c60f2be8';
const diagnosticInstrumentationHead = '63299420f0a060be0e18aa81bcc7591f25ca27fa';
const receiptEvidenceHead = '01bf9f5bd21c811cd94d34ca2969e9fbb7d45706';
const memoryRescanHead = 'badfb6009331c8c387fe0d9c0101a2b80cae6baa';
const latestMaintenanceHead = 'bb8ac00df48554f2f94d343684aace3b377d357c';
const preColdIntegrationHead = 'ce42946cc2f41ceebcfa217f0d8bf3b029acf692';
const coldReviewFixBase = 'e81cb20c13145a2f5a953ab70fd4a7f8f0679979';
const coldReviewFixHead = '5027c9be2fd51089e77cd01813de1a634003d5a8';
const coldIntegratedQualifiedHead = '2ca6cf71f5871ce0b18581ebc5fa735ebfc09c5d';
const tutorialMaintenanceHead = 'cd1c7bba9570670b949137215718e59067f1f434';
const tutorialIntegratedHead = 'cc7e9beff8e116304fc86ba9bb22cd91730aae06';
const tutorialQualificationFixedHead = '0bb6d4bd44e89faeb8e0d53c9e721acb9fa3ddc6';
const capacityHintHead = '4bddfd87ab24d21301e6ea052ca8a24206abbe47';
const structuredColdHead = '7cc15c706f5f751dff9af134201f6c5d1abbd9c3';
const structuredColdValidatedHead = '4ee6554c57b35720ef8fab0d929b7aacb1e61403';
const structuredIntegratedHead = 'c48691a282f1133277d6336418352f90bf361b63';
const cleanupWindowFixBase = 'f2dfcfd95e7610e238b14b8eabd1fd7becd126ef';
const cleanupWindowFixHead = 'fc8da8e83f447fed9c3529ff9e1aedbbcc28e2bf';
const cleanupIntegratedHead = '049e1e8307dc94a55e1819066f7dbdf3e8b8a0fd';
const schedulerTouchHead = '370b0d2ac8c1c70924d0bf9cebe5778a81e01027';
const markerSummaryHead = 'f233e1844d51d59cbd7e4f90ae0805cd450c2d03';
const markerSummaryFiles = ['cds/src/forwarder/preview-activity.ts', 'cds/tests/forwarder/preview-activity.test.ts', 'cds/tests/services/scheduler-forwarder-activity.test.ts', 'changelogs/2026-10-15_cds-forwarder-preview-activity.md', 'doc/debt.cds.md'];
const cleanupWindowFiles = ['cds/src/services/agent-workspace-session-runtime.ts', 'cds/tests/services/agent-workspace-capability-cleanup.test.ts', 'changelogs/2026-10-16_cds-probe-cleanup-expiry.md'];
const structuredColdSources = ['cds/src/executor/routes.ts', 'cds/src/routes/branches.ts', 'cds/src/services/worktree.ts'];
const tutorialMaintenanceWebFiles = ['cds/web/public/tutorials/starter-lab/app.js', 'cds/web/public/tutorials/starter-lab/chapters.json', 'cds/web/public/tutorials/starter-lab/index.html', 'cds/web/public/tutorials/starter-lab/media/original-identity-recovery-complete.png', 'cds/web/public/tutorials/starter-lab/media/original-identity-recovery.mp4', 'cds/web/public/tutorials/starter-lab/media/original-identity-recovery.vtt', 'cds/web/public/tutorials/starter-lab/original-identity-recovery-facts.json'];
const memoryRescanSources = ['cds/src/index.ts', 'cds/src/services/container.ts', 'cds/src/services/deployment-phase-budget.ts'];
const latestMaintenanceSources = ['cds/src/index.ts', 'cds/src/middleware/github-auth.ts', 'cds/src/routes/access-requests.ts', 'cds/src/routes/identity-connections.ts', 'cds/src/routes/identity.ts', 'cds/src/routes/projects.ts', 'cds/src/routes/user-project-access.ts', 'cds/src/server.ts', 'cds/src/services/access-recovery.ts', 'cds/src/services/alarm-route.ts', 'cds/src/services/phone-dispatch-queue.ts', 'cds/src/services/state.ts', 'cds/src/services/uptime-monitor.ts', 'cds/src/types.ts'];
const preColdOwnSources = ['cds/src/forwarder-main.ts', 'cds/src/forwarder/control-plane-stream.ts', 'cds/src/forwarder/diagnostic-routes.ts', 'cds/src/forwarder/preview-activity.ts', 'cds/src/forwarder/proxy-handler.ts', 'cds/src/forwarder/types.ts', 'cds/src/index.ts', 'cds/src/services/container.ts', 'cds/src/services/deployment-phase-budget.ts', 'cds/src/services/probe-marker.ts', 'cds/src/services/scheduler.ts', 'cds/src/services/self-check.ts', 'cds/src/widget-script.ts'];

const previewActivityHead = 'd4d4c82f7c0346d5de09d4d4aa11c6d2878be9f9';
const previewActivitySources = ['cds/src/forwarder-main.ts', 'cds/src/forwarder/diagnostic-routes.ts', 'cds/src/forwarder/preview-activity.ts', 'cds/src/forwarder/proxy-handler.ts', 'cds/src/index.ts', 'cds/src/services/probe-marker.ts', 'cds/src/services/scheduler.ts', 'cds/src/services/self-check.ts'];
const combinedProductionSources = ['cds/src/executor/routes.ts', 'cds/src/routes/branches.ts', 'cds/src/services/artifact-admission.ts', 'cds/src/services/container.ts', 'cds/src/services/deployment-version.ts', 'cds/src/services/prebuilt-reuse.ts', 'cds/src/services/worktree.ts', 'cds/src/types.ts', 'cds/src/widget-script.ts'];
const widgetStreamSources = ['cds/src/forwarder-main.ts', 'cds/src/forwarder/control-plane-stream.ts', 'cds/src/forwarder/diagnostic-routes.ts', 'cds/src/forwarder/proxy-handler.ts', 'cds/src/forwarder/types.ts', 'cds/src/index.ts', 'cds/src/services/self-check.ts', 'cds/src/widget-script.ts'];
const cleanupQualificationProductionSources = ['cds/src/routes/branches.ts', 'cds/src/services/container.ts', 'cds/src/services/service-replacement.ts'];
const coldRecoverySourceChanges = ['cds/src/executor/routes.ts', 'cds/src/routes/branches.ts', 'cds/src/services/worktree.ts'];
const cleanupStageSourceChanges = ['cds/src/services/worktree.ts', 'cds/src/services/project-admission-order.ts', 'cds/src/routes/branches.ts', 'cds/src/services/isolated-shell-executor.ts', 'cds/src/services/observation-executor-process.ts', 'cds/src/services/observation-process-group.ts', 'cds/src/services/observation-process.ts', 'cds/src/services/observation-supervisor-process.ts', 'cds/src/services/shell-executor.ts', 'cds/src/services/self-update-checkout.ts', 'cds/src/services/self-update-failure-diagnosis.ts'];
const cpuStageSourceChanges = ["cds/src/executor/routes.ts", "cds/src/routes/branches.ts", "cds/src/services/build-gate.ts", "cds/src/services/container.ts", "cds/src/services/deployment-phase-budget.ts", "cds/src/services/docker-lifecycle-classifier.ts", "cds/src/services/project-admission-order.ts"];
const memoryStageSourceChanges = ["cds/src/index.ts", "cds/src/infra/state-store/mongo-split-store.ts", "cds/src/services/container.ts", "cds/src/services/orphan-container-reaper.ts", "cds/src/services/resource-usage-sampler.ts", "cds/src/services/scheduler-service-stop.ts", "cds/src/services/scheduler.ts", "cds/src/services/service-replacement.ts", "cds/src/services/service-runtime.ts"];

const historicalMarkerIntegrationHead = '9bb6332a22a025db2c80c1719a037653e1ae3224';
const maintenanceHead = '55fee70da90e38555a640120cc775097383dafa4';
const maintenanceTree = '96f92404dbc311088b551c2de9d631b5d0c45fe9';
const maintenanceSourceTree = '775d6a066fd21dc90a1f46a58b5d6f2e7bc13bce';
const maintenanceWebTree = 'e8db9b82b3dbad4a532c6512b76a5705ee2aa86d';
const functionalHead = 'a98fd18a515627bdf7279443b2de6a545ed88b08';
const functionalTree = '59a051dd88d22652a27647c86023992751a1af90';
const functionalSourceTree = '8971f77fdfdbf77cb34862615bc5ca67edf2d0c0';
const onlinePreservedHead = '9acc295615dc8c7c68e26c3e34f584fbc5b7180a';
const onlinePreservedTree = '50cb59ecaeea326c268db33be9c3088bbaea0ea3';
const onlinePreservedWebTree = 'c412f4a163ffab7b6ec5fcf83078bea0fe4b027a';
const preservedHead = '78f3dbc35d5d15db4aeb9ce9e13448a344d0d295';
const preservedTree = '05120e9adc192ec7da6b37013ae35e746f8aa471';
// 分层固定历史、维护、功能H、已上线9acc与保留层C，不扩大任何旧黄金允许范围。
const maintenanceManifest = [
  ['M', '.claude/skills/cds/SKILL.md'],
  ['M', '.github/workflows/cds-prebuilt.yml'],
  ['M', 'CHANGELOG.md'],
  ['M', 'cds/exec_cds.sh'],
  ['M', 'cds/scripts/mobile-layout-smoke.mjs'],
  ['M', 'cds/src/index.ts'],
  ['M', 'cds/src/routes/branches.ts'],
  ['M', 'cds/src/server.ts'],
  ['A', 'cds/src/services/branch-runtime-recovery.ts'],
  ['M', 'cds/src/services/container.ts'],
  ['M', 'cds/src/services/deploy-drain.ts'],
  ['M', 'cds/src/services/deployment-phase-budget.ts'],
  ['A', 'cds/src/services/deployment-source-retention.ts'],
  ['M', 'cds/src/services/janitor.ts'],
  ['M', 'cds/src/services/self-restart-wait.ts'],
  ['M', 'cds/src/services/self-update-failure-diagnosis.ts'],
  ['M', 'cds/src/services/stack-detector.ts'],
  ['M', 'cds/src/services/worktree-directory-removal-process.ts'],
  ['M', 'cds/src/services/worktree.ts'],
  ['M', 'cds/tests/routes/branches.test.ts'],
  ['M', 'cds/tests/routes/pending-replay-server-auth.test.ts'],
  ['A', 'cds/tests/routes/self-update-drain-cancellation.test.ts'],
  ['M', 'cds/tests/scripts/exec-cds-nginx-template.test.ts'],
  ['A', 'cds/tests/services/branch-runtime-recovery.test.ts'],
  ['M', 'cds/tests/services/container.test.ts'],
  ['M', 'cds/tests/services/deploy-drain.test.ts'],
  ['M', 'cds/tests/services/deployment-memory-lifecycle.test.ts'],
  ['A', 'cds/tests/services/deployment-source-retention.test.ts'],
  ['M', 'cds/tests/services/self-restart-wait.test.ts'],
  ['M', 'cds/tests/services/service-replacement-container.test.ts'],
  ['A', 'cds/tests/web/prebuilt-runtime-icon.test.ts'],
  ['A', 'cds/web/src/components/branch/PrebuiltRuntimeIcon.tsx'],
  ['M', 'cds/web/src/components/ui/button.tsx'],
  ['M', 'cds/web/src/index.css'],
  ['M', 'cds/web/src/pages/BranchListPage.tsx'],
  ['M', 'cds/web/src/pages/CdsSettingsPage.tsx'],
  ['M', 'cds/web/src/pages/cds-settings/components.tsx'],
  ['M', 'cds/web/src/pages/cds-settings/tabs/MaintenanceTab.tsx'],
  ['M', 'cds/web/tailwind.config.js'],
  ['A', 'changelogs/2026-10-19_cds-cancel-unsafe-self-update.md'],
  ['A', 'changelogs/2026-10-19_cds-compact-settings-controls.md'],
  ['A', 'changelogs/2026-10-19_cds-compact-settings-navigation.md'],
  ['A', 'changelogs/2026-10-20_CDS历史内存预约身份回收.md'],
  ['M', 'doc/debt.cds.md'],
  ['M', 'doc/debt.cds.selfupdate-prebuilt.md'],
  ['M', 'doc/design.cds.config-tree.md'],
  ['A', 'doc/guide.cds.runtime-recovery.md'],
  ['M', 'doc/guide.list.directory.md'],
  ['M', 'doc/index.yml'],
] as const;
const functionalManifest = [
  ['M', 'cds/src/executor/routes.ts', '9b207198d71a51a8f87fb14d274b02dae04bc54e'],
  ['M', 'cds/src/forwarder-main.ts', '57763ee136e2b285e9ba7a71c5b7a35c07002fb6'],
  ['M', 'cds/src/forwarder/diagnostic-routes.ts', '5c77e3d34d9872d44f40684787ba0afbdb66fdc6'],
  ['M', 'cds/src/forwarder/preview-activity.ts', '173bc190a9585f804fb61decce76b0bd17b87f32'],
  ['M', 'cds/src/forwarder/proxy-handler.ts', '76814ef3eddc0f484714bc66641bd7155c9a3f77'],
  ['M', 'cds/src/index.ts', '951b03a2e570ebc9e508ba25daccf1809543dc58'],
  ['M', 'cds/src/routes/branches.ts', '81c092cd997bd31a535f9d4a285f26d37ff7f035'],
  ['M', 'cds/src/services/artifact-admission.ts', 'b7972c2c378257bc996df64cf9a661cc7f5ec58c'],
  ['M', 'cds/src/services/branch-operation-coordinator.ts', 'b1b01a19283fc827f5e028f08edf0a4bb2c24d92'],
  ['M', 'cds/src/services/deployment-run.ts', 'a7fa1f3629361248d1904dc297df51cf0920864b'],
  ['M', 'cds/src/services/prebuilt-reuse.ts', 'ec536292ea44578119d599f43a30e172a6c2b4a5'],
  ['M', 'cds/src/services/release-git-reader.ts', '7869830f36d05082371e0b51d5f98f089b2aa9c3'],
  ['A', 'cds/src/services/self-update-handoff.ts', '9f598bcb1c5d51ab1fa7a5f61af1c42fb304ec36'],
  ['M', 'cds/src/services/worktree.ts', '4cb12e377f6cc5f005c41f9c2d292dde7d19a4b8'],
  ['M', 'cds/tests/forwarder/preview-activity.test.ts', 'b0e53e7af15167558cedb590511e03278f69247c'],
  ['M', 'cds/tests/infra/mongo-split-store.test.ts', '4ae3694a4d6c04d6587351255867820a2831a8dd'],
  ['M', 'cds/tests/routes/branches.test.ts', '923bc7226237ccb1296cc232db5b8a2cdb50a316'],
  ['M', 'cds/tests/routes/executor-deploy.test.ts', '16bfa935a4068e1052eacb3bfd704b34633ce627'],
  ['M', 'cds/tests/services/artifact-admission-reuse-contract.test.ts', '10cb7044bb93980f6ac3b9a772811ef83411e79b'],
  ['M', 'cds/tests/services/deploy-drain.test.ts', '394a221cb72c3f2deff71e9707fae2091d1e6ef6'],
  ['M', 'cds/tests/services/deployment-intent-recovery.test.ts', '2fbb912579add142d088be523b590f8284095d89'],
  ['M', 'cds/tests/services/deployment-run-stale-lease.test.ts', '34f34bdaa5f2ae5f667efcfdb39e258954b3e4f0'],
  ['M', 'cds/tests/services/scheduler-forwarder-activity.test.ts', '65ac98f222378427ee3331e2ce527bf6e1f2182b'],
  ['A', 'cds/tests/services/self-update-handoff.test.ts', '0c9cf19458dfab2763a8a1168ee79bac47080758'],
  ['M', 'cds/tests/web/self-update-transition.test.ts', 'c2b855629190ec376bf6347822ea0389f2dcbec8'],
  ['M', 'changelogs/2026-10-15_cds-artifact-admission-equivalence.md', '7affef1fed22477334766fc856516cb42f1e5ba2'],
  ['M', 'changelogs/2026-10-15_cds-forwarder-preview-activity.md', 'dcfb355f957e04c46e163ddec984c29f9956ac3e'],
  ['A', 'changelogs/2026-10-16_cds-restart-wait-guards.md', '8ef7dde94d3c67acb2af129a1510e170df588e79'],
  ['M', 'doc/debt.cds.ci-prebuilt.md', 'b6b8d3836c47bc6891d593552e9e87ffff3b2960'],
  ['M', 'doc/debt.cds.md', 'bd8f99e7f8474a972ca3453b8ef01b22b9226d85'],
  ['M', 'doc/debt.cds.selfupdate-prebuilt.md', '97ac1f1567c5f9c1a6025b93bb43cee86fe82580'],
] as const;
const onlinePreservedManifest = [
  ['M', 'cds/web/public/tutorials/starter-lab/app.js', '6994298eda5163e219b7dbf52750e285274d498d'],
  ['M', 'cds/web/public/tutorials/starter-lab/chapters.json', '90b304279bcb1a45082a9586decee538e6af46b4'],
  ['M', 'cds/web/public/tutorials/starter-lab/index.html', 'e34a4b499a77987ce034c8df932b255989f4274b'],
  ['M', 'doc/debt.cds.md', 'bea90ece11efa76b07500bca32ce31b0cd45fabd'],
  ['M', 'doc/guide.cds.tutorial.md', '439822680f95f4fe32323952339964882c6b7dcd'],
] as const;
const preservedManifest = [
  ['M', 'cds/web/public/tutorials/starter-lab/app.js', '6994298eda5163e219b7dbf52750e285274d498d'],
  ['M', 'cds/web/public/tutorials/starter-lab/chapters.json', '90b304279bcb1a45082a9586decee538e6af46b4'],
  ['M', 'cds/web/public/tutorials/starter-lab/index.html', 'e34a4b499a77987ce034c8df932b255989f4274b'],
  ['M', 'doc/debt.cds.md', '217919b225060bb0eaf4afa9b806e0580268fae0'],
  ['M', 'doc/guide.cds.tutorial.md', '439822680f95f4fe32323952339964882c6b7dcd'],
] as const;

// 两个原入口先取回参考版本；原生导入先核执行身份，函数内再核报告身份。
if (process.env.GITHUB_ACTIONS === 'true') {
  const nativeHead = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.equal(process.env.GITHUB_SHA, nativeHead, 'Actions提交必须对应实际检出提交');
}

export function assertCurrentSourceQualification(expectedPreviousSources: readonly string[], report: Record<string, any>, native = true): void {
  const git = (args: string[]): string => execFileSync('/usr/bin/git',
    ['-c', 'core.quotePath=false', ...args], { encoding: 'utf8' }).trim();
  const actualHead = git(['rev-parse', 'HEAD']);
  assert.equal(report.head, actualHead, '报告必须对应实际检出提交');
  report.executionTree = git(['rev-parse', `${actualHead}^{tree}`]);
  report.githubSha = process.env.GITHUB_SHA ?? null;
  if (native || report.githubSha !== null) assert.equal(report.githubSha, actualHead, 'Actions提交必须对应实际检出提交');
  if (native) execFileSync('/usr/bin/git', ['fetch', '--depth', '1', 'origin', previousQualifiedHead, inheritedProductionHead, memoryStageHead, onboardingProductionHead, notificationProductionHead, cpuStageHead, coldRecoveryBase, coldRecoveryHead, latestProductionHead, queueProductionHead, localQueueProductionHead, alarmQueueProductionHead, cleanupQualificationProductionHead, cleanupPublishedHead, combinedProductionHead, widgetStreamQualifiedHead, widgetTerminalFixHead, previewActivityHead, frozenIntegrationHead, diagnosticInstrumentationHead, receiptEvidenceHead, memoryRescanHead, latestMaintenanceHead, preColdIntegrationHead, coldReviewFixBase, coldReviewFixHead, coldIntegratedQualifiedHead, tutorialMaintenanceHead, tutorialIntegratedHead, tutorialQualificationFixedHead, capacityHintHead, structuredColdHead, structuredColdValidatedHead, structuredIntegratedHead, cleanupWindowFixBase, cleanupWindowFixHead, cleanupIntegratedHead, schedulerTouchHead, markerSummaryHead, historicalMarkerIntegrationHead, maintenanceHead, functionalHead, onlinePreservedHead, preservedHead], { stdio: 'pipe', timeout: 120000 });
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
  report.queueProductionHead = queueProductionHead;
  report.queueProductionSources = changedSince(latestProductionHead, queueProductionHead);
  assert.deepEqual(report.queueProductionSources, queueProductionSourceChanges.slice().sort());
  report.localQueueProductionHead = localQueueProductionHead;
  report.localQueueProductionSources = changedSince(queueProductionHead, localQueueProductionHead);
  assert.deepEqual(report.localQueueProductionSources, localQueueProductionSourceChanges.slice().sort());
  report.alarmQueueProductionHead = alarmQueueProductionHead;
  report.alarmQueueProductionSources = changedSince(localQueueProductionHead, alarmQueueProductionHead);
  assert.deepEqual(report.alarmQueueProductionSources, alarmQueueProductionSources.slice().sort());
  report.cleanupQualificationProductionHead = cleanupQualificationProductionHead;
  report.cleanupQualificationProductionSources = changedSince(alarmQueueProductionHead, cleanupQualificationProductionHead);
  assert.deepEqual(report.cleanupQualificationProductionSources, cleanupQualificationProductionSources.slice().sort());
  report.cleanupStageSources = changedSince(cleanupQualificationProductionHead, cleanupPublishedHead);
  assert.deepEqual(report.cleanupStageSources, cleanupStageSourceChanges.slice().sort());
  report.cleanupPublishedHead = cleanupPublishedHead;
  report.combinedProductionHead = combinedProductionHead;
  report.combinedProductionSources = changedSince(cleanupPublishedHead, combinedProductionHead);
  assert.deepEqual(report.combinedProductionSources, combinedProductionSources.slice().sort());
  report.widgetStreamQualifiedHead = widgetStreamQualifiedHead;
  report.widgetStreamSources = changedSince(combinedProductionHead, widgetStreamQualifiedHead);
  assert.deepEqual(report.widgetStreamSources, widgetStreamSources.slice().sort());
  report.widgetTerminalFixHead = widgetTerminalFixHead;
  report.widgetTerminalFixSources = changedSince(widgetStreamQualifiedHead, widgetTerminalFixHead);
  assert.deepEqual(report.widgetTerminalFixSources, ['cds/src/widget-script.ts']);
  report.previewActivityHead = previewActivityHead;
  report.previewActivitySources = changedSince(combinedProductionHead, previewActivityHead);
  assert.deepEqual(report.previewActivitySources, previewActivitySources.slice().sort());
  report.finalStreamIntegrationSources = changedSince(previewActivityHead, frozenIntegrationHead);
  assert.deepEqual(report.finalStreamIntegrationSources, widgetStreamSources.slice().sort());
  // Actions是浅检出；直接读取本次普通整合提交的原始父记录，不把浅边界误判为丢失继承。
  report.finalIntegrationParents = execFileSync('/usr/bin/git', ['cat-file', '-p', frozenIntegrationHead], { encoding: 'utf8' })
    .split('\n\n')[0].split('\n').filter(line => line.startsWith('parent ')).map(line => line.slice(7)).sort();
  assert.deepEqual(report.finalIntegrationParents, [widgetTerminalFixHead, previewActivityHead].sort());
  report.frozenIntegrationHead = frozenIntegrationHead;
  report.diagnosticFollowupSources = changedSince(frozenIntegrationHead, diagnosticInstrumentationHead);
  assert.deepEqual(report.diagnosticFollowupSources, []);
  report.diagnosticInstrumentationHead = diagnosticInstrumentationHead;
  report.diagnosticInstrumentationParents = execFileSync('/usr/bin/git', ['cat-file', '-p', diagnosticInstrumentationHead], { encoding: 'utf8' })
    .split('\n\n')[0].split('\n').filter(line => line.startsWith('parent ')).map(line => line.slice(7));
  assert.deepEqual(report.diagnosticInstrumentationParents, [frozenIntegrationHead]);
  const rawParents = (head: string): string[] => execFileSync('/usr/bin/git', ['cat-file', '-p', head], { encoding: 'utf8' })
    .split('\n\n')[0].split('\n').filter(line => line.startsWith('parent ')).map(line => line.slice(7));
  const parents = (head: string): string[] => rawParents(head).sort();
  report.receiptEvidenceHead = receiptEvidenceHead;
  report.receiptEvidenceSources = changedSince(diagnosticInstrumentationHead, receiptEvidenceHead);
  assert.deepEqual(report.receiptEvidenceSources, []);
  report.receiptEvidenceParents = parents(receiptEvidenceHead);
  assert.deepEqual(report.receiptEvidenceParents, [diagnosticInstrumentationHead]);
  report.memoryRescanHead = memoryRescanHead;
  report.memoryRescanSources = changedSince(receiptEvidenceHead, memoryRescanHead);
  assert.deepEqual(report.memoryRescanSources, memoryRescanSources.slice().sort());
  report.memoryRescanParents = parents(memoryRescanHead);
  assert.deepEqual(report.memoryRescanParents, [receiptEvidenceHead]);
  report.latestMaintenanceHead = latestMaintenanceHead;
  report.latestMaintenanceSources = changedSince(combinedProductionHead, latestMaintenanceHead);
  assert.deepEqual(report.latestMaintenanceSources, latestMaintenanceSources.slice().sort());
  report.preColdIntegrationHead = preColdIntegrationHead;
  report.preColdOwnSources = changedSince(latestMaintenanceHead, preColdIntegrationHead);
  assert.deepEqual(report.preColdOwnSources, preColdOwnSources.slice().sort());
  report.preColdIntegrationParents = parents(preColdIntegrationHead);
  assert.deepEqual(report.preColdIntegrationParents, [memoryRescanHead, latestMaintenanceHead].sort());
  report.coldReviewFixBase = coldReviewFixBase;
  report.coldReviewFixHead = coldReviewFixHead;
  report.coldReviewFixSources = changedSince(coldReviewFixBase, coldReviewFixHead);
  assert.deepEqual(report.coldReviewFixSources, ['cds/src/services/worktree.ts']);
  report.coldReviewFixParents = parents(coldReviewFixHead);
  assert.deepEqual(report.coldReviewFixParents, [coldReviewFixBase]);
  report.currentColdIntegrationSources = changedSince(preColdIntegrationHead, coldIntegratedQualifiedHead);
  assert.deepEqual(report.currentColdIntegrationSources, ['cds/src/services/worktree.ts']);
  report.coldIntegratedParents = parents(coldIntegratedQualifiedHead);
  assert.deepEqual(report.coldIntegratedParents, [preColdIntegrationHead, coldReviewFixHead].sort());
  report.tutorialMaintenanceSources = changedSince(latestMaintenanceHead, tutorialMaintenanceHead);
  assert.deepEqual(report.tutorialMaintenanceSources, []);
  report.currentSourcesAfterCold = changedSince(coldIntegratedQualifiedHead, tutorialIntegratedHead);
  assert.deepEqual(report.currentSourcesAfterCold, []);
  const changedWeb = (base: string, head: string): string[] => execFileSync('/usr/bin/git',
    ['diff', '--name-only', base, head, '--', ':(top)cds/web'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).sort();
  report.tutorialMaintenanceWebFiles = changedWeb(latestMaintenanceHead, tutorialMaintenanceHead);
  assert.deepEqual(report.tutorialMaintenanceWebFiles, tutorialMaintenanceWebFiles.slice().sort());
  report.currentWebAfterCold = changedWeb(coldIntegratedQualifiedHead, tutorialIntegratedHead);
  assert.deepEqual(report.currentWebAfterCold, tutorialMaintenanceWebFiles.slice().sort());
  report.tutorialIntegratedParents = parents(tutorialIntegratedHead);
  assert.deepEqual(report.tutorialIntegratedParents, [coldIntegratedQualifiedHead, tutorialMaintenanceHead].sort());
  assert.deepEqual(changedSince(tutorialIntegratedHead, tutorialQualificationFixedHead), []);
  assert.deepEqual(changedWeb(tutorialIntegratedHead, tutorialQualificationFixedHead), []);
  report.tutorialQualificationParents = parents(tutorialQualificationFixedHead);
  assert.deepEqual(report.tutorialQualificationParents, [tutorialIntegratedHead]);
  report.currentCapacityHintSources = changedSince(tutorialQualificationFixedHead, capacityHintHead);
  assert.deepEqual(report.currentCapacityHintSources, ['cds/src/routes/branches.ts']);
  assert.deepEqual(changedWeb(tutorialQualificationFixedHead, capacityHintHead), []);
  report.capacityHintParents = parents(capacityHintHead);
  assert.deepEqual(report.capacityHintParents, [tutorialQualificationFixedHead]);
  report.structuredColdSources = changedSince(coldReviewFixHead, structuredColdHead);
  assert.deepEqual(report.structuredColdSources, structuredColdSources.slice().sort());
  report.structuredColdParents = parents(structuredColdHead);
  assert.deepEqual(report.structuredColdParents, [coldReviewFixHead]);
  report.fixtureOnlySources = changedSince(structuredColdHead, structuredColdValidatedHead);
  assert.deepEqual(report.fixtureOnlySources, []);
  report.fixtureOnlyFiles = execFileSync('/usr/bin/git', ['diff', '--name-only', structuredColdHead,
    structuredColdValidatedHead], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).sort();
  assert.deepEqual(report.fixtureOnlyFiles, ['cds/tests/routes/github-webhook.test.ts', 'changelogs/2026-10-16_cds-github-http-fixture.md']);
  report.structuredColdValidatedParents = parents(structuredColdValidatedHead);
  assert.deepEqual(report.structuredColdValidatedParents, [structuredColdHead]);
  report.finalStructuredIntegrationSources = changedSince(capacityHintHead, structuredIntegratedHead);
  assert.deepEqual(report.finalStructuredIntegrationSources, structuredColdSources.slice().sort());
  assert.deepEqual(changedWeb(capacityHintHead, structuredIntegratedHead), []);
  report.structuredIntegratedParents = parents(structuredIntegratedHead);
  assert.deepEqual(report.structuredIntegratedParents, [capacityHintHead, structuredColdValidatedHead].sort());
  report.cleanupWindowFixSources = changedSince(cleanupWindowFixBase, cleanupWindowFixHead);
  assert.deepEqual(report.cleanupWindowFixSources, ['cds/src/services/agent-workspace-session-runtime.ts']);
  report.cleanupWindowFixFiles = execFileSync('/usr/bin/git', ['diff', '--name-only', cleanupWindowFixBase,
    cleanupWindowFixHead], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).sort();
  assert.deepEqual(report.cleanupWindowFixFiles, cleanupWindowFiles.slice().sort());
  report.cleanupWindowFixParents = parents(cleanupWindowFixHead);
  assert.deepEqual(report.cleanupWindowFixParents, [cleanupWindowFixBase]);
  report.currentCleanupSources = changedSince(structuredIntegratedHead, cleanupIntegratedHead);
  assert.deepEqual(report.currentCleanupSources, ['cds/src/services/agent-workspace-session-runtime.ts']);
  assert.deepEqual(changedWeb(structuredIntegratedHead, cleanupIntegratedHead), []);
  report.currentCleanupFiles = execFileSync('/usr/bin/git', ['diff', '--name-only', structuredIntegratedHead,
    cleanupIntegratedHead], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).sort();
  assert.deepEqual(report.currentCleanupFiles, [...cleanupWindowFiles, 'cds/scripts/current-source-qualification.ts'].sort());
  report.cleanupIntegratedParents = parents(cleanupIntegratedHead);
  assert.deepEqual(report.cleanupIntegratedParents, [structuredIntegratedHead]);
  report.schedulerTouchSources = changedSince(cleanupIntegratedHead, schedulerTouchHead);
  assert.deepEqual(report.schedulerTouchSources, ['cds/src/services/scheduler.ts']);
  assert.deepEqual(changedWeb(cleanupIntegratedHead, schedulerTouchHead), []);
  report.schedulerTouchFiles = execFileSync('/usr/bin/git', ['diff', '--name-only', cleanupIntegratedHead,
    schedulerTouchHead], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).sort();
  assert.deepEqual(report.schedulerTouchFiles, ['cds/scripts/current-source-qualification.ts',
    'cds/src/services/scheduler.ts', 'cds/tests/infra/mongo-split-store.test.ts',
    'changelogs/2026-10-16_cds-scheduler-touch-scope.md'].sort());
  report.schedulerTouchParents = parents(schedulerTouchHead);
  assert.deepEqual(report.schedulerTouchParents, [cleanupIntegratedHead]);
  report.markerSummarySources = changedSince(previewActivityHead, markerSummaryHead);
  assert.deepEqual(report.markerSummarySources, ['cds/src/forwarder/preview-activity.ts']);
  report.markerSummaryFiles = execFileSync('/usr/bin/git', ['diff', '--name-only', previewActivityHead,
    markerSummaryHead], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).sort();
  assert.deepEqual(report.markerSummaryFiles, markerSummaryFiles.slice().sort());
  assert.deepEqual(parents(markerSummaryHead), [previewActivityHead]);
  report.historicalMarkerIntegrationHead = historicalMarkerIntegrationHead;
  report.historicalMarkerSources = changedSince(schedulerTouchHead, historicalMarkerIntegrationHead);
  assert.deepEqual(report.historicalMarkerSources, ['cds/src/forwarder/preview-activity.ts']);
  assert.deepEqual(changedWeb(schedulerTouchHead, historicalMarkerIntegrationHead), []);
  report.historicalMarkerFiles = execFileSync('/usr/bin/git', ['diff', '--name-only', schedulerTouchHead,
    historicalMarkerIntegrationHead], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).sort();
  assert.deepEqual(report.historicalMarkerFiles, [...markerSummaryFiles, 'cds/scripts/current-source-qualification.ts'].sort());
  report.historicalMarkerParents = parents(historicalMarkerIntegrationHead);
  assert.deepEqual(report.historicalMarkerParents, [schedulerTouchHead, markerSummaryHead].sort());

  const changedFiles = (from: string, to: string): string[] =>
    git(['diff', '--name-status', '--no-renames', from, to]).split('\n').filter(Boolean).sort();
  const tree = (head: string, subtree?: string): string =>
    git(['rev-parse', subtree ? `${head}:${subtree}` : `${head}^{tree}`]);
  const pathsUnder = (manifest: readonly (readonly string[])[], prefix: string): string[] =>
    manifest.map(entry => entry[1]).filter(name => name.startsWith(prefix)).sort();
  const manifestBlobs = (head: string, manifest: readonly (readonly string[])[]): string[] =>
    git(['ls-tree', '-r', '--full-tree', head, '--', ...manifest.map(([, name]) => name)])
      .split('\n').filter(Boolean).map(line => {
        const [metadata, name] = line.split('\t');
        return `${name}\t${metadata.split(' ')[2]}`;
      }).sort();
  const maintenance = {
    head: maintenanceHead,
    tree: tree(maintenanceHead),
    sourceTree: tree(maintenanceHead, 'cds/src'),
    webTree: tree(maintenanceHead, 'cds/web'),
    parents: rawParents(maintenanceHead),
    files: changedFiles(historicalMarkerIntegrationHead, maintenanceHead),
    sources: changedSince(historicalMarkerIntegrationHead, maintenanceHead),
    web: changedWeb(historicalMarkerIntegrationHead, maintenanceHead),
  };
  report.maintenanceQualification = maintenance;
  assert.equal(maintenance.tree, maintenanceTree);
  assert.equal(maintenance.sourceTree, maintenanceSourceTree);
  assert.equal(maintenance.webTree, maintenanceWebTree);
  assert.deepEqual(maintenance.parents, ['d7e2169e08ccc67bcd946aeaa7c3fcfd11eadaf5']);
  assert.deepEqual(maintenance.files, maintenanceManifest.map(([status, name]) => `${status}\t${name}`).sort());
  assert.deepEqual(maintenance.sources, pathsUnder(maintenanceManifest, 'cds/src/'));
  assert.deepEqual(maintenance.web, pathsUnder(maintenanceManifest, 'cds/web/'));
  const functional = {
    head: functionalHead,
    tree: tree(functionalHead),
    sourceTree: tree(functionalHead, 'cds/src'),
    webTree: tree(functionalHead, 'cds/web'),
    parents: rawParents(functionalHead),
    files: changedFiles(maintenanceHead, functionalHead),
    sources: changedSince(maintenanceHead, functionalHead),
    web: changedWeb(maintenanceHead, functionalHead),
    blobs: manifestBlobs(functionalHead, functionalManifest),
  };
  report.functionalQualification = functional;
  assert.equal(functional.tree, functionalTree);
  assert.equal(functional.sourceTree, functionalSourceTree);
  assert.equal(functional.webTree, maintenanceWebTree);
  assert.deepEqual(functional.parents, [maintenanceHead]);
  assert.deepEqual(functional.files, functionalManifest.map(([status, name]) => `${status}\t${name}`).sort());
  assert.deepEqual(functional.sources, pathsUnder(functionalManifest, 'cds/src/'));
  assert.deepEqual(functional.web, []);
  assert.deepEqual(functional.blobs, functionalManifest.map(([, name, blob]) => `${name}\t${blob}`).sort());
  const onlinePreserved = {
    head: onlinePreservedHead,
    tree: tree(onlinePreservedHead),
    sourceTree: tree(onlinePreservedHead, 'cds/src'),
    webTree: tree(onlinePreservedHead, 'cds/web'),
    parents: rawParents(onlinePreservedHead),
    files: changedFiles(maintenanceHead, onlinePreservedHead),
    sources: changedSince(maintenanceHead, onlinePreservedHead),
    web: changedWeb(maintenanceHead, onlinePreservedHead),
    blobs: manifestBlobs(onlinePreservedHead, onlinePreservedManifest),
  };
  report.onlinePreservedQualification = onlinePreserved;
  assert.equal(onlinePreserved.tree, onlinePreservedTree);
  assert.equal(onlinePreserved.sourceTree, maintenanceSourceTree);
  assert.equal(onlinePreserved.webTree, onlinePreservedWebTree);
  assert.deepEqual(onlinePreserved.parents, [maintenanceHead]);
  assert.deepEqual(onlinePreserved.files, onlinePreservedManifest.map(([status, name]) => `${status}\t${name}`).sort());
  assert.deepEqual(onlinePreserved.sources, []);
  assert.deepEqual(onlinePreserved.web, pathsUnder(onlinePreservedManifest, 'cds/web/'));
  assert.deepEqual(onlinePreserved.blobs, onlinePreservedManifest.map(([, name, blob]) => `${name}\t${blob}`).sort());
  const preserved = {
    head: preservedHead,
    tree: tree(preservedHead),
    sourceTree: tree(preservedHead, 'cds/src'),
    webTree: tree(preservedHead, 'cds/web'),
    parents: rawParents(preservedHead),
    files: changedFiles(functionalHead, preservedHead),
    sources: changedSince(functionalHead, preservedHead),
    web: changedWeb(functionalHead, preservedHead),
    blobs: manifestBlobs(preservedHead, preservedManifest),
  };
  report.preservedQualification = preserved;
  assert.equal(preserved.tree, preservedTree);
  assert.equal(preserved.sourceTree, functionalSourceTree);
  assert.equal(preserved.webTree, onlinePreservedWebTree);
  assert.deepEqual(preserved.parents, [functionalHead, onlinePreservedHead]);
  assert.deepEqual(preserved.files, preservedManifest.map(([status, name]) => `${status}\t${name}`).sort());
  assert.deepEqual(preserved.sources, []);
  assert.deepEqual(preserved.web, pathsUnder(preservedManifest, 'cds/web/'));
  assert.deepEqual(preserved.blobs, preservedManifest.map(([, name, blob]) => `${name}\t${blob}`).sort());
  report.currentParents = rawParents(actualHead);
  report.currentQualificationFiles = changedFiles(preservedHead, actualHead);
  report.currentQualificationSources = changedSince(preservedHead, actualHead);
  report.currentQualificationWeb = changedWeb(preservedHead, actualHead);
  assert.deepEqual(report.currentParents, [preservedHead]);
  assert.deepEqual(report.currentQualificationFiles, ['M\tcds/scripts/current-source-qualification.ts']);
  assert.deepEqual(report.currentQualificationSources, []);
  assert.deepEqual(report.currentQualificationWeb, []);
  assert.equal(tree(actualHead, 'cds/src'), functionalSourceTree);
  assert.equal(tree(actualHead, 'cds/web'), onlinePreservedWebTree);
}
