import { createHash } from 'node:crypto';
import type { ExecResult, IShellExecutor, ServiceState } from '../types.js';

export interface OwnedContainerReference {
  readonly owner: Readonly<{ projectId: string; branchId: string; profileId: string; operationId?: string }>;
  readonly id: string;
  readonly name: string;
  readonly image: string;
  readonly wasRunning: boolean;
  readonly writableMounts: readonly string[];
  readonly fingerprint: string;
}

interface ContainerFacts {
  Id: string; Name: string; Image: string; State: { Running: boolean };
  Config: { Labels: Record<string, string> };
  HostConfig: { PortBindings: Record<string, { HostIp?: string; HostPort: string }[] | null> };
  Mounts: { Type: string; Source: string; Destination: string; RW: boolean; Mode: string; Propagation: string }[];
}
const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
function absent(result: ExecResult, identity: string): boolean {
  // Docker 29 emits a blank formatter line and lowercase diagnostics. Accept
  // only that framing variation, preserving an exact case-sensitive identity.
  if (result.exitCode !== 1 || !['', '\n', '\r\n'].includes(result.stdout)) return false;
  const diagnostic = result.stderr.replace(/\r?\n$/, '');
  return ['No such object: ', 'Error: No such object: ', 'Error response from daemon: No such object: ',
    'No such container: ', 'Error: No such container: ', 'Error response from daemon: No such container: ']
    .some(prefix => diagnostic.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase()
      && diagnostic.slice(prefix.length) === identity);
}
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, val]) => [key, stable(val)]));
  return value;
}
function fingerprint(info: ContainerFacts): string {
  // Hash the complete returned execution/host configuration, including private environment
  // and mount driver options. Persist only the digest; Running remains lifecycle intent.
  // Docker 29 may report the enabled OOM killer as false before start and null
  // afterwards. These are the same default policy; true remains a policy change.
  const hostConfig = { ...info.HostConfig } as typeof info.HostConfig & { OomKillDisable?: boolean | null };
  if (hostConfig.OomKillDisable === null) hostConfig.OomKillDisable = false;
  return 'sha256:' + createHash('sha256').update(JSON.stringify([info.Id, info.Name, info.Image,
    stable(info.Config), stable(hostConfig),
    stable([...info.Mounts].sort((a, b) => a.Destination.localeCompare(b.Destination)))])).digest('hex');
}
function validMount(mount: ContainerFacts['Mounts'][number]): boolean {
  if (!mount || !['bind', 'volume', 'tmpfs'].includes(mount.Type) || typeof mount.Source !== 'string' ||
    (mount.Type !== 'tmpfs' && !mount.Source) || typeof mount.Destination !== 'string' || !mount.Destination.startsWith('/') ||
    typeof mount.RW !== 'boolean' || typeof mount.Mode !== 'string' || typeof mount.Propagation !== 'string' ||
    !['', 'private', 'rprivate', 'shared', 'rshared', 'slave', 'rslave'].includes(mount.Propagation)) return false;
  const modes = mount.Mode.split(',').filter(Boolean);
  if (modes.some(mode => !['ro', 'rw', 'z', 'Z', 'private', 'rprivate', 'shared', 'rshared', 'slave', 'rslave',
    'nocopy', 'cached', 'delegated', 'consistent'].includes(mode))) return false;
  if ((modes.includes('ro') && mount.RW) || (modes.includes('rw') && !mount.RW) || (modes.includes('ro') && modes.includes('rw'))) return false;
  return true;
}

/** Immutable-ID stop/restore/retire boundary. Never recreates a stopped serving configuration. */
export class OwnedContainerLifecycle {
  constructor(private readonly shell: IShellExecutor, private readonly instanceId: string,
    private readonly beforeMutation?: (reference: OwnedContainerReference, action: 'stop' | 'start' | 'remove') => void) {}

