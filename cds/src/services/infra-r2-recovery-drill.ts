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
) => Promise<RecoveryDrillCommandResult>;

export interface MongoRecoveryDrillResult {
  objectKey: string;
  bytes: number;
  sha256: string;
  databaseCount: number;
  collectionCount: number;
  nonEmptyCollectionCount: number;
}

const DEFAULT_MONGO_IMAGE = 'mongo:7';

async function runCommand(command: string, args: readonly string[]): Promise<RecoveryDrillCommandResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
  });
}

function failedCommand(label: string, result: RecoveryDrillCommandResult): Error {
  const detail = (result.stderr || result.stdout || `exit=${result.exitCode}`).trim().slice(0, 500);
  return new Error(`${label}失败：${detail}`);
}

function parseReadProbe(stdout: string): Pick<MongoRecoveryDrillResult, 'databaseCount' | 'collectionCount' | 'nonEmptyCollectionCount'> {
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
  if (![databaseCount, collectionCount, nonEmptyCollectionCount].every(Number.isSafeInteger)
      || databaseCount <= 0 || collectionCount <= 0 || nonEmptyCollectionCount <= 0) {
    throw new Error('离机备份虽可恢复，但没有读到任何非空集合');
  }
  return { databaseCount, collectionCount, nonEmptyCollectionCount };
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
}): Promise<MongoRecoveryDrillResult> {
  const runner = opts.commandRunner ?? runCommand;
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cds-r2-recovery-'));
  const archive = path.join(root, 'backup.archive.gz');
  const dataDir = path.join(root, 'mongo-data');
  const containerName = `cds-r2-drill-${process.pid}-${crypto.randomBytes(5).toString('hex')}`;
  const mongoImage = String(opts.mongoImage || DEFAULT_MONGO_IMAGE).trim();
  if (!mongoImage || /[\r\n\0]/.test(mongoImage)) throw new Error('临时 Mongo 镜像名无效');
  await fs.promises.mkdir(dataDir, { mode: 0o700 });

  let containerStarted = false;
  try {
    const remote = await downloadAndVerifyR2Backup({
      config: opts.config,
      objectKey: opts.objectKey,
      filePath: archive,
      fetchImpl: opts.fetchImpl,
    });
    const start = await runner('docker', [
      'run', '-d', '--name', containerName,
      '--network', 'none',
      '--mount', `type=bind,src=${archive},dst=/recovery/backup.archive.gz,readonly`,
      '--mount', `type=bind,src=${dataDir},dst=/data/db`,
      mongoImage,
      '--bind_ip', '127.0.0.1',
    ]);
    if (start.exitCode !== 0) throw failedCommand('启动隔离恢复容器', start);
    containerStarted = true;

    const attempts = Math.max(1, opts.readinessAttempts ?? 30);
    const delayMs = Math.max(0, opts.readinessDelayMs ?? 1_000);
    let ready = false;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const ping = await runner('docker', [
        'exec', containerName, 'mongosh', '--quiet', '--host', '127.0.0.1',
        '--eval', 'quit(db.adminCommand({ping:1}).ok===1?0:2)',
      ]);
      if (ping.exitCode === 0) { ready = true; break; }
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    if (!ready) throw new Error('隔离恢复容器未在限定时间内就绪');

    const restore = await runner('docker', [
      'exec', containerName, 'mongorestore', '--host', '127.0.0.1',
      '--archive=/recovery/backup.archive.gz', '--gzip', '--drop',
    ]);
    if (restore.exitCode !== 0) throw failedCommand('恢复离机备份', restore);

    const probeScript = [
      'const ignored=new Set(["admin","config","local"]);',
      'const names=db.adminCommand({listDatabases:1,nameOnly:true}).databases.map(x=>x.name).filter(x=>!ignored.has(x));',
      'let collectionCount=0,nonEmptyCollectionCount=0;',
      'for(const name of names){const d=db.getSiblingDB(name);for(const c of d.getCollectionNames()){collectionCount+=1;if(d.getCollection(c).findOne({}, {_id:1})!==null)nonEmptyCollectionCount+=1;}}',
      'print(JSON.stringify({databaseCount:names.length,collectionCount,nonEmptyCollectionCount}));',
    ].join('');
    const probe = await runner('docker', [
      'exec', containerName, 'mongosh', '--quiet', '--host', '127.0.0.1', '--eval', probeScript,
    ]);
    if (probe.exitCode !== 0) throw failedCommand('读取恢复数据', probe);
    return { ...remote, ...parseReadProbe(probe.stdout) };
  } finally {
    if (containerStarted) {
      await runner('docker', ['rm', '-f', containerName]).catch(() => undefined);
    }
    await fs.promises.rm(root, { recursive: true, force: true });
  }
}
