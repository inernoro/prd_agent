import type { BranchEntry, BuildProfile, DeploymentCandidateRecord } from '../types.js';
import type { ContainerService } from './container.js';
import type { StateService } from './state.js';
import { createCandidateRuntime } from './service-candidate.js';
import { CandidateJournal, snapshotCandidateServices } from './service-candidate-journal.js';
import { CandidateSwitchCoordinator } from './service-candidate-switch.js';
import { OwnedContainerLifecycle, type OwnedContainerReference } from './owned-container-lifecycle.js';
import { resolveCandidateReplacement } from './candidate-replacement-policy.js';
import { topoSortLayers } from './topo-sort.js';
import { runLayerWithSharedAbort } from './deploy-layer-runner.js';
import { BranchOperationSupersededError } from './branch-operation-coordinator.js';
import { unresolvedCandidateRun } from './candidate-operation-admission.js';

export interface CandidateDeploymentOptions {
  runId: string;
  entry: BranchEntry;
  profiles: BuildProfile[];
  allocatePort(reserved: ReadonlySet<number>): number;
  assertCurrent(step: string): void;
  acknowledge(branch: BranchEntry): Promise<boolean>;
  /** Must admit overlap resources using actual old/candidate occupancy; no implicit allow. */
  admit(graph: BranchEntry, stopBeforeStart: readonly string[], context: { assertCurrent(): void; signal?: AbortSignal }): Promise<void>;
  customEnv: Record<string, string>;
  signal?: AbortSignal;
  onOutput?: (profileId: string, chunk: string) => void;
  onRecoveryFailure?: (stage: NonNullable<DeploymentCandidateRecord['recoveryFailure']>['stage']) => void;
  context?: Pick<NonNullable<Parameters<ContainerService['runService']>[5]>, 'requestId' | 'actor' | 'trigger'>;
}

/** Full-branch candidate executor. Unknown Daemon outcomes preserve the journal and both reservations. */
export class CandidateDeploymentService {
  constructor(private readonly state: StateService,
    private readonly containers: Pick<ContainerService, 'runService' | 'waitForStartupSignal' | 'waitForReadiness'>,
    private readonly lifecycle: OwnedContainerLifecycle) {}

