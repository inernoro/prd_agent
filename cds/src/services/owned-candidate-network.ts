import { createHash } from 'node:crypto';
import type { ExecResult, IShellExecutor } from '../types.js';

export interface OwnedCandidateNetworkReference {
  readonly owner: Readonly<{ projectId: string; branchId: string; operationId: string }>;
  readonly id: string;
  readonly name: string;
  readonly fingerprint: string;
}
const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function absent(result: ExecResult, identity: string): boolean {
  if (result.exitCode !== 1 || !['', '\n', '\r\n'].includes(result.stdout)) return false;
  const diagnostic = result.stderr.replace(/\r?\n$/, '');
  return diagnostic === `Error response from daemon: network ${identity} not found` ||
    diagnostic === `Error: No such network: ${identity}`;
}
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (plain(value)) return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, val]) => [key, stable(val)]));
  return value;
}
function parse(result: ExecResult): Record<string, any> {
  let facts: any;
  try { if (result.exitCode === 0) facts = JSON.parse(result.stdout.trim()); } catch { /* Fail closed. */ }
  if (!plain(facts) || typeof facts.Id !== 'string' || !/^[a-f0-9]{64}$/.test(facts.Id) || typeof facts.Name !== 'string' ||
    typeof facts.Driver !== 'string' || !facts.Driver || typeof facts.Scope !== 'string' || !facts.Scope ||
    ['Internal', 'Attachable', 'Ingress', 'EnableIPv6'].some(key => typeof facts[key] !== 'boolean') ||
    !plain(facts.Labels) || !plain(facts.Options) || !plain(facts.IPAM) || typeof facts.IPAM.Driver !== 'string' ||
    !Array.isArray(facts.IPAM.Config) || !plain(facts.Containers)) {
    throw new Error('candidate_network_inspect: complete actual network facts required');
  }
  return facts;
}
function fingerprint(facts: Record<string, any>, legacyRuntimeStatus = false): string {
  // Endpoint membership is checked separately after retiring instances. Never persist IPAM/options plaintext.
  const { Containers: _containers, Created: _created, Status: runtimeStatus, ...configuration } = facts;
  // Docker 29 exposes changing IPAM allocation counters under Status. They are
  // runtime membership, not configuration; actual endpoints remain a separate gate.
  if (legacyRuntimeStatus && runtimeStatus !== undefined) configuration.Status = runtimeStatus;
  return 'sha256:' + createHash('sha256').update(JSON.stringify(stable(configuration))).digest('hex');
}

/** Retires only an inspected private run network by immutable ID. Never disconnects endpoints. */
export class OwnedCandidateNetworkLifecycle {
  constructor(private readonly shell: IShellExecutor, private readonly instanceId: string) {}

  async capture(owner: OwnedCandidateNetworkReference['owner'], name: string, assertCurrent: () => void,
    signal?: AbortSignal): Promise<OwnedCandidateNetworkReference> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(name)) throw new Error('candidate_network_identity: invalid name');
    assertCurrent(); signal?.throwIfAborted();
    const result = await this.inspect(name, signal);
    assertCurrent(); signal?.throwIfAborted(); const facts = parse(result);
    const expected = { 'cds.managed': 'true', 'cds.type': 'candidate-network', 'cds.instance': this.instanceId,
      'cds.project.id': owner.projectId, 'cds.branch.id': owner.branchId, 'cds.deployment.operation': owner.operationId };
    if (facts.Name !== name || facts.Labels['cds.protected'] === 'true' ||
      !Object.entries(expected).every(([key, value]) => typeof value === 'string' && value && facts.Labels[key] === value)) {
      throw new Error('candidate_network_owner: actual private owner required');
    }
    return Object.freeze({ owner: Object.freeze({ ...owner }), id: facts.Id, name, fingerprint: fingerprint(facts) });
  }

  async remove(reference: OwnedCandidateNetworkReference, assertCurrent: () => void, signal?: AbortSignal): Promise<void> {
    if (typeof reference.id !== 'string' || !/^[a-f0-9]{64}$/.test(reference.id) ||
      typeof reference.fingerprint !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(reference.fingerprint)) {
      throw new Error('candidate_network_identity: immutable captured proof required');
    }
    assertCurrent(); signal?.throwIfAborted();
    const before = await this.inspect(reference.id, signal);
    assertCurrent(); signal?.throwIfAborted(); if (absent(before, reference.id)) return;
    const facts = parse(before);
    if (facts.Id !== reference.id || facts.Name !== reference.name || (fingerprint(facts) !== reference.fingerprint && fingerprint(facts, true) !== reference.fingerprint)) {
      throw new Error('candidate_network_drift: captured configuration changed');
    }
    if (Object.keys(facts.Containers).length) throw new Error('candidate_network_occupied: actual endpoints remain');
    assertCurrent(); signal?.throwIfAborted();
    const removed = await this.shell.exec(`docker network rm ${reference.id}`, { priority: 'delivery', timeout: 10_000, signal });
    assertCurrent(); signal?.throwIfAborted();
    if (removed.exitCode !== 0) throw new Error('candidate_network_remove: Daemon operation failed');
    const after = await this.inspect(reference.id, signal);
    assertCurrent(); signal?.throwIfAborted();
    if (!absent(after, reference.id)) throw new Error('candidate_network_remove_unconfirmed: captured ID absence unconfirmed');
  }

  private inspect(identity: string, signal?: AbortSignal): Promise<ExecResult> {
    return this.shell.exec(`docker network inspect --format='{{json .}}' ${quote(identity)}`, { priority: 'delivery', timeout: 10_000, signal });
  }
}
