import { createHash } from 'node:crypto';
import path from 'node:path';
import type { BranchEntry, BuildProfile, CdsConfig, InfraService, IShellExecutor, StorageBinding } from '../types.js';

export class UnsafeDeploymentStorageError extends Error {
  readonly code = 'unsafe_deployment_storage';
  constructor(readonly serviceId: string, readonly reason: string) {
    super(`unsafe_deployment_storage: 服务 '${serviceId}' 的新挂载计划被拒绝 (${reason})；保留原容器与数据，请提供明确的安全存储绑定。`);
    this.name = 'UnsafeDeploymentStorageError';
  }
}

export type PlannedMount = Readonly<{ kind: 'bind' | 'volume' | 'tmpfs'; source: string; target: string; readOnly: boolean;
  purpose: 'source' | 'config' | 'cache' | 'persistent' | 'ephemeral'; storage?: Readonly<StorageBinding>; sourceRoot?: string; serverTool?: true }>;
export type DeploymentStoragePlan = Readonly<{ version: 1; mounts: readonly PlannedMount[]; digest: string }>;
const quote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
function fail(reason: string): never { throw new UnsafeDeploymentStorageError('plan', reason); }
const validKey = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(v);

export function assertStorageDeclaration(mount: { readOnly?: boolean; storage?: StorageBinding }, kind: 'bind' | 'volume'): void {
  // Read-only is not host authority: a socket can still control its daemon.
  // User config/cache binds require a future independently pinned contract.
  if (kind === 'bind') fail('storage-bind-pin-required');
  const s = mount.storage;
  if (!s) fail('storage-contract-required');
  if (s.version !== 1 || !['cache', 'persistent'].includes(s.purpose)
    || !['branch-private', 'project-shared'].includes(s.scope)
    || ![s.instanceId, s.projectId, s.serviceId, s.mountKey].every(validKey)
    || (s.scope === 'branch-private' ? !validKey(s.branchId) : s.branchId !== undefined)) fail('storage-contract-invalid');
}

export function stableStorageVolumeName(s: StorageBinding): string {
  assertStorageDeclaration({storage: s}, 'volume');
  const identity = [s.version, s.instanceId, s.projectId, s.scope, s.branchId || '', s.serviceId, s.mountKey, s.purpose];
  return `cds-storage-v1-${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`;
}
export function storageOwnerLabels(s: StorageBinding): Record<string, string> {
  return { 'cds.storage.version': '1', 'cds.storage.instance': s.instanceId, 'cds.storage.project': s.projectId,
    'cds.storage.scope': s.scope, 'cds.storage.branch': s.branchId || '', 'cds.storage.service': s.serviceId,
    'cds.storage.key': s.mountKey, 'cds.storage.purpose': s.purpose };
}

function seal(mounts: PlannedMount[], identity: {instanceId?: string; projectId: string; branchId?: string; serviceId: string}): DeploymentStoragePlan {
  const targets = new Set<string>();
  for (const m of mounts) {
    if (!m.source || /[\x00\r\n,:]/.test(m.source) || !path.posix.isAbsolute(m.target)
      || /[\x00\r\n,:]/.test(m.target) || path.posix.normalize(m.target) !== m.target) fail('storage-path-invalid');
    if (targets.has(m.target)) fail('storage-target-duplicate');
    targets.add(m.target);
    if (m.purpose === 'source' && !m.readOnly) fail('source-must-be-readonly');
    if (m.kind === 'bind' && m.purpose !== 'source') fail('storage-bind-pin-required');
    if (m.kind === 'volume' || !m.readOnly) {
      assertStorageDeclaration(m, m.kind === 'volume' ? 'volume' : 'bind');
      const s = m.storage!;
      if (!identity.instanceId || s.instanceId !== identity.instanceId || s.projectId !== identity.projectId
        || s.serviceId !== identity.serviceId || (s.scope === 'branch-private' && s.branchId !== identity.branchId)) fail('storage-owner-mismatch');
      if (m.source !== stableStorageVolumeName(s)) fail('storage-name-mismatch');
    }
  }
  const frozen = mounts.map(m => Object.freeze({...m, ...(m.storage ? {storage: Object.freeze({...m.storage})} : {})}));
  return Object.freeze({version: 1, mounts: Object.freeze(frozen), digest: createHash('sha256').update(JSON.stringify(frozen)).digest('hex')});
}