  async deploy(options: CandidateDeploymentOptions): Promise<void> {
    const { entry, runId } = options;
    if (unresolvedCandidateRun(this.state, entry.id, runId)) throw new Error('candidate_reconciliation_required: previous graph is unresolved');
    const run = this.state.getDeploymentRun(runId);
    const targetSha = entry.deploymentTargetSha;
    if (!run || !run.operationId || !run.configHash || run.branchId !== entry.id || run.projectId !== entry.projectId ||
      run.commitSha !== targetSha || !/^[a-f0-9]{40}$/.test(targetSha || '')) throw new Error('candidate_deploy_owner: frozen exact run required');
    const frozen = { operationId: run.operationId, configHash: run.configHash, targetSha, branchId: entry.id, projectId: run.projectId };
    const fence = (step = 'candidate-deployment') => {
      options.assertCurrent(step);
      const current = this.state.getDeploymentRun(runId);
      if (current !== run || current.operationId !== frozen.operationId || current.configHash !== frozen.configHash ||
        current.commitSha !== frozen.targetSha || current.projectId !== frozen.projectId || current.branchId !== frozen.branchId ||
        this.state.getBranch(entry.id) !== entry || entry.id !== frozen.branchId || entry.projectId !== frozen.projectId || entry.deploymentTargetSha !== frozen.targetSha ||
        !['pending', 'queued', 'preparing', 'building', 'starting', 'verifying'].includes(current.status)) {
        throw new Error('candidate_deploy_drift: frozen owner or configuration changed');
      }
    };
    let switched = false;
    const servingFacts = snapshotCandidateServices(entry.services);
    const ownedStops = new Set<string>();
    const servingFence = () => {
      fence();
      const actual = snapshotCandidateServices(entry.services);
      for (const id of ownedStops) if (actual[id]?.status === 'stopped' || actual[id]?.status === 'running') {
        actual[id].status = servingFacts[id].status;
      }
      if (JSON.stringify(actual) !== JSON.stringify(servingFacts)) throw new Error('candidate_deploy_drift: serving runtime facts changed');
    };
    const active = () => { switched ? fence() : servingFence(); options.signal?.throwIfAborted(); };
    active();
    if (typeof options.admit !== 'function') throw new Error('candidate_capacity: explicit admission required');
    const profiles = structuredClone(options.profiles);
    const customEnv = structuredClone(options.customEnv);
    if (!profiles.length || new Set(profiles.map(profile => profile.id)).size !== profiles.length ||
      profiles.some(profile => profile.projectId !== entry.projectId)) throw new Error('candidate_deploy_graph: unique project profiles required');
    // Validate every artifact and declaration before the first stop or create.
    for (const profile of profiles) {
      resolveCandidateReplacement(profile, []);
      if (profile.preparedCommitSha !== targetSha) throw new Error('replacement_artifact: prepared target mismatch');
    }
    const infraIds = new Set(this.state.getInfraServicesForProject(entry.projectId || 'default')
      .filter(infra => infra.status === 'running').map(infra => infra.id));
    const { layers, warnings } = topoSortLayers(profiles, profile => profile.id, profile => profile.dependsOn || [], infraIds);
    if (warnings.length) throw new Error('candidate_deploy_dependencies: unresolved dependency');
    const owner = { projectId: entry.projectId!, branchId: entry.id, operationId: frozen.operationId };
    const initialFacts = JSON.stringify(snapshotCandidateServices(entry.services));
    const oldReferences = new Map<string, OwnedContainerReference>();
    for (const [id, service] of Object.entries(entry.services)) {
      const reference = await this.lifecycle.capture(owner, service, active, options.signal);
      active();
      if (JSON.stringify(snapshotCandidateServices(entry.services)) !== initialFacts) throw new Error('candidate_deploy_drift: serving graph changed during capture');
      oldReferences.set(id, reference);
    }
    const stopBeforeStart = profiles.filter(profile => {
      const old = oldReferences.get(profile.id);
      return resolveCandidateReplacement(profile, old?.writableMounts || []).strategy === 'stop-and-restore' && old?.wasRunning;
    }).map(profile => profile.id);
    // Persist inspected IDs, never infer them from a mutable Docker name at deletion time.
    for (const [id, reference] of oldReferences) { entry.services[id].containerId = reference.id; servingFacts[id].containerId = reference.id; }
    this.state.save(); await this.state.flush(); active();
    const graph = createCandidateRuntime(entry, profiles, frozen.operationId, options.allocatePort);
    const journal = new CandidateJournal(this.state);
    await journal.prepare(runId, graph, stopBeforeStart, { version: 1,
      serving: Object.fromEntries([...oldReferences].map(([id, ref]) => [id, { id: ref.id, name: ref.name,
        image: ref.image, wasRunning: ref.wasRunning, fingerprint: ref.fingerprint }])),
      artifacts: Object.fromEntries(profiles.map(profile => [profile.id, { image: profile.preparedArtifactId!, targetSha: profile.preparedCommitSha! }])) });
    active();
    const captured = new Map<string, OwnedContainerReference>();
    const attempted = new Set<string>();
    const stopped = new Set<string>();
    try {
      await options.admit(graph, stopBeforeStart, { assertCurrent: active, signal: options.signal }); active();
      await journal.advance(runId, 'prepared', 'starting'); active();
      for (const id of stopBeforeStart) {
        ownedStops.add(id);
        await this.lifecycle.stop(oldReferences.get(id)!, active, options.signal); active();
        stopped.add(id); entry.services[id].status = 'stopped';
        await journal.recordServingStopped(runId, id, active); active();
      }
      const confirmStopped = async () => {
        for (const id of stopped) {
          const inspected = await this.lifecycle.capture(owner, entry.services[id], active, options.signal); active();
          const original = oldReferences.get(id)!;
          if (inspected.id !== original.id || inspected.fingerprint !== original.fingerprint || inspected.wasRunning) {
            throw new Error('candidate_single_consumer: original instance stop is no longer confirmed');
          }
        }
      };
      for (const layer of layers) {
        await confirmStopped();
        await runLayerWithSharedAbort(layer.items, async (profile, layerSignal) => {
          const signal = options.signal ? AbortSignal.any([options.signal, layerSignal]) : layerSignal;
          const current = () => { active(); signal.throwIfAborted(); };
          current(); const service = graph.services[profile.id]; service.status = 'starting';
          const output = (chunk: string) => options.onOutput?.(profile.id, chunk);
          attempted.add(profile.id);
          await this.containers.runService(graph, profile, service, output, customEnv, {
            ...options.context, operationId: frozen.operationId, candidateRunId: frozen.operationId,
            assertCurrent: current, signal,
          });
          current();
          const reference = await this.lifecycle.capture({ ...owner, candidateOperationId: frozen.operationId }, service, current, signal);
          current(); captured.set(profile.id, reference); service.containerId = reference.id;
          if (reference.image !== profile.preparedArtifactId || !reference.wasRunning || service.deployedPrebuilt !== true ||
            service.deployedCommitSha !== targetSha) throw new Error('candidate_artifact: inspected exact runtime required');
          if (profile.startupSignal) {
            const started = await this.containers.waitForStartupSignal(service.containerName, profile.startupSignal,
              output, profile.readinessProbe?.timeoutSeconds || 300, signal);
            current();
            if (!started) throw new Error('candidate_readiness: startup signal missing');
          }
          const ready = await this.containers.waitForReadiness(service.hostPort, profile.readinessProbe, undefined, output, service.containerName, signal);
          current();
          if (!ready) throw new Error('candidate_readiness: application is not ready');
          service.status = 'running';
        });
        active();
      }
      await confirmStopped();
      await journal.advance(runId, 'starting', 'ready', graph); active();
      switched = true;
      await new CandidateSwitchCoordinator(this.state).commit(runId, graph, {
        assertCurrent: active,
        acknowledge: options.acknowledge,
        remove: async (service, kind, switchFence) => {
          const reference = (kind === 'serving' ? oldReferences : captured).get(service.profileId);
          if (!reference || service.containerId !== reference.id || service.containerName !== reference.name) {
            throw new Error('candidate_recycle_identity: captured immutable ID required');
          }
          await this.lifecycle.remove(reference, switchFence, options.signal);
        },
      });
    } catch (error) {
      // Normalize raw abort reasons only when the operation lease was actually revoked.
      // A sibling's shared abort must retain the original application/Daemon failure.
      try { options.assertCurrent('candidate-deployment-error'); } catch (leaseError) {
        if (leaseError instanceof BranchOperationSupersededError) error = leaseError;
      }
      // A switched but unresolved consumer might still serve candidates. Preserve both sides.
      const phase = this.state.getDeploymentRun(runId)?.candidate?.phase;
      const oldMapping = Object.entries(entry.services).every(([id, service]) => service.containerName === oldReferences.get(id)?.name);
      const mayRestore = !switched || phase === 'rollback-verified' && oldMapping;
      if (mayRestore) {
        let recoveryStage: NonNullable<DeploymentCandidateRecord['recoveryFailure']>['stage'] = 'ownership';
        try {
          servingFence();
          // Even a failed CLI may have delivered create to the Daemon: no absent-name assumption permits worker restore.
          recoveryStage = 'daemon-create';
          if ([...attempted].some(id => !captured.has(id))) throw new Error('candidate_create_unconfirmed: reconciliation required');
          const recoverySignal = AbortSignal.timeout(30_000);
          recoveryStage = 'candidate-remove';
          if (!switched) for (const reference of captured.values()) await this.lifecycle.remove(reference, servingFence, recoverySignal);
          for (const id of stopped) {
            recoveryStage = 'serving-start';
            await this.lifecycle.start(oldReferences.get(id)!, servingFence, recoverySignal); servingFence();
            const profile = profiles.find(profile => profile.id === id)!; const service = entry.services[id];
            recoveryStage = 'serving-readiness';
            if (!await this.containers.waitForReadiness(service.hostPort, profile.readinessProbe, undefined, undefined,
              service.containerName, recoverySignal)) throw new Error('candidate_restore_readiness: original instance is not ready');
            servingFence(); service.status = 'running';
          }
          recoveryStage = 'serving-persist';
          this.state.save(); await this.state.flush(); servingFence();
          recoveryStage = 'route-ack';
          if (stopped.size && !await options.acknowledge(entry)) throw new Error('candidate_restore_ack: old consumer mapping unconfirmed');
          servingFence();
          if (switched && this.state.getDeploymentRun(runId)?.candidate?.phase === 'rollback-verified') {
            await journal.advance(runId, 'rollback-verified', 'released'); servingFence();
          }
        } catch {
          // Persist a stage code without copying potentially sensitive CLI output or replacing the original error.
          try {
            await journal.recordRecoveryFailure(runId, recoveryStage, fence);
            options.onRecoveryFailure?.(recoveryStage);
          } catch { /* Failed persistence/newer owner remains unresolved; never claim durable recovery. */ }
        }
      }
      if (!switched && attempted.size === 0 && stopped.size === 0 && this.state.getDeploymentRun(runId)?.candidate?.phase === 'prepared') {
        try { await journal.releaseUnstarted(runId, servingFence); } catch { /* Failed durability or newer ownership keeps the reservation. */ }
      }
      const currentPhase = this.state.getDeploymentRun(runId)?.candidate?.phase;
      if (currentPhase && currentPhase !== 'released' && currentPhase !== 'reconciling') {
        try { await journal.advance(runId, currentPhase, 'reconciling'); } catch { /* Never overwrite a newer owner. */ }
      }
      throw error;
    }
  }
}
