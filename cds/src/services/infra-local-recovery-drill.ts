import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { InfraService } from '../types.js';
import type { RotationRecoveryEvidence } from './infra-credential-rotation.js';

export interface LocalDrillCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type LocalDrillCommandRunner = (
  command: string,
  args: readonly string[],
  stdin?: string | Buffer,
) => Promise<LocalDrillCommandResult>;

const CLEANUP_MARKER = '.cleanup.json';
const MANUAL_REVIEW_MARKER = '.manual-review.json';

function backupRootFromId(recoveryDir: string, backupId: string): string | null {
  const match = /^local:[^:]+:[^:]+:(rotation-[0-9a-f]+):[0-9a-f]{16}$/i.exec(backupId);
  if (!match) return null;
  const root = path.resolve(recoveryDir, match[1]);
  return root.startsWith(`${path.resolve(recoveryDir)}${path.sep}`) ? root : null;
}

export async function pruneExpiredRotationRecoveryArtifacts(
  recoveryDir: string,
  now = new Date(),
): Promise<void> {
  const entries = await fs.promises.readdir(recoveryDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^rotation-[0-9a-f]+$/i.test(entry.name)) continue;
    const root = path.join(recoveryDir, entry.name);
    const marker = path.join(root, CLEANUP_MARKER);
    // 人工处置优先于任何 TTL。即使进程恰好崩在“写 manual-review、删 cleanup”
    // 两步之间，重启清理器也只能保留副本，不能按旧 cleanup marker 误删。
    const manualReview = await fs.promises.stat(path.join(root, MANUAL_REVIEW_MARKER)).catch(() => null);
    if (manualReview?.isFile()) {
      await fs.promises.unlink(marker).catch(() => { /* 保留优先；删不掉也绝不继续 prune */ });
      continue;
    }
    try {
      const parsed = JSON.parse(await fs.promises.readFile(marker, 'utf8')) as { expiresAt?: unknown };
      const expiresAt = typeof parsed.expiresAt === 'string' ? Date.parse(parsed.expiresAt) : Number.NaN;
      if (Number.isFinite(expiresAt) && expiresAt <= now.getTime()) {
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    } catch {
      // 无 marker 或 marker 损坏均 fail-closed 保留，禁止误删恢复证据。
    }
  }
}

export async function markRotationRecoveryArtifactsForCleanup(opts: {
  recoveryDir: string;
  backupIds: readonly string[];
  retentionMs: number;
  now?: Date;
}): Promise<void> {
  if (!Number.isSafeInteger(opts.retentionMs) || opts.retentionMs < 0) throw new Error('recovery.retention_invalid');
  const now = opts.now || new Date();
  const expiresAt = new Date(now.getTime() + opts.retentionMs).toISOString();
  for (const backupId of [...new Set(opts.backupIds)]) {
    const root = backupRootFromId(opts.recoveryDir, backupId);
    if (!root) throw new Error('recovery.backup_id_invalid');
    const stat = await fs.promises.stat(root).catch(() => null);
    if (!stat?.isDirectory()) throw new Error('recovery.backup_missing');
    await fs.promises.writeFile(
      path.join(root, CLEANUP_MARKER),
      `${JSON.stringify({ backupId, expiresAt })}\n`,
      { encoding: 'utf8', mode: 0o600, flag: 'wx' },
    ).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
      await fs.promises.chmod(path.join(root, CLEANUP_MARKER), 0o600);
    });
    const timer = setTimeout(() => {
      void pruneExpiredRotationRecoveryArtifacts(opts.recoveryDir);
    }, Math.min(opts.retentionMs, 2_147_000_000));
    timer.unref();
  }
}

/**
 * 失败/回滚轨道的恢复副本不自动删除，而是显式登记为待人工处置。
 * 这样它既不会无限期“无主”遗留，也不会在系统仍可能需要它时被 TTL 误删。
 */
export async function markRotationRecoveryArtifactsForManualReview(opts: {
  recoveryDir: string;
  backupIds: readonly string[];
  operationId: string;
  reason: 'rollback-completed' | 'rollback-failed';
  now?: Date;
}): Promise<void> {
  const markedAt = (opts.now || new Date()).toISOString();
  for (const backupId of [...new Set(opts.backupIds)]) {
    const root = backupRootFromId(opts.recoveryDir, backupId);
    if (!root) throw new Error('recovery.backup_id_invalid');
    const stat = await fs.promises.stat(root).catch(() => null);
    if (!stat?.isDirectory()) throw new Error('recovery.backup_missing');
    const marker = path.join(root, MANUAL_REVIEW_MARKER);
    const payload = `${JSON.stringify({
      backupId,
      operationId: opts.operationId,
      disposition: 'manual-review-required',
      reason: opts.reason,
      markedAt,
    })}\n`;
    await fs.promises.writeFile(marker, payload, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      .catch(async (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
        await fs.promises.chmod(marker, 0o600);
      });
    // 先让人工处置 marker 原子可见，再撤销旧 TTL。反向排序会留下一个“两个 marker
    // 都没有”的崩溃窗口，清理策略与人工接管状态都无法辨认。
    await fs.promises.unlink(path.join(root, CLEANUP_MARKER)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

export function startRotationRecoveryArtifactCleanup(opts: {
  recoveryDir: string;
  intervalMs?: number;
  onError?: (error: Error) => void;
}): NodeJS.Timeout {
  const intervalMs = Math.max(60_000, Math.min(24 * 60 * 60_000, opts.intervalMs ?? 6 * 60 * 60_000));
  const run = (): void => {
    void pruneExpiredRotationRecoveryArtifacts(opts.recoveryDir)
      .catch((error) => opts.onError?.(error as Error));
  };
  run();
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return timer;
}

async function run(command: string, args: readonly string[], stdin?: string | Buffer): Promise<LocalDrillCommandResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
    if (stdin !== undefined) child.stdin?.end(stdin);
  });
}

function safeContainerName(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value)) throw new Error('recovery.container_name_invalid');
  return value;
}

