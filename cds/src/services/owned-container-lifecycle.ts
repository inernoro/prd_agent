import type { ExecResult, IShellExecutor, ServiceState } from '../types.js';

export interface OwnedContainerReference {
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
  Mounts?: { Type: string; Source?: string; Destination: string; RW: boolean }[];
}
const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
const absent = (result: ExecResult) => result.exitCode !== 0 && /no such (?:object|container)/i.test(result.stdout + result.stderr);
const labelKeys = ['cds.managed', 'cds.type', 'cds.instance', 'cds.project.id', 'cds.branch.id', 'cds.profile.id',
  'cds.deployment.operation', 'cds.deployment.kind'];
function fingerprint(info: ContainerFacts): string {
  return JSON.stringify([info.Id, info.Name, info.Image, labelKeys.map(key => [key, info.Config.Labels[key] ?? null]),
    Object.entries(info.HostConfig.PortBindings).sort(([a], [b]) => a.localeCompare(b)),
    (info.Mounts || []).map(mount => [mount.Type, mount.Source, mount.Destination, mount.RW]).sort()]);
}

/** Immutable-ID stop/restore/retire boundary. Never recreates a stopped serving configuration. */
export class OwnedContainerLifecycle {
  constructor(private readonly shell: IShellExecutor, private readonly instanceId: string) {}

  async capture(owner: { projectId: string; branchId: string; candidateOperationId?: string }, service: Readonly<ServiceState>,
    assertCurrent: () => void, signal?: AbortSignal): Promise<OwnedContainerReference> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(service.containerName)) throw new Error('container_identity: invalid name');
    assertCurrent(); signal?.throwIfAborted();
    const result = await this.inspect(service.containerName, signal);
    assertCurrent(); signal?.throwIfAborted();
    if (absent(result)) throw new Error('container_missing: actual name is absent');
    const info = this.parse(result);
    const expected: Record<string, string> = { 'cds.managed': 'true', 'cds.type': 'app', 'cds.instance': this.instanceId,
      'cds.project.id': owner.projectId, 'cds.branch.id': owner.branchId, 'cds.profile.id': service.profileId };
    if (owner.candidateOperationId) {
      expected['cds.deployment.operation'] = owner.candidateOperationId; expected['cds.deployment.kind'] = 'candidate';
    }
    if (!Object.entries(expected).every(([key, value]) => info.Config.Labels[key] === value)) throw new Error('container_owner: actual ownership unconfirmed');
    if (info.Name !== '/' + service.containerName || !Object.values(info.HostConfig.PortBindings).some(bindings =>
      bindings?.some(binding => binding.HostPort === String(service.hostPort)))) throw new Error('container_identity: actual name/port mismatch');
    return Object.freeze({ id: info.Id, name: service.containerName, image: info.Image, wasRunning: info.State.Running,
      writableMounts: Object.freeze((info.Mounts || []).filter(mount => mount.RW).map(mount => mount.Destination)),
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

  async confirmAbsent(name: string, assertCurrent: () => void, signal?: AbortSignal): Promise<void> {
    assertCurrent(); signal?.throwIfAborted();
    const result = await this.inspect(name, signal);
    assertCurrent(); signal?.throwIfAborted();
    if (!absent(result)) throw new Error('container_absence_unconfirmed: no mutation permitted');
  }

  private async mutate(reference: OwnedContainerReference, action: 'stop' | 'start' | 'remove', assertCurrent: () => void, signal?: AbortSignal): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(reference.id)) throw new Error('container_identity: immutable ID required');
    assertCurrent(); signal?.throwIfAborted();
    const before = await this.inspect(reference.id, signal);
    // The operation may have been superseded while Docker inspect was outstanding.
    assertCurrent(); signal?.throwIfAborted();
    if (action === 'remove' && absent(before)) return; // Only the captured immutable ID can be idempotently absent.
    if (fingerprint(this.parse(before)) !== reference.fingerprint) throw new Error('container_drift: captured runtime facts changed');
    const command = action === 'remove' ? `docker rm -f ${reference.id}`
      : action === 'stop' ? `docker stop -t 10 ${reference.id}` : `docker start ${reference.id}`;
    const result = await this.shell.exec(command, { priority: 'delivery', timeout: 30_000, signal });
    assertCurrent(); signal?.throwIfAborted();
    if (result.exitCode !== 0) throw new Error(`container_${action}: Daemon operation failed`);
    const after = await this.inspect(reference.id, signal);
    assertCurrent(); signal?.throwIfAborted();
    if (action === 'remove') {
      if (!absent(after)) throw new Error('container_remove_unconfirmed: immutable ID still exists or inspection failed');
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
      (info.Mounts !== undefined && (!Array.isArray(info.Mounts) || !info.Mounts.every(mount => mount &&
        typeof mount.Type === 'string' && typeof mount.Destination === 'string' && typeof mount.RW === 'boolean')))) {
      throw new Error('container_inspect: complete actual container facts required');
    }
    return info;
  }
}