export function profileStoragePlan(entry: Pick<BranchEntry, 'id' | 'projectId' | 'worktreePath'>, profile: BuildProfile,
  config: Pick<CdsConfig, 'storageInstanceId'>): DeploymentStoragePlan {
  const mounts: PlannedMount[] = [];
  if (!profile.prebuiltImage && !profile.managedBuild) {
    const source = path.resolve(entry.worktreePath, profile.workDir || '.');
    const relative = path.relative(path.resolve(entry.worktreePath), source);
    if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) fail('source-outside-checkout');
    mounts.push({kind: 'bind', source, target: profile.containerWorkDir || '/app', readOnly: true, purpose: 'source', sourceRoot: path.resolve(entry.worktreePath)});
  }
  for (const m of profile.cacheMounts || []) mounts.push({kind: m.kind === 'volume' ? 'volume' : 'bind', source: m.kind === 'volume' ? m.hostPath : path.resolve(entry.worktreePath, m.hostPath),
    target: m.containerPath, readOnly: m.readOnly === true, purpose: m.storage?.purpose || 'config', storage: m.storage});
  return seal(mounts, {instanceId: config.storageInstanceId, projectId: entry.projectId || 'default', branchId: entry.id, serviceId: profile.id});
}
export function infraStoragePlan(service: Pick<InfraService, 'id' | 'projectId' | 'volumes'>,
  config: Pick<CdsConfig, 'storageInstanceId' | 'repoRoot'>): DeploymentStoragePlan {
  return seal((service.volumes || []).map(m => ({kind: m.type === 'bind' ? 'bind' : 'volume',
    source: m.type === 'bind' ? path.resolve(config.repoRoot, m.name) : m.name, target: m.containerPath,
    readOnly: m.readOnly === true, purpose: m.storage?.purpose || 'config', storage: m.storage})),
  {instanceId: config.storageInstanceId, projectId: service.projectId || 'default', serviceId: service.id});
}

/** No -v auto-mkdir and no Docker image copy-up into fresh persistent storage. */
export function renderStoragePlan(plan: DeploymentStoragePlan): string[] {
  if (plan.version !== 1 || createHash('sha256').update(JSON.stringify(plan.mounts)).digest('hex') !== plan.digest
    || plan.mounts.some(m => m.purpose === 'source' && !m.readOnly || m.kind === 'bind' && (!m.readOnly || (m.purpose !== 'source' && m.serverTool !== true))
      || m.kind === 'tmpfs' && (m.source !== 'tmpfs' || m.target !== '/tmp' || m.purpose !== 'ephemeral' || m.readOnly))) fail('storage-plan-invalid');
  return plan.mounts.map(m => m.kind === 'tmpfs' ? `--tmpfs ${quote(m.target)}` : `--mount ${quote(`type=${m.kind},${m.kind === 'volume' ? 'source' : 'src'}=${m.source},dst=${m.target}${m.readOnly ? ',readonly' : ''}${m.kind === 'volume' ? ',volume-nocopy' : ''}`)}`);
}

/** The fixed runtime temporary layer is explicit and never a host/data binding. */
export function withRuntimeTmpfs(plan: DeploymentStoragePlan, enabled = true): DeploymentStoragePlan {
  renderStoragePlan(plan);
  if (!enabled) return plan;
  if (plan.mounts.some(m => m.target === '/tmp')) fail('storage-target-duplicate');
  const mounts = Object.freeze([...plan.mounts, Object.freeze({kind:'tmpfs' as const,source:'tmpfs',target:'/tmp',readOnly:false,purpose:'ephemeral' as const})]);
  return Object.freeze({version:1, mounts, digest:createHash('sha256').update(JSON.stringify(mounts)).digest('hex')});
}

/** Append only read-only host tools to an already validated accepted plan. */
export function withReadOnlyTools(plan: DeploymentStoragePlan, tools: ReadonlyArray<{source: string; target: string}>): DeploymentStoragePlan {
  renderStoragePlan(plan);
  const mounts = [...plan.mounts, ...tools.map(t => {
    if (!path.posix.isAbsolute(t.source) || !path.posix.isAbsolute(t.target) || /[,:\r\n\x00]/.test(t.source + t.target)
      || plan.mounts.some(m => m.target === t.target)) fail('storage-tool-invalid');
    return Object.freeze({...t, kind: 'bind' as const, readOnly: true, purpose: 'config' as const, serverTool: true as const});
  })];
  return Object.freeze({version: 1, mounts: Object.freeze(mounts), digest: createHash('sha256').update(JSON.stringify(mounts)).digest('hex')});
}

export type StorageBirthRequirements = Record<string, {birthNonce:string;daemonId:string;mountpoint:string;createdAt:string}>;