function requireSuccess(result: LocalDrillCommandResult, code: string): void {
  if (result.exitCode !== 0) throw new Error(code);
}

function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function mongoAuth(service: InfraService): { user: string; password: string } {
  const env = service.env || {};
  const user = String(env.MONGO_INITDB_ROOT_USERNAME || env.MONGO_USERNAME || env.MONGODB_USERNAME || '').trim();
  const password = String(env.MONGO_INITDB_ROOT_PASSWORD || env.MONGO_PASSWORD || env.MONGODB_PASSWORD || '');
  if (!user || !password) throw new Error('recovery.mongodb_credentials_missing');
  return { user, password };
}

function redisAuth(service: InfraService): { user: string; password: string } {
  const env = service.env || {};
  const password = String(env.REDIS_PASSWORD || env.REDIS_PASS || '').trim();
  if (!password) throw new Error('recovery.redis_credentials_missing');
  return { user: String(env.REDIS_USERNAME || 'default').trim() || 'default', password };
}

function yamlQuoted(value: string): string {
  return JSON.stringify(value);
}

function shellQuoted(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

async function waitReady(
  runner: LocalDrillCommandRunner,
  container: string,
  command: string[],
  attempts: number,
): Promise<LocalDrillCommandResult> {
  let last: LocalDrillCommandResult = { exitCode: 1, stdout: '', stderr: '' };
  for (let i = 0; i < attempts; i += 1) {
    last = await runner('docker', ['exec', container, ...command]);
    if (last.exitCode === 0) return last;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return last;
}

/**
 * 对正在运行的项目共享 MongoDB/Redis 生成新备份，并恢复进 `--network none` 临时容器。
 * 数据库凭据只通过标准输入进入导出工具；Docker argv、结果、错误与台账均不含明文。
 */
export async function runLocalInfraRecoveryDrill(opts: {
  service: InfraService;
  /** 受控持久目录；演练通过的备份会保留在这里，供轮换失败时恢复。 */
  recoveryDir: string;
  commandRunner?: LocalDrillCommandRunner;
  mongoImage?: string;
  redisImage?: string;
  readinessAttempts?: number;
}): Promise<RotationRecoveryEvidence> {
  const service = opts.service;
  const runner = opts.commandRunner || run;
  const source = safeContainerName(service.containerName);
  await fs.promises.mkdir(opts.recoveryDir, { recursive: true, mode: 0o700 });
  await fs.promises.chmod(opts.recoveryDir, 0o700);
  await pruneExpiredRotationRecoveryArtifacts(opts.recoveryDir);
  const nonce = crypto.randomBytes(6).toString('hex');
  const root = path.join(opts.recoveryDir, `rotation-${nonce}`);
  await fs.promises.mkdir(root, { mode: 0o700 });
  const drillContainer = `cds-infra-drill-${process.pid}-${nonce}`;
  const runtime = `${service.id} ${service.basePresetId || ''} ${service.dockerImage}`.toLowerCase().includes('mongo')
    ? 'mongodb'
    : 'redis';
  let sourceFile = runtime === 'mongodb' ? `/tmp/cds-rotation-${nonce}.archive.gz` : '';
  const localFile = path.join(root, runtime === 'mongodb' ? 'backup.archive.gz' : 'dump.rdb');
  let drillStarted = false;
  try {
    if (runtime === 'mongodb') {
      const auth = mongoAuth(service);
      const config = `password: ${yamlQuoted(auth.password)}\n`;
      const dump = await runner('docker', [
        'exec', '-i', source, 'mongodump',
        '--host=127.0.0.1', '--authenticationDatabase=admin', `--username=${auth.user}`,
        '--config=/dev/stdin', `--archive=${sourceFile}`, '--gzip',
      ], config);
      requireSuccess(dump, 'recovery.mongodb_backup_failed');
    } else {
      const auth = redisAuth(service);
      const script = [
        'set -eu',
        `REDIS_USER=${shellQuoted(auth.user)}`,
        `REDISCLI_AUTH=${shellQuoted(auth.password)}`,
        'export REDISCLI_AUTH',
        'redis-cli --user "$REDIS_USER" SAVE >/dev/null',
        'D=$(redis-cli --user "$REDIS_USER" --raw CONFIG GET dir | sed -n "2p")',
        'F=$(redis-cli --user "$REDIS_USER" --raw CONFIG GET dbfilename | sed -n "2p")',
        '[ -n "$D" ] && [ -n "$F" ]',
        'printf "%s/%s\\n" "$D" "$F"',
      ].join('\n');
      const save = await runner('docker', ['exec', '-i', source, 'sh', '-s'], `${script}\n`);
      requireSuccess(save, 'recovery.redis_backup_failed');
      sourceFile = save.stdout.trim().split('\n').at(-1)?.trim() || '';
      if (!sourceFile.startsWith('/')) throw new Error('recovery.redis_snapshot_path_missing');
    }
    const copied = await runner('docker', ['cp', `${source}:${sourceFile}`, localFile]);
    requireSuccess(copied, 'recovery.backup_copy_failed');
    const stat = await fs.promises.stat(localFile);
    if (!stat.isFile() || stat.size <= 0) throw new Error('recovery.backup_empty');
    await fs.promises.chmod(localFile, 0o600);
    const sha256 = await sha256File(localFile);
    const dataDir = path.join(root, 'data');
    await fs.promises.mkdir(dataDir, { mode: 0o700 });

    if (runtime === 'mongodb') {
      const start = await runner('docker', [
        'run', '-d', '--name', drillContainer, '--network', 'none',
        '--mount', `type=bind,src=${localFile},dst=/recovery/backup.archive.gz,readonly`,
        '--mount', `type=bind,src=${dataDir},dst=/data/db`,
        opts.mongoImage || 'mongo:7', '--bind_ip', '127.0.0.1',
      ]);
      requireSuccess(start, 'recovery.mongodb_drill_start_failed');
      drillStarted = true;
      requireSuccess(await waitReady(runner, drillContainer, [
        'mongosh', '--quiet', '--host', '127.0.0.1', '--eval', 'quit(db.adminCommand({ping:1}).ok===1?0:2)',
      ], opts.readinessAttempts || 30), 'recovery.mongodb_drill_not_ready');
      requireSuccess(await runner('docker', [
        'exec', drillContainer, 'mongorestore', '--host', '127.0.0.1',
        '--archive=/recovery/backup.archive.gz', '--gzip', '--drop',
      ]), 'recovery.mongodb_restore_failed');
      const probeScript = [
        'const ignored=new Set(["admin","config","local"]);',
        'const names=db.adminCommand({listDatabases:1,nameOnly:true}).databases.map(x=>x.name).filter(x=>!ignored.has(x));',
        'let n=0;for(const name of names){const d=db.getSiblingDB(name);for(const c of d.getCollectionNames()){if(d.getCollection(c).findOne({}, {_id:1})!==null)n+=1;}}',
        'print(n);',
      ].join('');
      const probe = await runner('docker', ['exec', drillContainer, 'mongosh', '--quiet', '--host', '127.0.0.1', '--eval', probeScript]);
      requireSuccess(probe, 'recovery.mongodb_probe_failed');
      const count = Number(probe.stdout.trim().split('\n').at(-1));
      if (!Number.isSafeInteger(count) || count <= 0) throw new Error('recovery.mongodb_no_nonempty_collections');
      return {
        backupId: `local:${service.projectId}:${service.id}:rotation-${nonce}:${sha256.slice(0, 16)}`,
        backupSha256: sha256,
        drillId: `drill_${nonce}`,
        restoredItemCount: count,
        verifiedAt: new Date().toISOString(),
      };
    }

    await fs.promises.copyFile(localFile, path.join(dataDir, 'dump.rdb'));
    const start = await runner('docker', [
      'run', '-d', '--name', drillContainer, '--network', 'none',
      '--mount', `type=bind,src=${dataDir},dst=/data`,
      opts.redisImage || 'redis:7', 'redis-server', '--appendonly', 'no', '--protected-mode', 'no',
    ]);
    requireSuccess(start, 'recovery.redis_drill_start_failed');
    drillStarted = true;
    const probe = await waitReady(runner, drillContainer, ['redis-cli', '--raw', 'DBSIZE'], opts.readinessAttempts || 30);
    requireSuccess(probe, 'recovery.redis_drill_not_ready');
    const count = Number(probe.stdout.trim().split('\n').at(-1));
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('recovery.redis_probe_invalid');
    return {
      backupId: `local:${service.projectId}:${service.id}:rotation-${nonce}:${sha256.slice(0, 16)}`,
      backupSha256: sha256,
      drillId: `drill_${nonce}`,
      restoredItemCount: count,
      verifiedAt: new Date().toISOString(),
    };
  } finally {
    if (drillStarted) await runner('docker', ['rm', '-f', drillContainer]).catch(() => undefined);
    if (runtime === 'mongodb') {
      await runner('docker', ['exec', source, 'rm', '-f', sourceFile]).catch(() => undefined);
    }
    // 通过演练的备份必须继续存在。只清临时容器和 Mongo 容器内中转文件；
    // root 由受控保留策略清理，不能返回一个随即被删除的 backupId。
  }
}
