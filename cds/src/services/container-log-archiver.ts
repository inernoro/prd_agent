import type { StateService } from './state.js';
import type { ContainerService } from './container.js';
import type { BranchEntry, ContainerLogArchiveEntry } from '../types.js';
import { maskSecrets as maskSecretsText } from './secret-masker.js';
import { normalizeLogText, type ServerEventLogSink } from './server-event-log-store.js';

export interface ArchiveBranchContainerLogsOptions {
  stateService: StateService;
  containerService: ContainerService;
  branch: BranchEntry;
  source: ContainerLogArchiveEntry['source'];
  profileIds?: Set<string>;
  tailLines?: number;
  message?: string;
  requestId?: string | null;
  operationId?: string | null;
  actor?: string | null;
  trigger?: string | null;
  serverEventLogStore?: ServerEventLogSink | null;
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
    requestId,
    operationId,
    actor,
    trigger,
    serverEventLogStore,
  } = options;

  const archived: ContainerLogArchiveEntry[] = [];
  const services = Object.entries(branch.services || {})
    .filter(([profileId, svc]) => (!profileIds || profileIds.has(profileId)) && !!svc.containerName);

  for (const [profileId, svc] of services) {
    try {
      const raw = await containerService.getLogs(svc.containerName, tailLines);
      const maskedLogs = maskSecretsText(raw, { mask: true });
      serverEventLogStore?.record({
        category: 'container',
        severity: source === 'crash-detected' || source === 'deploy-error' ? 'error' : 'warn',
        source: 'container-log-archiver',
        action: 'container.logs.archived',
        message: message || `archived container logs from ${source}`,
        projectId: branch.projectId,
        branchId: branch.id,
        profileId,
        containerName: svc.containerName,
        requestId: requestId ?? null,
        operationId: operationId ?? null,
        status: svc.status,
        logs: normalizeLogText(maskedLogs, tailLines),
        details: { archiveSource: source, hostPort: svc.hostPort, actor: actor ?? null, trigger: trigger ?? null },
      });
      archived.push(stateService.appendContainerLogArchive(branch.id, {
        projectId: branch.projectId,
        profileId,
        containerName: svc.containerName,
        hostPort: svc.hostPort,
        status: svc.status,
        source,
        masked: true,
        logs: maskedLogs,
        message,
      }));
    } catch (err) {
      serverEventLogStore?.record({
        category: 'container',
        severity: 'error',
        source: 'container-log-archiver',
        action: 'container.logs.archive-failed',
        message: message || `failed to archive container logs from ${source}`,
        projectId: branch.projectId,
        branchId: branch.id,
        profileId,
        containerName: svc.containerName,
        requestId: requestId ?? null,
        operationId: operationId ?? null,
        status: svc.status,
        error: { message: (err as Error)?.message || String(err) },
        details: { archiveSource: source, hostPort: svc.hostPort, actor: actor ?? null, trigger: trigger ?? null },
      });
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