/** Read-only preflight; unknown existing storage is never taken over. Allocation is separate. */
export async function inspectStoragePlan(shell: IShellExecutor, plan: DeploymentStoragePlan, allowMissing = false, births: StorageBirthRequirements = {}): Promise<void> {
  renderStoragePlan(plan);
  const proof = structuredClone(births), volumes = plan.mounts.filter(m => m.kind === 'volume');
  if (Object.entries(proof).some(([name,row]) => !volumes.some(m => m.source === name) || !row || !/^[a-f0-9]{48}$/.test(row.birthNonce)
    || !row.daemonId || !row.mountpoint || !Number.isFinite(Date.parse(row.createdAt)))) fail('storage-birth-unconfirmed');
  const checkDaemon = async () => {
    if (!Object.keys(proof).length) return;
    const result = await shell.exec("docker info --format '{{.ID}}'", {executionLane:'observation'});
    if (result.exitCode !== 0 || Object.values(proof).some(row => row.daemonId !== result.stdout.trim())) fail('storage-birth-unconfirmed');
  };
  await checkDaemon();
  for (const m of plan.mounts.filter(m => m.kind === 'volume')) {
    const result = await shell.exec(`docker volume inspect ${quote(m.source)}`, {executionLane: 'observation'});
    if (result.exitCode !== 0) {
      if (/no such volume/i.test(result.stderr)) { if (allowMissing && !proof[m.source]) continue; fail('storage-existing-volume-required'); }
      fail('storage-identity-unknown');
    }
    let info: {Name?: string; Driver?: string; Options?: unknown; Mountpoint?: string; CreatedAt?: string; Labels?: Record<string,string>}[];
    try { info = JSON.parse(result.stdout); } catch { fail('storage-identity-unknown'); }
    if (!Array.isArray(info!) || info!.length !== 1 || info![0]?.Name !== m.source
      || Object.entries(storageOwnerLabels(m.storage!)).some(([k,v]) => !Object.hasOwn(info![0].Labels || {}, k) || info![0].Labels?.[k] !== v)) fail('storage-owner-unconfirmed');
    const actual = info![0], birth = proof[m.source], nativeBirth = actual.Labels?.['cds.storage.birth'];
    if (nativeBirth !== undefined || birth) {
      if (!birth || nativeBirth !== birth.birthNonce || actual.Mountpoint !== birth.mountpoint || actual.CreatedAt !== birth.createdAt) fail('storage-birth-unconfirmed');
    }
    if (actual.Driver !== 'local' || (actual.Options !== null && (typeof actual.Options !== 'object' || Array.isArray(actual.Options)
      || Object.keys(actual.Options!).length !== 0)) || typeof actual.Mountpoint !== 'string'
      || !path.posix.isAbsolute(actual.Mountpoint) || actual.Mountpoint.split('/').includes('.deployment-sources')
      || !actual.Mountpoint.endsWith('/' + m.source + '/_data')) fail('storage-driver-unconfirmed');
  }
  await checkDaemon();
}

/** Runtime is deliberately not a storage allocator. A missing stable volume is a hold,
 * including first deployment on a different executor; it cannot authorize a new empty DB. */
export async function materializeStoragePlan(shell: IShellExecutor, plan: DeploymentStoragePlan): Promise<void> {
  await inspectStoragePlan(shell, plan, false);
}

/** Freeze the actual image and reject Dockerfile VOLUME declarations absent from this plan. */
export async function resolveStorageImage(shell: IShellExecutor, image: string, plan: DeploymentStoragePlan, pullMissing = false): Promise<string> {
  renderStoragePlan(plan);
  if (!image || image.includes('${')) fail('storage-image-unresolved');
  // Docker 29 omits absent optional keys; direct .Config.Volumes raises instead of returning null.
  const query = `docker image inspect ${quote(image)} --format '[{{json .Id}},{{json (index .Config "Volumes")}}]'`;
  let result = await shell.exec(query, {executionLane: 'observation'});
  if (result.exitCode !== 0 && pullMissing && /no such (object|image)/i.test(result.stderr)) {
    const pull = await shell.exec(`docker pull ${quote(image)}`);
    if (pull.exitCode !== 0) fail('storage-image-unavailable');
    result = await shell.exec(query, {executionLane: 'observation'});
  }
  if (result.exitCode !== 0) fail('storage-image-identity-unknown');
  let id: unknown, volumes: unknown;
  try {
    const parts = JSON.parse(result.stdout);
    if (!Array.isArray(parts) || parts.length !== 2) fail('storage-image-identity-unknown');
    [id, volumes] = parts;
  } catch { fail('storage-image-identity-unknown'); }
  if (typeof id !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(id)) fail('storage-image-identity-unknown');
  if (image.startsWith('sha256:') && id !== image) fail('storage-image-identity-mismatch');
  if (volumes !== null && (typeof volumes !== 'object' || Array.isArray(volumes))) fail('storage-image-volumes-unknown');
  for (const target of Object.keys(volumes || {})) {
    if (!path.posix.isAbsolute(target) || path.posix.normalize(target) !== target || !plan.mounts.some(m => m.target === target)) {
      fail('storage-image-volume-unbound');
    }
  }
  return id;
}
