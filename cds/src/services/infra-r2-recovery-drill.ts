import { DOCKER_LOG_LIMIT_ARGS } from './docker-log-policy.js';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  downloadAndVerifyR2Backup,
  type R2BackupConfig,
} from './infra-backup-r2.js';

export interface RecoveryDrillCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type RecoveryDrillCommandRunner = (
  command: string,
  args: readonly string[],
  timeoutMs?: number,
) => Promise<RecoveryDrillCommandResult>;

export interface MongoRecoveryDrillResult {
  objectKey: string;
  bytes: number;
  sha256: string;
  databaseCount: number;
  collectionCount: number;
  nonEmptyCollectionCount: number;
  validatedCollectionCount: number;
}

async function runCommand(command: string, args: readonly string[], timeoutMs = 30_000): Promise<RecoveryDrillCommandResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let truncated = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    timer.unref();
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); truncated ||= stdout.length > 262_144; stdout = stdout.slice(-262_144); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); truncated ||= stderr.length > 262_144; stderr = stderr.slice(-262_144); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ exitCode: timedOut ? 124 : truncated ? 125 : code ?? 1, stdout, stderr }); });
  });
}

function failedCommand(label: string, result: RecoveryDrillCommandResult): Error {
  // Native restore output may include database names, documents or authentication text.
  return new Error(`${label}失败（exit=${result.exitCode}）；原始输出不展示`);
}

function parseReadProbe(stdout: string): Pick<MongoRecoveryDrillResult, 'databaseCount' | 'collectionCount' | 'nonEmptyCollectionCount' | 'validatedCollectionCount'> {
  const line = stdout.trim().split('\n').filter(Boolean).at(-1) || '';
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error('临时 Mongo 的可读性探测没有返回有效 JSON');
  }
  const record = value as Record<string, unknown>;
  const databaseCount = Number(record.databaseCount);
  const collectionCount = Number(record.collectionCount);
  const nonEmptyCollectionCount = Number(record.nonEmptyCollectionCount);
  const validatedCollectionCount = Number(record.validatedCollectionCount);
  if (![databaseCount, collectionCount, nonEmptyCollectionCount, validatedCollectionCount].every(Number.isSafeInteger)
      || databaseCount <= 0 || collectionCount <= 0 || nonEmptyCollectionCount <= 0 || validatedCollectionCount !== collectionCount) {
    throw new Error('离机备份虽可恢复，但没有读到任何非空集合');
  }
  return { databaseCount, collectionCount, nonEmptyCollectionCount, validatedCollectionCount };
}

/**
 * 把一份 R2 Mongo 备份恢复进不发布任何端口的临时容器，并实际读取集合。
 *
 * 演练只输出计数与校验摘要，不输出集合名、文档或凭据。所有 Docker 调用使用参数数组，
 * 不经过 shell；R2 凭据只存在于当前进程环境，不进入命令行。
 */
