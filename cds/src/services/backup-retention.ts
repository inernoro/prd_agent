import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { IShellExecutor } from '../types.js';
import type { StateService } from './state.js';
import { BACKUP_RETENTION_PROGRAM } from './backup-retention-program.js';
import { backupDirCandidates, backupKey, DEFAULT_KEEP_COUNT, DEFAULT_KEEP_DAYS } from './infra-backup-schedule.js';
import { reclaimLock, type ReclaimSkip } from './reclaim-lock.js';
import { shellQuoteArg } from './secure-database-cli.js';
import { resumedReclaimExecution, recordReclaimExecution } from './reclaim-execution-journal.js';
import { inspectR2BackupObject, type R2BackupConfig } from './infra-backup-r2.js';
import { createExternalResponseAudit } from './standby-response-audit.js';
import type { ServerEventLogSink } from './server-event-log-store.js';

export interface BackupRetentionReport {
  dryRun: boolean;
  scanStatus: 'complete' | 'partial';
  maxAgeDays: 15;
  automaticPolicy: { keepCount: number; keepDays: number };
  directories: Array<Record<string, any>>;
  counts: Record<string, number>;
}

export class BackupRetentionOperationError extends Error {
  constructor(readonly diagnostic: {
    action: string; failureKind: 'transport' | 'native-exit' | 'output-budget' | 'invalid-result';
    exitCode: number | null; nativeException?: string; errno?: number; nativeLines?: number[];
  }) {
    super(`备份资源核查未确认（${diagnostic.action}，${diagnostic.failureKind}，exit=${diagnostic.exitCode ?? 'unknown'}${diagnostic.nativeException ? `，${diagnostic.nativeException}` : ''}${diagnostic.errno == null ? '' : `，errno=${diagnostic.errno}`}${diagnostic.nativeLines?.length ? `，native-lines=${diagnostic.nativeLines.join('/')}` : ''}），相关文件已保留。`);
    this.name = 'BackupRetentionOperationError';
  }
}
export class BackupRetentionService {
  private execution: { id: string; status: 'running' | 'completed' | 'failed'; startedAt: string; directory?: string; stopRequested?: boolean; report?: BackupRetentionReport; error?: string } | null = null;
  constructor(private readonly options: { shell: IShellExecutor; state: StateService; repoRoot: string; instanceId: string;
    historicalCopies?: R2BackupConfig | null; audit?: ServerEventLogSink | null }) {
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
  private async historicalCopyProofs(directory: string, activeServices: Array<{ projectId: string; serviceId: string; backupKey: string }>) {
    const config = this.options.historicalCopies;
    if (!config) return {};
    const preview = await this.run(directory, { action: 'preview', activeServices, discoverOffsiteCopies: true });
    const proofs: Record<string, { bytes: number; sha256: string; signature: string[]; verifiedAt: number; auditId: string }> = {};
    for (const row of (preview.historicalCandidates || []).slice(0, 2)) {
      const file = path.basename(row.path);
      if (path.dirname(row.path) !== directory || !/^[a-zA-Z0-9._-]+-auto-\d{8}T\d{6}Z\.(?:archive|sql)\.gz$/.test(file)) continue;
      const expectedBytes = Number(row.signature[2]);
      const audit = createExternalResponseAudit(this.options.audit, { projectId: row.projectId, remoteProjectId: 'r2', policy: 'historical-backup-local-copy', dryRun: false },
        { source: 'backup-retention-r2', action: 'backup.retention.offsite.response', message: '历史备份离机副本核对' });
      try {
        audit.assertAvailable();
        const remote = await inspectR2BackupObject({ config, fileName: file, fetchImpl: async (url, init) => {
          const started = Date.now();
          let response: Response | undefined;
          try { response = await fetch(url, init); } finally {
            const size = Number(response?.headers.get('content-length'));
            const hash = response?.headers.get('x-amz-meta-sha256')?.toLowerCase() || '';
            const verified = response?.ok === true && Number.isSafeInteger(size) && size === expectedBytes && /^[a-f0-9]{64}$/.test(hash);
            await audit.record({ peerId: 'r2', url: String(url), method: 'HEAD', startedAt: new Date(started).toISOString(), durationMs: Date.now() - started,
              timeoutMs: 8000, responseReceived: !!response, httpStatus: response?.status ?? null, contentType: response?.headers.get('content-type') ?? null,
              upstreamRequestId: response?.headers.get('x-amz-request-id') ?? null, parseState: response ? 'json' : 'no-response',
              json: response ? { size, digest: hash ? 'sha256:' + hash : null } : undefined,
              localDecision: verified ? 'success' : 'offsite-copy-unconfirmed', secrets: [config.secretAccessKey, config.accessKeyId] });
          }
          return response!;
        } });
        if (remote.bytes === expectedBytes) proofs[row.path] = { bytes: remote.bytes, sha256: remote.sha256,
          signature: row.signature, verifiedAt: Date.now(), auditId: audit.operationId };
      } catch { /* Retain every local copy whose remote identity or durable proof was not confirmed. */ }
    }
    return proofs;
  }
  private async run(directory: string, input: Record<string, unknown>): Promise<any> {
    const action = typeof input.action === 'string' && /^[a-z-]{1,40}$/.test(input.action) ? input.action : 'unknown';
    // Persist exception type/errno/source lines, never native stderr or request contents.
    const loader = `import base64,json,sys,traceback\ntry:\n exec(compile(base64.b64decode("${Buffer.from(BACKUP_RETENTION_PROGRAM).toString('base64')}"),'<cds-backup-retention>','exec'))\nexcept Exception as e:\n d={'nativeException':type(e).__name__,'nativeLines':[f.lineno for f in traceback.extract_tb(e.__traceback__) if f.filename=='<cds-backup-retention>'][-5:]}\n if isinstance(getattr(e,'errno',None),int):d['errno']=e.errno\n print('CDS_BACKUP_DIAGNOSTIC='+json.dumps(d),file=sys.stderr)\n sys.exit(70)`;
    let result;
    try { result = await this.options.shell.exec(`python3 -c ${shellQuoteArg(loader)}`, {
      stdin: JSON.stringify({ ...input, automaticPolicy: { keepCount: DEFAULT_KEEP_COUNT, keepDays: DEFAULT_KEEP_DAYS }, catalog: path.join(directory, '.cds-retention'), directories: [directory], instanceId: this.options.instanceId }),
      timeout: input.action === 'register' ? 905_000 : input.action === 'reconcile' ? 305_000 : 30_000, executionLane: input.action === 'preview' ? 'observation' : 'operation',
    }); } catch { throw new BackupRetentionOperationError({ action, failureKind: 'transport', exitCode: null }); }
    if (result.exitCode !== 0) {
      let native: { nativeException?: string; errno?: number; nativeLines?: number[] } = {};
      const line = result.stderr.slice(-2048).split('\n').find(row => row.startsWith('CDS_BACKUP_DIAGNOSTIC='));
      try {
        const value = JSON.parse(line?.slice('CDS_BACKUP_DIAGNOSTIC='.length) || 'null');
        if (value && /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(value.nativeException)) native.nativeException = value.nativeException;
        if (Number.isSafeInteger(value?.errno)) native.errno = value.errno;
        if (Array.isArray(value?.nativeLines)) native.nativeLines = value.nativeLines.filter((n: unknown) => Number.isSafeInteger(n) && Number(n) > 0).slice(-5);
      } catch { /* The exit remains failed when diagnostic metadata is missing. */ }
      throw new BackupRetentionOperationError({ action, failureKind: 'native-exit', exitCode: result.exitCode, ...native });
    }
    if (Buffer.byteLength(result.stdout) > 4 * 1024 * 1024) throw new BackupRetentionOperationError({ action, failureKind: 'output-budget', exitCode: 0 });
    try {
      const value = JSON.parse(result.stdout);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      return value;
    } catch { throw new BackupRetentionOperationError({ action, failureKind: 'invalid-result', exitCode: 0 }); }
  }
  async captureSource(projectId: string, serviceId: string): Promise<string | undefined> {
    const service = this.options.state.getInfraServiceForProjectAndId(projectId, serviceId);
    if (!service) return undefined;
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
      const report: BackupRetentionReport = { dryRun, scanStatus: 'complete', maxAgeDays: 15, automaticPolicy: { keepCount: DEFAULT_KEEP_COUNT, keepDays: DEFAULT_KEEP_DAYS }, directories: [], counts: {} };
      let remaining = Math.max(0, Math.min(20, Math.floor(maxRemovals)));
      for (const directory of this.directories()) {
        if (executionId && this.execution?.stopRequested) {
          report.scanStatus = 'partial';
          report.directories.push({ directory, scanStatus: 'partial', stopReason: 'cancelled', usageBytes: null });
          continue;
        }
        if (executionId && this.execution) this.execution.directory = directory;
        try {
          const activeServices = this.options.state.getInfraServices().map(service => ({ projectId: service.projectId,
            serviceId: service.id, backupKey: backupKey(service.projectId, service.id) }));
          const offsiteProofs = !dryRun && remaining ? await this.historicalCopyProofs(directory, activeServices).catch(() => ({})) : {};
          const result = await this.run(directory, {
            action: dryRun ? 'preview' : 'reconcile', maxRemovals: remaining,
            ...(executionId ? { executionId } : {}), activeServices,
            discoverOffsiteCopies: !!this.options.historicalCopies, offsiteProofs,
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
