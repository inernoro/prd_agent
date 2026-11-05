import type { StateService } from './state.js';
import type { ContainerService } from './container.js';
import type { BranchEntry, ContainerLogArchiveEntry } from '../types.js';
import { maskSecrets as maskSecretsText } from './secret-masker.js';
import { normalizeLogText, type ServerEventLogSink } from './server-event-log-store.js';

export interface ArchiveBranchContainerLogsOptions {
  stateService: StateService;
  containerService: Pick<ContainerService, 'getLogs'>;
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
  assertCurrent?: (step: string) => void;
}

type CapturedContainerLogArchive = ContainerLogArchiveEntry & { containerName: string };

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
): Promise<CapturedContainerLogArchive[]> {
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

  const archived: CapturedContainerLogArchive[] = [];
  const services = Object.entries(branch.services || {})
    .filter(([profileId, svc]) => (!profileIds || profileIds.has(profileId)) && !!svc.containerName);

  for (const [profileId, svc] of services) {
    options.assertCurrent?.('before container log archive');
    const pending = svc.pendingRuntime;
    const runtime = source === 'deploy-error' && pending && pending.networkName === branch.replacementNetwork ? pending : svc;
    const { containerName, hostPort } = runtime, status = svc.status;
    try {
      if (runtime === pending && !runtime.creationIssued && !runtime.containerId) {
        throw new Error('本次候选尚未创建，没有可归属的容器日志');
      }
      const raw = await containerService.getLogs(containerName, tailLines);
      options.assertCurrent?.('after container log read');
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
        containerName,
        requestId: requestId ?? null,
        operationId: operationId ?? null,
        status,
        logs: normalizeLogText(maskedLogs, tailLines),
        details: { archiveSource: source, hostPort, actor: actor ?? null, trigger: trigger ?? null },
      });
      archived.push({ ...stateService.appendContainerLogArchive(branch.id, {
        projectId: branch.projectId,
        profileId,
        containerName,
        hostPort,
        status,
        source,
        masked: true,
        logs: maskedLogs,
        message,
      }), containerName });
    } catch (err) {
      options.assertCurrent?.('after failed container log read');
      serverEventLogStore?.record({
        category: 'container',
        severity: 'error',
        source: 'container-log-archiver',
        action: 'container.logs.archive-failed',
        message: message || `failed to archive container logs from ${source}`,
        projectId: branch.projectId,
        branchId: branch.id,
        profileId,
        containerName,
        requestId: requestId ?? null,
        operationId: operationId ?? null,
        status,
        error: { message: (err as Error)?.message || String(err) },
        details: { archiveSource: source, hostPort, actor: actor ?? null, trigger: trigger ?? null },
      });
      archived.push({ ...stateService.appendContainerLogArchive(branch.id, {
        projectId: branch.projectId,
        profileId,
        containerName,
        hostPort,
        status,
        source,
        masked: true,
        logs: '',
        message: message
          ? `${message}; capture failed: ${(err as Error)?.message || String(err)}`
          : `capture failed: ${(err as Error)?.message || String(err)}`,
      }), containerName });
    }
    options.assertCurrent?.('after container log archive');
  }

  return archived;
}
