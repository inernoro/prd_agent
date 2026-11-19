import type { BackupOutcome } from './infra-backup-schedule.js';
import { backupFailureReason } from './infra-backup-schedule.js';
import type { BackupRetentionService } from './backup-retention.js';

/** A failed lease must prevent this export, without hiding other targets or the round receipt. */
export async function runBackupTargetWithLease(options: {
  retention: Pick<BackupRetentionService, 'withLease'>;
  directory: string; projectId: string; serviceId: string;
  outcomes: BackupOutcome[];
  operation: () => Promise<void>;
  onUnconfirmed?: (error: unknown) => void;
}): Promise<void> {
  const start = options.outcomes.length;
  try {
    await options.retention.withLease(options.directory, options.projectId, options.serviceId, 'backup', options.operation);
  } catch (error) {
    const reason = `备份前置核查或租约收尾未确认：${backupFailureReason(error instanceof Error ? error.message : String(error))}`;
    const outcome = options.outcomes.slice(start).find(row => row.projectId === options.projectId && row.id === options.serviceId);
    if (outcome) {
      outcome.ok = false;
      outcome.error = [outcome.error, reason].filter(Boolean).join('；');
    } else options.outcomes.push({ id: options.serviceId, projectId: options.projectId, ok: false, error: reason });
    options.onUnconfirmed?.(error);
  }
}
