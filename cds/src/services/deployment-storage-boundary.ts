import type { BuildProfile, InfraService } from '../types.js';
import path from 'node:path';
import { assertStorageDeclaration, UnsafeDeploymentStorageError } from './deployment-storage-plan.js';
import { INFRA_CATALOG } from './infra-catalog.js';

export { UnsafeDeploymentStorageError } from './deployment-storage-plan.js';

const overlaps = (a: string, b: string) => a === b || a.startsWith(b + '/') || b.startsWith(a + '/') || a === '/' || b === '/';
const hasSegment = (value: string, segment: string) => value.split('/').includes(segment);
const persistentTargets = [...new Set(INFRA_CATALOG.flatMap(entry => entry.volumePaths))];

/** Only a deny signal; matching a path neither identifies a database nor grants storage ownership. */
export function isReservedPersistentTarget(target: string): boolean {
  const normalized = path.posix.resolve('/', target);
  return persistentTargets.some(dir => overlaps(normalized, path.posix.normalize(dir)));
}

function sourceNamespace(worktreePath: string): string {
  const resolved = path.resolve(worktreePath);
  const segments = resolved.split(path.sep);
  const index = segments.indexOf('.deployment-sources');
  return index >= 0 ? segments.slice(0, index + 1).join(path.sep)
    : path.join(path.dirname(resolved), '.deployment-sources');
}

function assertBindOutsideSources(serviceId: string, hostPath: string, sourceRoots: readonly string[]): void {
  const resolved = path.resolve(hostPath);
  if (hasSegment(resolved, '.deployment-sources') || sourceRoots.some(root => overlaps(resolved, root))) {
    throw new UnsafeDeploymentStorageError(serviceId, 'source-cache-overlap');
  }
}

/** Deny-only lexical plan check; it does not certify aliases, live FS identity or persistent ownership. */
export function assertProfileStorageBoundary(profile: BuildProfile, worktreePath: string): void {
  const roots = [sourceNamespace(worktreePath)];
  for (const mount of profile.cacheMounts || []) {
    // Docker -v interprets host paths as binds even if our metadata calls them a volume.
    if (mount.kind === 'volume') {
      if (mount.hostPath.includes('/')) throw new UnsafeDeploymentStorageError(profile.id, 'volume-is-host-path');
    } else if (!mount.readOnly) assertBindOutsideSources(profile.id, mount.hostPath, roots);
    try { assertStorageDeclaration(mount, mount.kind === 'volume' ? 'volume' : 'bind'); }
    catch (error) { throw new UnsafeDeploymentStorageError(profile.id, error instanceof UnsafeDeploymentStorageError ? error.reason : 'storage-contract-invalid'); }
  }
  if (profile.prebuiltImage === true) return;
  const workDir = path.posix.normalize(profile.workDir || '.');
  const target = path.posix.resolve('/', profile.containerWorkDir || '/app');
  if (['.cds-data', '.cds-run-data'].some(marker => hasSegment(workDir, marker))
    || isReservedPersistentTarget(target)) {
    throw new UnsafeDeploymentStorageError(profile.id, 'source-data-directory');
  }
}

export function assertInfraStorageBoundary(service: Pick<InfraService, 'id' | 'projectId' | 'volumes'>,
  context: { repoRoot: string; worktreeBase?: string }): void {
  const roots = context.worktreeBase
    ? [path.resolve(context.worktreeBase, service.projectId || 'default', '.deployment-sources')] : [];
  for (const mount of service.volumes || []) {
    if (mount.type !== 'bind') {
      if (mount.name.includes('/')) throw new UnsafeDeploymentStorageError(service.id, 'volume-is-host-path');
    } else if (!mount.readOnly) {
      assertBindOutsideSources(service.id, path.resolve(context.repoRoot, mount.name), roots);
    }
    try { assertStorageDeclaration(mount, mount.type === 'bind' ? 'bind' : 'volume'); }
    catch (error) { throw new UnsafeDeploymentStorageError(service.id, error instanceof UnsafeDeploymentStorageError ? error.reason : 'storage-contract-invalid'); }
  }
}
