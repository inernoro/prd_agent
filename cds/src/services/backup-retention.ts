import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { IShellExecutor } from '../types.js';
import type { StateService } from './state.js';
import { BACKUP_RETENTION_PROGRAM } from './backup-retention-program.js';
import { backupDirCandidates } from './infra-backup-schedule.js';
import { reclaimLock, type ReclaimSkip } from './reclaim-lock.js';
import { shellQuoteArg } from './secure-database-cli.js';
import { resumedReclaimExecution, recordReclaimExecution } from './reclaim-execution-journal.js';

export interface BackupRetentionReport {
  dryRun: boolean;
  scanStatus: 'complete' | 'partial';
  maxAgeDays: 15;
  directories: Array<Record<string, any>>;
  counts: Record<string, number>;
}
export class BackupRetentionService {
  private execution: { id: string; status: 'running' | 'completed' | 'failed'; startedAt: string; directory?: string; stopRequested?: boolean; report?: BackupRetentionReport; error?: string } | null = null;
  constructor(private readonly options: { shell: IShellExecutor; state: StateService; repoRoot: string; instanceId: string }) {
    this.execution = resumedReclaimExecution(options.state.resourceRetirementJournal?.(options.instanceId, 'backups'));
  }
  private persist() { recordReclaimExecution(this.options.state.resourceRetirementJournal?.(this.options.instanceId, 'backups'), this.execution); }
  getSnapshot() { return structuredClone(this.execution); }
  ownershipOptions() {
    return {
      projects: this.options.state.getProjects().map(project => ({ id: project.id, name: project.name })),
      services: this.options.state.getInfraServices().map(service => ({ id: service.id, projectId: service.projectId })),
    };
  }
  startReconcile(maxRemovals = 8) {
    if (this.execution?.status === 'running') throw new Error('备份回收正在执行。');
    const previous = this.execution?.id;
    void this.inspect(false, maxRemovals).catch(() => undefined);
    if (!this.execution || this.execution.id === previous) throw new Error('其他回收任务正在执行，请稍后重试。');
    return this.getSnapshot();
  }
  async cancel(id: string): Promise<void> {
    const execution = this.execution;
    if (!execution || execution.id !== id || execution.status !== 'running') throw new Error('回收任务已结束或身份已变化。');
    execution.stopRequested = true;
    this.persist();
    if (!execution.directory) return;
    const catalog = path.join(execution.directory, '.cds-retention');
    const program = `import os,pathlib,stat\np=pathlib.Path(${JSON.stringify(catalog)})\nassert p.resolve()==p and p.is_dir() and p.stat().st_uid==os.getuid()\nf=os.open(p,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)\ntry:\n d=os.open(${JSON.stringify(`cancel-${id}`)},os.O_WRONLY|os.O_CREAT|os.O_NOFOLLOW,0o600,dir_fd=f)\n try:\n  s=os.fstat(d);assert stat.S_ISREG(s.st_mode) and s.st_uid==os.getuid() and s.st_nlink==1\n  os.fsync(d)\n finally:os.close(d)\nfinally:os.close(f)`;
    const result = await this.options.shell.exec(`python3 -c ${shellQuoteArg(program)}`, { timeout: 5000, executionLane: 'operation' });
    if (result.exitCode !== 0) throw new Error('停止请求尚未确认；当前批次仍受执行时限保护。');
  }
  private directories(): string[] {
    return backupDirCandidates({ slug: this.options.state.projectSlug, repoRoot: this.options.repoRoot });
  }
  private async run(directory: string, input: Record<string, unknown>): Promise<any> {
    const loader = `import base64;exec(base64.b64decode("${Buffer.from(BACKUP_RETENTION_PROGRAM).toString('base64')}"))`;
    const result = await this.options.shell.exec(`python3 -c ${shellQuoteArg(loader)}`, {
      stdin: JSON.stringify({ ...input, catalog: path.join(directory, '.cds-retention'), directories: [directory], instanceId: this.options.instanceId }),
      timeout: input.action === 'register' ? 905_000 : input.action === 'reconcile' ? 305_000 : 30_000, executionLane: input.action === 'preview' ? 'observation' : 'operation',
    });
    if (result.exitCode !== 0 || result.stdout.length > 4 * 1024 * 1024) throw new Error('备份资源核查未完成，相关文件已保留。');
    try { return JSON.parse(result.stdout); } catch { throw new Error('备份资源核查结果未知，相关文件已保留。'); }
  }
  async captureSource(projectId: string, serviceId: string): Promise<string | undefined> {
    const service = this.options.state.getInfraService(serviceId);
    if (!service || service.projectId !== projectId) return undefined;
    for (const directory of this.directories()) {
      try { return (await this.run(directory, { action: 'source', containerName: service.containerName, projectId, serviceId })).sourceFingerprint; } catch { /* Unknown provenance never displaces a business recovery point. */ }
    }
    return undefined;
  }
  async register(filePath: string, projectId: string, serviceId: string, origin: 'automatic' | 'manual' | 'pre-restore' | 'historical', proof: { sourceFingerprint?: string; sourceComplete?: boolean; disposition?: 'business-backup' | 'reproducible-artifact'; attestedBy?: string; dispositionReason?: string; lineageAttestation?: string } = {}): Promise<void> {
    const directory = path.dirname(filePath);
    if (!this.directories().some(root => directory === root)) throw new Error('备份不在已声明的备份目录内。');
    // A current container name cannot prove where an old manual archive came from.
    // Only a stable exporter receipt or an explicit owner attestation can bind its lineage.
    const sourceFingerprint = proof.sourceFingerprint || (proof.lineageAttestation && proof.attestedBy ? await this.captureSource(projectId, serviceId) : undefined);
    if (proof.lineageAttestation && !sourceFingerprint) throw new Error('历史备份与当前物理来源尚未确认，文件保持保护。');
    await this.run(directory, { ...proof, sourceFingerprint, requireManagedOutput: origin === 'automatic', action: 'register', path: filePath, projectId, serviceId, origin });
  }
  async beginOutput(filePath: string, projectId: string, serviceId: string, sourceFingerprint?: string): Promise<void> {
    const directory = this.directories().find(root => path.dirname(path.dirname(path.dirname(filePath))) === root);
    if (!directory) throw new Error('未完成备份必须位于独立轮次的临时目录。');
    await this.run(directory, { action: 'output', path: filePath, projectId, serviceId, sourceFingerprint });
  }
  async closeOutput(filePath: string): Promise<void> {
    const directory = this.directories().find(root => path.dirname(path.dirname(path.dirname(filePath))) === root);
    if (!directory) throw new Error('临时备份目录未确认。');
    await this.run(directory, { action: 'close-output', path: filePath });
  }
  async promoteOutput(filePath: string, destination: string): Promise<void> {
    const directory = this.directories().find(root => path.dirname(path.dirname(path.dirname(filePath))) === root && path.dirname(destination) === root);
    if (!directory) throw new Error('备份转正目录未确认。');
    await this.run(directory, { action: 'promote-output', path: filePath, destination });
  }
  async withLease<T>(directory: string, projectId: string, serviceId: string, kind: 'backup' | 'restore', operation: () => Promise<T>): Promise<T> {
    const token = randomBytes(24).toString('hex');
    const request = { projectId, serviceId, token, kind };
    await this.run(directory, { ...request, action: 'lease' });
    let renewal: Promise<unknown> = Promise.resolve();
    let failure: unknown;
    const timer = setInterval(() => {
      renewal = renewal.then(() => this.run(directory, { ...request, action: 'lease' })).catch(error => { failure = error; });
    }, 60_000);
    timer.unref();
    try {
      const result = await operation();
      await renewal;
      if (failure) throw failure;
      return result;
    } finally {
      clearInterval(timer);
      await renewal;
      await this.run(directory, { ...request, action: 'release' });
    }
  }
  async inspect(dryRun = true, maxRemovals = 8): Promise<BackupRetentionReport | ReclaimSkip> {
    const operation = async (executionId?: string) => {
      const report: BackupRetentionReport = { dryRun, scanStatus: 'complete', maxAgeDays: 15, directories: [], counts: {} };
      let remaining = Math.max(0, Math.min(20, Math.floor(maxRemovals)));
      for (const directory of this.directories()) {
        if (executionId && this.execution?.stopRequested) {
          report.scanStatus = 'partial';
          report.directories.push({ directory, scanStatus: 'partial', stopReason: 'cancelled', usageBytes: null });
          continue;
        }
        if (executionId && this.execution) this.execution.directory = directory;
        try {
          const result = await this.run(directory, {
            action: dryRun ? 'preview' : 'reconcile', maxRemovals: remaining,
            ...(executionId ? { executionId } : {}),
            activeServices: this.options.state.getInfraServices().map(service => ({ projectId: service.projectId, serviceId: service.id })),
          });
          report.directories.push({ directory, ...result });
          if (result.scanStatus !== 'complete') report.scanStatus = 'partial';
          for (const [key, value] of Object.entries(result.counts || {})) report.counts[key] = (report.counts[key] || 0) + Number(value);
          remaining -= result.counts?.removed || 0;
        } catch (error) {
          report.scanStatus = 'partial';
          report.directories.push({ directory, scanStatus: 'partial', error: (error as Error).message, usageBytes: null });
        }
      }
      return report;
    };
    if (dryRun) return operation();
    return reclaimLock.run('backup-retention', async () => {
      const execution = { id: randomBytes(16).toString('hex'), status: 'running' as const, startedAt: new Date().toISOString() };
      this.execution = execution;
      this.persist();
      try {
        const report = await operation(execution.id);
        this.execution = { ...this.execution!, status: 'completed', report };
        this.persist();
        return report;
      } catch {
        this.execution = { ...this.execution!, status: 'failed', error: '回收未完成，未确认的对象保持保护。' };
        this.persist();
        throw new Error('回收未完成，未确认的对象保持保护。');
      }
    });
  }
}
