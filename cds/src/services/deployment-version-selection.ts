import type { DeploymentVersion } from '../types.js';

/** Shared with rollback dispatch: version order is the existing newest-first ledger order. */
export function selectDefaultRollbackVersion(versions: readonly DeploymentVersion[], currentVersionId?: string): DeploymentVersion | undefined {
  return versions.find(version => version.id !== currentVersionId && version.profiles.length > 0 && version.profiles.every(profile => profile.reusable));
}