export async function runMongoR2RecoveryDrill(opts: {
  config: R2BackupConfig;
  objectKey: string;
  mongoImage?: string;
  fetchImpl?: typeof fetch;
  commandRunner?: RecoveryDrillCommandRunner;
  readinessAttempts?: number;
  readinessDelayMs?: number;
  /** Private drill budgets, not production service defaults. Images must already be local. */
  maxArchiveBytes?: number;
  dataBytes?: number;
  memoryBytes?: number;
  timeoutMs?: number;
}): Promise<MongoRecoveryDrillResult> {
  const GiB = 1024 ** 3;
  const maxArchiveBytes = opts.maxArchiveBytes ?? 4 * GiB;
  const dataBytes = opts.dataBytes ?? 8 * GiB;
  const memoryBytes = opts.memoryBytes ?? 10 * GiB;
  const timeoutMs = opts.timeoutMs ?? 600_000;
  if (![maxArchiveBytes, dataBytes, memoryBytes, timeoutMs].every((n) => Number.isSafeInteger(n) && n > 0)
      || memoryBytes <= dataBytes || timeoutMs > 3_600_000) throw new Error('隔离恢复资源预算无效');
  const mongoImage = String(opts.mongoImage || '').trim();
  if (!mongoImage || /[\r\n\0]/.test(mongoImage)) throw new Error('必须显式指定已核对源库版本的临时 Mongo 镜像');
  const nativeRunner = opts.commandRunner ?? runCommand;
  const deadline = Date.now() + timeoutMs;
  const runner: RecoveryDrillCommandRunner = (command, args) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('隔离恢复演练超时');
    return nativeRunner(command, args, Math.min(args.includes('mongorestore') || args.some((arg) => arg.includes('validatedCollectionCount')) ? timeoutMs : 30_000, remaining));
  };
  // Never pull implicitly, and pin the local immutable image identity for the entire drill.
  const image = await runner('docker', ['image', 'inspect', '--format', '{{.Id}}', mongoImage]);
  const imageId = image.stdout.trim();
  if (image.exitCode !== 0 || !/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new Error('隔离恢复镜像未在本机确认，禁止自动拉取');
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cds-r2-recovery-'));
  const rootIdentity = await fs.promises.lstat(root);
  const archive = path.join(root, 'backup.archive.gz');
  const token = crypto.randomBytes(16).toString('hex');
  const ownerLabel = 'org.cds.recovery-drill';
  const containerName = `cds-r2-drill-${process.pid}-${token}`;
  let createAttempted = false;
  let archiveIdentity: fs.Stats | undefined;
  let containerId: string | undefined;
  let cleanupConfirmed = false;
  const inspectOwned = async (target: string): Promise<string> => {
    const inspect = await nativeRunner('docker', ['container', 'inspect', '--format', '{{json .}}', target], 30_000);
    if (inspect.exitCode !== 0) throw new Error('隔离恢复容器身份查询失败');
    let value;
    try { value = JSON.parse(inspect.stdout); } catch { throw new Error('隔离恢复容器身份查询不完整'); }
    if (!/^[a-f0-9]{64}$/.test(value?.Id ?? '') || value.Name !== `/${containerName}`
        || value.Config?.Labels?.[ownerLabel] !== token || value.Image !== imageId
        || (containerId && value.Id !== containerId)) throw new Error('隔离恢复容器身份不一致，继续保留');
    return value.Id;
  };
  const listIds = async (): Promise<string[]> => {
    const list = await nativeRunner('docker', ['ps', '-aq', '--no-trunc'], 30_000);
    const ids = list.stdout.trim() ? list.stdout.trim().split(/\s+/) : [];
    if (list.exitCode !== 0 || ids.some((id) => !/^[a-f0-9]{64}$/.test(id))) throw new Error('容器清单查询失败或不完整');
    return ids;
  };
  try {
    const space = await fs.promises.statfs(root);
    if (space.bavail * space.bsize < maxArchiveBytes + GiB) throw new Error('下载盘无法满足归档预算及1GiB余量');
    if (os.freemem() < memoryBytes + 2 * GiB) throw new Error('可用内存无法满足恢复预算及2GiB余量');
    const remote = await downloadAndVerifyR2Backup({
      config: opts.config, objectKey: opts.objectKey, filePath: archive, fetchImpl: opts.fetchImpl,
      maxBytes: maxArchiveBytes, signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
    });
    const downloadRoot = await fs.promises.lstat(root);
    if (!downloadRoot.isDirectory() || downloadRoot.dev !== rootIdentity.dev || downloadRoot.ino !== rootIdentity.ino) throw new Error('下载目录身份变化');
    archiveIdentity = await fs.promises.lstat(archive);
    if (!archiveIdentity.isFile() || archiveIdentity.isSymbolicLink() || archiveIdentity.nlink !== 1) throw new Error('下载归档身份未确认');
    createAttempted = true;
    const create = await runner('docker', [
      'create', ...DOCKER_LOG_LIMIT_ARGS, '--name', containerName,
      '--label', `${ownerLabel}=${token}`, '--network', 'none', '--pull', 'never',
      '--memory', String(memoryBytes), '--memory-swap', String(memoryBytes), '--cpus', '2',
      '--tmpfs', `/data/db:rw,nosuid,nodev,size=${dataBytes}`,
      '--tmpfs', '/data/configdb:rw,nosuid,nodev,size=16777216',
      '--mount', `type=bind,src=${archive},dst=/recovery/backup.archive.gz,readonly`,
      imageId, '--bind_ip', '127.0.0.1', '--setParameter', 'ttlMonitorEnabled=false',
      '--wiredTigerCacheSizeGB', '0.25',
    ]);
    if (create.exitCode !== 0) throw failedCommand('创建隔离恢复容器', create);
    containerId = await inspectOwned(containerName);
    const start = await runner('docker', ['start', containerId]);
    if (start.exitCode !== 0) throw failedCommand('启动隔离恢复容器', start);

    const attempts = Math.max(1, opts.readinessAttempts ?? 30);
    const delayMs = Math.max(0, opts.readinessDelayMs ?? 1_000);
    let ready = false;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const ping = await runner('docker', [
        'exec', containerId, 'mongosh', '--quiet', '--host', '127.0.0.1',
        '--eval', 'quit(db.adminCommand({ping:1}).ok===1?0:2)',
      ]);
      if (ping.exitCode === 0) { ready = true; break; }
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    if (!ready) throw new Error('隔离恢复容器未在限定时间内就绪');

    const restore = await runner('docker', [
      'exec', containerId, 'mongorestore', '--host', '127.0.0.1',
      '--archive=/recovery/backup.archive.gz', '--gzip', '--drop',
    ]);
    if (restore.exitCode !== 0) throw failedCommand('恢复离机备份', restore);

    const probeScript = [
      'const ignored=new Set(["admin","config","local"]);',
      'const names=db.adminCommand({listDatabases:1,nameOnly:true}).databases.map(x=>x.name).filter(x=>!ignored.has(x));',
      'let collectionCount=0,nonEmptyCollectionCount=0,validatedCollectionCount=0;',
      'for(const name of names){const d=db.getSiblingDB(name);for(const c of d.getCollectionInfos({type:"collection"}).map(x=>x.name)){collectionCount+=1;if(d.getCollection(c).findOne({}, {_id:1})!==null)nonEmptyCollectionCount+=1;const check=d.runCommand({validate:c,full:true});if(check.ok!==1||check.valid!==true)quit(3);validatedCollectionCount+=1;}}',
      'print(JSON.stringify({databaseCount:names.length,collectionCount,nonEmptyCollectionCount,validatedCollectionCount}));',
    ].join('');
    const probe = await runner('docker', [
      'exec', containerId, 'mongosh', '--quiet', '--host', '127.0.0.1', '--eval', probeScript,
    ]);
    if (probe.exitCode !== 0) throw failedCommand('读取恢复数据', probe);
    return { ...remote, ...parseReadProbe(probe.stdout) };
  } finally {
    try {
      if (createAttempted) {
        // A failed create/start may still have produced a container. Reconcile first.
        if (!containerId) {
          const names = await nativeRunner('docker', ['ps', '-a', '--no-trunc', '--format', '{{json .}}'], 30_000);
          if (names.exitCode !== 0) throw new Error('创建结果未知，无法确认容器清单');
          const rows = names.stdout.trim() ? names.stdout.trim().split('\n').map((line) => JSON.parse(line)) : [];
          if (rows.some((row) => !/^[a-f0-9]{64}$/.test(row.ID ?? '') || typeof row.Names !== 'string')) throw new Error('容器清单不完整');
          if (rows.some((row) => row.Names === containerName)) containerId = await inspectOwned(containerName);
        }
        if (containerId) {
          await inspectOwned(containerId);
          const removed = await nativeRunner('docker', ['rm', '-f', '-v', containerId], 30_000);
          if (removed.exitCode !== 0) throw new Error('隔离容器清场未确认');
          if ((await listIds()).includes(containerId)) throw new Error('隔离容器仍有引用');
        }
      }
      const current = await fs.promises.lstat(root);
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== rootIdentity.dev || current.ino !== rootIdentity.ino) {
        throw new Error('演练目录身份变化，继续保留');
      }
      // Only this task's archive can exist on disk; restored database files live in bounded tmpfs.
      const files = await fs.promises.readdir(root);
      if (files.some((name) => name !== 'backup.archive.gz')) throw new Error('演练目录出现未知对象，继续保留');
      for (const name of files) {
        const file = path.join(root, name);
        const stat = await fs.promises.lstat(file);
        if (!archiveIdentity || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
            || stat.dev !== archiveIdentity.dev || stat.ino !== archiveIdentity.ino) throw new Error('归档身份变化，继续保留');
        await fs.promises.unlink(file);
      }
      await fs.promises.rmdir(root);
      cleanupConfirmed = true;
    } catch {
      // Do not turn cleanup failure into a successful recovery receipt or delete a live mount.
      throw new Error(`恢复演练清场未确认；保留目录 ${root}，容器 ${containerId ?? containerName}，需按任务标签核对`);
    }
    if (!cleanupConfirmed) throw new Error('恢复演练清场未确认');
  }
}