  async capture(owner: { projectId: string; branchId: string; candidateOperationId?: string; operationId?: string; acceptanceRunId?: string }, service: Readonly<ServiceState>,
    assertCurrent: () => void, signal?: AbortSignal): Promise<OwnedContainerReference> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(service.containerName)) throw new Error('container_identity: invalid name');
    assertCurrent(); signal?.throwIfAborted();
    const result = await this.inspect(service.containerName, signal);
    assertCurrent(); signal?.throwIfAborted();
    if (absent(result, service.containerName)) throw new Error('container_missing: actual name is absent');
    const info = this.parse(result);
    const expected: Record<string, string> = { 'cds.managed': 'true', 'cds.type': 'app', 'cds.instance': this.instanceId,
      'cds.project.id': owner.projectId, 'cds.branch.id': owner.branchId, 'cds.profile.id': service.profileId };
    if (owner.candidateOperationId) {
      expected['cds.deployment.operation'] = owner.candidateOperationId; expected['cds.deployment.kind'] = 'candidate';
    }
    if (owner.acceptanceRunId) {
      if (!/^ar_[a-f0-9]{32}$/.test(owner.acceptanceRunId) || !owner.operationId) throw new Error('container_owner: original creation identity required');
      expected['cds.acceptance.run'] = owner.acceptanceRunId;
      expected['cds.deployment.operation'] = owner.operationId;
    }
    if (info.Config.Labels['cds.protected'] === 'true' || !Object.entries(expected).every(([key, value]) => info.Config.Labels[key] === value)) throw new Error('container_owner: actual ownership unconfirmed or protected');
    if (info.Name !== '/' + service.containerName || !Object.values(info.HostConfig.PortBindings).some(bindings =>
      bindings?.some(binding => binding.HostPort === String(service.hostPort)))) throw new Error('container_identity: actual name/port mismatch');
    return Object.freeze({ owner: Object.freeze({ projectId: owner.projectId, branchId: owner.branchId, profileId: service.profileId, operationId: owner.operationId }), id: info.Id, name: service.containerName, image: info.Image, wasRunning: info.State.Running,
      writableMounts: Object.freeze(info.Mounts.filter(mount => mount.RW).map(mount => mount.Destination)),
      fingerprint: fingerprint(info) });
  }

  stop(reference: OwnedContainerReference, assertCurrent: () => void, signal?: AbortSignal): Promise<void> {
    return this.mutate(reference, 'stop', assertCurrent, signal);
  }
  start(reference: OwnedContainerReference, assertCurrent: () => void, signal?: AbortSignal): Promise<void> {
    return this.mutate(reference, 'start', assertCurrent, signal);
  }
  remove(reference: OwnedContainerReference, assertCurrent: () => void, signal?: AbortSignal): Promise<void> {
    return this.mutate(reference, 'remove', assertCurrent, signal);
  }

  /** Acceptance release is separate from candidate retirement: never force or delete volumes. */
  async releaseState(reference: OwnedContainerReference, assertCurrent: () => void, signal?: AbortSignal): Promise<'running' | 'stopped' | 'absent'> {
    if (!/^[a-f0-9]{64}$/.test(reference.id) || reference.writableMounts.length) throw new Error('container_release_scope');
    assertCurrent(); signal?.throwIfAborted();
    const result = await this.inspect(reference.id, signal);
    assertCurrent(); signal?.throwIfAborted();
    if (absent(result, reference.id)) {
      // An old ID's disappearance never grants authority over a same-name successor.
      await this.confirmAbsent(reference.name, assertCurrent, signal);
      return 'absent';
    }
    const actual = this.parse(result);
    if (fingerprint(actual) !== reference.fingerprint || actual.Mounts.some(mount => mount.RW)
      || actual.Config.Labels['cds.protected'] === 'true') throw new Error('container_drift');
    return actual.State.Running ? 'running' : 'stopped';
  }

  async removeStopped(reference: OwnedContainerReference, assertCurrent: () => void, signal?: AbortSignal): Promise<void> {
    const phase = await this.releaseState(reference, assertCurrent, signal);
    if (phase === 'absent') return;
    if (phase !== 'stopped') throw new Error('container_stop_unconfirmed');
    this.beforeMutation?.(reference, 'remove'); assertCurrent(); signal?.throwIfAborted();
    const result = await this.shell.exec(`docker rm ${reference.id}`, { priority: 'delivery', timeout: 30_000, signal });
    assertCurrent(); signal?.throwIfAborted();
    if (result.exitCode !== 0) throw new Error('container_remove');
    if (await this.releaseState(reference, assertCurrent, signal) !== 'absent') throw new Error('container_remove_unconfirmed');
  }

  async confirmAbsent(name: string, assertCurrent: () => void, signal?: AbortSignal): Promise<void> {
    assertCurrent(); signal?.throwIfAborted();
    const result = await this.inspect(name, signal);
    assertCurrent(); signal?.throwIfAborted();
    if (!absent(result, name)) throw new Error('container_absence_unconfirmed: no mutation permitted');
  }

  private async mutate(reference: OwnedContainerReference, action: 'stop' | 'start' | 'remove', assertCurrent: () => void, signal?: AbortSignal): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(reference.id)) throw new Error('container_identity: immutable ID required');
    assertCurrent(); signal?.throwIfAborted();
    const before = await this.inspect(reference.id, signal);
    // The operation may have been superseded while Docker inspect was outstanding.
    assertCurrent(); signal?.throwIfAborted();
    if (action === 'remove' && absent(before, reference.id)) return; // Only the captured immutable ID can be idempotently absent.
    if (fingerprint(this.parse(before)) !== reference.fingerprint) throw new Error('container_drift: captured runtime facts changed');
    const command = action === 'remove' ? `docker rm -f ${reference.id}`
      : action === 'stop' ? `docker stop -t 10 ${reference.id}` : `docker start ${reference.id}`;
    this.beforeMutation?.(reference, action);
    assertCurrent(); signal?.throwIfAborted();
    const result = await this.shell.exec(command, { priority: 'delivery', timeout: 30_000, signal });
    assertCurrent(); signal?.throwIfAborted();
    if (result.exitCode !== 0) throw new Error(`container_${action}: Daemon operation failed`);
    const after = await this.inspect(reference.id, signal);
    assertCurrent(); signal?.throwIfAborted();
    if (action === 'remove') {
      if (!absent(after, reference.id)) throw new Error('container_remove_unconfirmed: immutable ID still exists or inspection failed');
      return;
    }
    const actual = this.parse(after);
    if (fingerprint(actual) !== reference.fingerprint || actual.State.Running !== (action === 'start')) {
      throw new Error(`container_${action}_unconfirmed: runtime state or configuration changed`);
    }
  }

  private inspect(identity: string, signal?: AbortSignal): Promise<ExecResult> {
    return this.shell.exec(`docker inspect --format='{{json .}}' ${quote(identity)}`, { priority: 'delivery', timeout: 10_000, signal });
  }
  private parse(result: ExecResult): ContainerFacts {
    let info: ContainerFacts | undefined;
    try { if (result.exitCode === 0) info = JSON.parse(result.stdout.trim()); } catch { /* Fail closed below. */ }
    if (!info || !/^[a-f0-9]{64}$/.test(info.Id || '') || !/^sha256:[a-f0-9]{64}$/.test(info.Image || '') ||
      typeof info.Name !== 'string' || typeof info.State?.Running !== 'boolean' || !info.Config?.Labels ||
      typeof info.Config.Labels !== 'object' || !info.HostConfig?.PortBindings || typeof info.HostConfig.PortBindings !== 'object' ||
      !Object.values(info.HostConfig.PortBindings).every(bindings => bindings === null || Array.isArray(bindings) &&
        bindings.every(binding => binding && typeof binding.HostPort === 'string')) ||
      !Array.isArray(info.Mounts) || !info.Mounts.every(validMount) || new Set(info.Mounts.map(mount => mount.Destination)).size !== info.Mounts.length) {
      throw new Error('container_inspect: complete actual container facts required');
    }
    return info;
  }
}
