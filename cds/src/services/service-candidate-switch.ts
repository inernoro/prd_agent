import type { BranchEntry, ServiceState } from '../types.js';
import type { StateService } from './state.js';
import { CandidateJournal, assertCandidateReady, candidateIdentityKey } from './service-candidate-journal.js';

export interface CandidateSwitchActions {
  assertCurrent(step: string): void;
  /** Must prove the actual consumer has the complete immutable branch route mapping. */
  acknowledge(branch: BranchEntry): Promise<boolean>;
  /** Verify Docker ownership, fence after inspect and before deletion, then remove the immutable ID. */
  remove(service: Readonly<ServiceState>, kind: 'serving' | 'candidate', assertCurrent: () => void): Promise<void>;
}

/** Serving-graph transaction. Retains both identities on every uncertain outcome. */
export class CandidateSwitchCoordinator {
  private readonly journal: CandidateJournal;
  constructor(private readonly state: StateService) { this.journal = new CandidateJournal(state); }

  async commit(runId: string, graph: BranchEntry, actions: CandidateSwitchActions): Promise<void> {
    const run = this.state.getDeploymentRun(runId); const record = run?.candidate;
    const live = this.state.getBranch(graph.id);
    actions.assertCurrent('candidate-switch-validate');
    if (!run || !record || !live || record.phase !== 'ready' || run.branchId !== graph.id ||
      run.projectId !== graph.projectId || run.operationId !== record.operationId || run.commitSha !== record.targetSha ||
      run.configHash !== record.configHash || live.deploymentTargetSha !== record.targetSha ||
      candidateIdentityKey(live.services) !== candidateIdentityKey(record.serving)) throw new Error('candidate_switch_owner: frozen serving graph required');
    assertCandidateReady(graph, record);
    const oldGraph = structuredClone(live.services);
    // Copy runtime facts: mutation of the caller's private graph must not change a published target.
    const newGraph = structuredClone(graph.services);
    const oldKey = candidateIdentityKey(oldGraph); const newKey = candidateIdentityKey(newGraph);
    let published = false; let routed = false;
    const fence = (step: string, expectedKey: string) => {
      actions.assertCurrent(step);
      if (this.state.getBranch(graph.id) !== live || live.deploymentTargetSha !== record.targetSha ||
        candidateIdentityKey(live.services) !== expectedKey) throw new Error('candidate_switch_drift: serving owner or target changed');
    };
    try {
      await this.journal.advance(runId, 'ready', 'switch-intent');
      fence('candidate-switch-intent-durable', oldKey);
      live.services = newGraph; published = true; this.state.save(); await this.state.flush();
      fence('candidate-switch-graph-durable', newKey);
      if (!await actions.acknowledge(live)) throw new Error('candidate_switch_ack: actual consumer did not acknowledge');
      fence('candidate-switch-consumer-ack', newKey);
      await this.journal.advance(runId, 'switch-intent', 'routed'); routed = true;
      fence('candidate-switch-routed-durable', newKey);
      await this.removeGraph(oldGraph, 'serving', actions, () => fence('candidate-serving-recycle', newKey));
      await this.journal.advance(runId, 'routed', 'released');
    } catch (error) {
      // After an acknowledged switch, never route back to partially recycled old containers.
      if (routed) { await this.reconcile(runId); throw error; }
      try {
        fence('candidate-switch-failure-owner', published ? newKey : oldKey);
      } catch { await this.reconcile(runId); throw error; }
      if (!published) { await this.reconcile(runId); throw error; }
      try {
        await this.journal.advance(runId, 'switch-intent', 'rollback-intent');
        fence('candidate-rollback-intent-durable', newKey);
        live.services = oldGraph; this.state.save(); await this.state.flush();
        fence('candidate-rollback-graph-durable', oldKey);
        if (!await actions.acknowledge(live)) throw new Error('candidate_rollback_ack: old consumer mapping unconfirmed');
        fence('candidate-rollback-consumer-ack', oldKey);
        await this.journal.advance(runId, 'rollback-intent', 'rollback-verified');
        await this.removeGraph(newGraph, 'candidate', actions, () => fence('candidate-rejected-recycle', oldKey));
        await this.journal.advance(runId, 'rollback-verified', 'released');
      } catch (rollbackError) { await this.reconcile(runId); throw rollbackError; }
      throw error;
    }
  }

  private async removeGraph(graph: Record<string, ServiceState>, kind: 'serving' | 'candidate', actions: CandidateSwitchActions, fence: () => void) {
    for (const service of Object.values(graph)) {
      fence(); await actions.remove(Object.freeze({ ...service }), kind, fence); fence();
    }
  }

  private async reconcile(runId: string): Promise<void> {
    const phase = this.state.getDeploymentRun(runId)?.candidate?.phase;
    if (phase && phase !== 'released' && phase !== 'reconciling') await this.journal.advance(runId, phase, 'reconciling');
  }
}
