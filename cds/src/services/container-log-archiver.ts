import type { StateService } from './state.js';
import type { ContainerService } from './container.js';
import type { BranchEntry, ContainerLogArchiveEntry } from '../types.js';
import { maskSecrets as maskSecretsText } from './secret-masker.js';

export interface ArchiveBranchContainerLogsOptions {
  stateService: StateService;
  containerService: ContainerService;
  branch: BranchEntry;
  source: ContainerLogArchiveEntry['source'];
  profileIds?: Set<string>;
  tailLines?: number;
  message?: string;
}

/**
 * CDS-owned black-box capture for branch containers.
 *
 * Docker logs disappear after `docker rm`, and OperationLog can be empty when
 * the CDS process is interrupted before deploy finalization. Call this before
 * destructive lifecycle actions and when a crash is detected so the UI has a
 * durable audit trail independent of the container lifetime.
 */
export async function archiveBranchContainerLogs(
  options: ArchiveBranchContainerLogsOptions,
): Promise<ContainerLogArchiveEntry[]> {
  const {
    stateService,
    containerService,
    branch,
    source,
    profileIds,
    tailLines = 500,
    message,
  } = options;

  const archived: ContainerLogArchiveEntry[] = [];
  const services = Object.entries(branch.services || {})
    .filter(([profileId, svc]) => (!profileIds || profileIds.has(profileId)) && !!svc.containerName);

  for (const [profileId, svc] of services) {
    try {
      const raw = await containerService.getLogs(svc.containerName, tailLines);
      archived.push(stateService.appendContainerLogArchive(branch.id, {
        projectId: branch.projectId,
        profileId,
        containerName: svc.containerName,
        hostPort: svc.hostPort,
        status: svc.status,
        source,
        masked: true,
        logs: maskSecretsText(raw, { mask: true }),
        message,
      }));
    } catch (err) {
      archived.push(stateService.appendContainerLogArchive(branch.id, {
        projectId: branch.projectId,
        profileId,
        containerName: svc.containerName,
        hostPort: svc.hostPort,
        status: svc.status,
        source,
        masked: true,
        logs: '',
        message: message
          ? `${message}; capture failed: ${(err as Error)?.message || String(err)}`
          : `capture failed: ${(err as Error)?.message || String(err)}`,
      }));
    }
  }

  return archived;
}
