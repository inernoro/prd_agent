/**
 * 数据台账的真实 docker 操作（备份落盘 / 数对象 / 演练还原 / 丢弃 / 列库）。
 *
 * 凭据用基础设施实例的 root（与克隆通道同款），经 docker exec -e 注入，不进宿主 ps；
 * 备份文件走 docker exec 的 stdout 流式落到宿主，不经 CDS 内存缓冲整份 dump。
 * 丢弃有命名双保险：隔离库必须含 `_rs_`；分支独立库必须是「源库_后缀」形态且不等于源库。
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import type { InfraService, DbLedgerEntry } from '../types.js';
import { runDockerExec, maskSecretValues } from '../routes/infra-data.js';
import type { ReplicaDbEngine } from './replica-db-clone.js';
import type { DbLedgerOps } from './db-ledger.js';

const DB_NAME_SAFE = /^[A-Za-z0-9_]+$/;

interface EngineCred { argvPrefix: string[]; secrets: string[]; user: string; pw: string; port: number }

function cred(engine: ReplicaDbEngine, infra: InfraService): EngineCred {
  const env = infra.env || {};
  const port = infra.containerPort || (engine === 'mysql' ? 3306 : engine === 'postgres' ? 5432 : 27017);
  if (engine === 'mysql') {
    const pw = env.MYSQL_ROOT_PASSWORD || env.MARIADB_ROOT_PASSWORD || '';
    return { argvPrefix: ['-e', `MYSQL_PWD=${pw}`], secrets: [pw], user: 'root', pw, port };
  }
  if (engine === 'postgres') {
    const user = env.POSTGRES_USER || 'postgres';
    const pw = env.POSTGRES_PASSWORD || '';
    return { argvPrefix: ['-e', `PGPASSWORD=${pw}`], secrets: [pw], user, pw, port };
  }
  const user = env.MONGO_INITDB_ROOT_USERNAME || '';
  const pw = env.MONGO_INITDB_ROOT_PASSWORD || '';
  return { argvPrefix: [], secrets: [pw], user, pw, port };
}

function mongoUri(c: EngineCred, dbName: string): string {
  const auth = c.user ? `${encodeURIComponent(c.user)}:${encodeURIComponent(c.pw)}@` : '';
  const authSource = c.user ? '?authSource=admin' : '';
  return `mongodb://${auth}127.0.0.1:${c.port}/${dbName}${authSource}`;
}

function assertSafe(dbName: string): void {
  if (!DB_NAME_SAFE.test(dbName)) throw new Error(`库名含不安全字符，拒绝操作: ${dbName}`);
}

/** docker exec 的 stdout 流式写入宿主文件；stdin 可选（还原时喂备份文件） */
function streamDockerExec(argv: string[], opts: { toFile?: string; fromFile?: string; secrets: string[]; timeoutMs: number }): Promise<{ bytes: number; sha256: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn('docker', argv, { stdio: [opts.fromFile ? 'pipe' : 'ignore', opts.toFile ? 'pipe' : 'ignore', 'pipe'] });
    const hash = createHash('sha256');
    let bytes = 0;
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* noop */ } }, opts.timeoutMs);
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err); else resolve({ bytes, sha256: hash.digest('hex') });
    };
    proc.stderr?.on('data', (c: Buffer) => { if (stderr.length < 16_000) stderr += c.toString(); });
    if (opts.toFile) {
      const out = fs.createWriteStream(opts.toFile);
      proc.stdout!.on('data', (c: Buffer) => { bytes += c.length; hash.update(c); });
      proc.stdout!.pipe(out);
      out.on('error', (e) => finish(e));
    }
    if (opts.fromFile) {
      const input = fs.createReadStream(opts.fromFile);
      input.on('error', (e) => finish(e));
      input.pipe(proc.stdin!);
    }
    proc.on('error', (e) => finish(e));
    proc.on('close', (code) => {
      if (code !== 0) finish(new Error(maskSecretValues(stderr.trim().slice(-600), opts.secrets) || `docker 退出码 ${code}`));
      else finish();
    });
  });
}

export const realDbLedgerOps: DbLedgerOps = {
  async dumpToFile(engine, infra, dbName, file) {
    assertSafe(dbName);
    const c = cred(engine, infra);
    const name = infra.containerName;
    let argv: string[];
    if (engine === 'mysql') {
      argv = ['exec', ...c.argvPrefix, name, 'sh', '-c',
        `mysqldump -u${c.user} -h127.0.0.1 -P${c.port} --single-transaction --quick --routines --events --no-tablespaces --databases ${dbName} | gzip`];
    } else if (engine === 'postgres') {
      argv = ['exec', ...c.argvPrefix, name, 'sh', '-c',
        `pg_dump -U ${c.user} -h 127.0.0.1 -p ${c.port} -d ${dbName} --clean --if-exists --no-owner --no-privileges | gzip`];
    } else {
      argv = ['exec', name, 'mongodump', `--uri=${mongoUri(c, dbName)}`, '--archive', '--gzip', '-d', dbName];
    }
    const r = await streamDockerExec(argv, { toFile: file, secrets: c.secrets, timeoutMs: 30 * 60_000 });
    if (r.bytes < 32) throw new Error(`备份文件几乎为空（${r.bytes} 字节），不算备份成功`);
    return r;
  },

  async countObjects(engine, infra, dbName) {
    assertSafe(dbName);
    const c = cred(engine, infra);
    const name = infra.containerName;
    let argv: string[];
    if (engine === 'mysql') {
      argv = ['exec', '-i', ...c.argvPrefix, name, 'mysql', `-u${c.user}`, '-h127.0.0.1', `-P${c.port}`, '-N', '-B', '-e',
        `SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = '${dbName}'`];
    } else if (engine === 'postgres') {
      argv = ['exec', '-i', ...c.argvPrefix, name, 'psql', '-U', c.user, '-h', '127.0.0.1', '-p', String(c.port), '-d', dbName, '-tA', '-c',
        "SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema')"];
    } else {
      argv = ['exec', '-i', name, 'mongosh', mongoUri(c, dbName), '--quiet', '--eval', 'print(db.getCollectionNames().length)'];
    }
    const r = await runDockerExec(argv, '', 60_000, 16 * 1024);
    if (r.code !== 0) throw new Error(maskSecretValues((r.stderr || r.stdout).trim().slice(-300), c.secrets));
    const n = Number((r.stdout.trim().split('\n').pop() || '').trim());
    if (!Number.isFinite(n)) throw new Error(`数对象失败：客户端输出无法解析`);
    return n;
  },

  async restoreDrill(engine, infra, file, scratchDb) {
    assertSafe(scratchDb);
    if (!scratchDb.startsWith('cds_drill_')) throw new Error(`演练库名必须以 cds_drill_ 开头: ${scratchDb}`);
    const c = cred(engine, infra);
    const name = infra.containerName;
    try {
      if (engine === 'mysql') {
        // mysqldump --databases 会带 CREATE DATABASE / USE 原库名；演练时用 sed 把库名换成临时库
        await runDockerExec(['exec', '-i', ...c.argvPrefix, name, 'mysql', `-u${c.user}`, '-h127.0.0.1', `-P${c.port}`, '-e', `CREATE DATABASE IF NOT EXISTS \`${scratchDb}\``], '', 60_000, 8 * 1024);
        await streamDockerExec(['exec', '-i', ...c.argvPrefix, name, 'sh', '-c',
          `gunzip -c | sed -E 's/^(CREATE DATABASE[^\`]*\`)[^\`]+(\`)/\\1${scratchDb}\\2/; s/^USE \`[^\`]+\`;/USE \`${scratchDb}\`;/' | mysql -u${c.user} -h127.0.0.1 -P${c.port} ${scratchDb}`],
        { fromFile: file, secrets: c.secrets, timeoutMs: 30 * 60_000 });
      } else if (engine === 'postgres') {
        await runDockerExec(['exec', '-i', ...c.argvPrefix, name, 'psql', '-U', c.user, '-h', '127.0.0.1', '-p', String(c.port), '-d', 'postgres', '-c', `CREATE DATABASE "${scratchDb}"`], '', 60_000, 8 * 1024);
        await streamDockerExec(['exec', '-i', ...c.argvPrefix, name, 'sh', '-c',
          `gunzip -c | psql -U ${c.user} -h 127.0.0.1 -p ${c.port} -q -v ON_ERROR_STOP=1 -d ${scratchDb} >/dev/null`],
        { fromFile: file, secrets: c.secrets, timeoutMs: 30 * 60_000 });
      } else {
        await streamDockerExec(['exec', '-i', name, 'mongorestore', `--uri=${mongoUri(c, 'admin')}`, '--archive', '--gzip', '--nsFrom', '*.*', '--nsTo', `${scratchDb}.*`, '--drop'],
          { fromFile: file, secrets: c.secrets, timeoutMs: 30 * 60_000 });
      }
      const objects = await this.countObjects(engine, infra, scratchDb);
      return { objects };
    } finally {
      await this.dropDb(engine, infra, { dbName: scratchDb }).catch(() => undefined);
    }
  },

  async dropDb(engine, infra, entry) {
    assertSafe(entry.dbName);
    const c = cred(engine, infra);
    if (entry.dedicatedContainer) {
      if (!entry.dedicatedContainer.startsWith('cds-rsdb-')) throw new Error(`拒绝删除非隔离实例命名的容器: ${entry.dedicatedContainer}`);
      const rm = await runDockerExec(['rm', '-f', '-v', entry.dedicatedContainer], '', 120_000, 16 * 1024);
      if (rm.code !== 0 && !/No such container/i.test(rm.stderr || '')) throw new Error(`删除专用隔离实例失败: ${(rm.stderr || rm.stdout).trim().slice(-300)}`);
      return;
    }
    const name = infra.containerName;
    let argv: string[];
    if (engine === 'mysql') argv = ['exec', '-i', ...c.argvPrefix, name, 'mysql', `-u${c.user}`, '-h127.0.0.1', `-P${c.port}`, '-e', `DROP DATABASE IF EXISTS \`${entry.dbName}\``];
    else if (engine === 'postgres') argv = ['exec', '-i', ...c.argvPrefix, name, 'psql', '-U', c.user, '-h', '127.0.0.1', '-p', String(c.port), '-d', 'postgres', '-c', `DROP DATABASE IF EXISTS "${entry.dbName}"`];
    else argv = ['exec', '-i', name, 'mongosh', mongoUri(c, entry.dbName), '--quiet', '--eval', 'db.dropDatabase()'];
    const r = await runDockerExec(argv, '', 120_000, 16 * 1024);
    if (r.code !== 0) throw new Error(`删除库失败: ${maskSecretValues((r.stderr || r.stdout).trim().slice(-300), c.secrets)}`);
  },

  async listDatabases(engine, infra) {
    const c = cred(engine, infra);
    const name = infra.containerName;
    let argv: string[];
    if (engine === 'mysql') argv = ['exec', '-i', ...c.argvPrefix, name, 'mysql', `-u${c.user}`, '-h127.0.0.1', `-P${c.port}`, '-N', '-B', '-e', 'SHOW DATABASES'];
    else if (engine === 'postgres') argv = ['exec', '-i', ...c.argvPrefix, name, 'psql', '-U', c.user, '-h', '127.0.0.1', '-p', String(c.port), '-d', 'postgres', '-tA', '-c', 'SELECT datname FROM pg_database WHERE datistemplate = false'];
    else argv = ['exec', '-i', name, 'mongosh', mongoUri(c, 'admin'), '--quiet', '--eval', 'db.adminCommand({listDatabases:1}).databases.forEach(d => print(d.name))'];
    const r = await runDockerExec(argv, '', 60_000, 64 * 1024);
    if (r.code !== 0) throw new Error(maskSecretValues((r.stderr || r.stdout).trim().slice(-300), c.secrets));
    return r.stdout.split('\n').map((l) => l.trim()).filter((l) => l && DB_NAME_SAFE.test(l));
  },
};

export function isDroppableDerivedName(entry: Pick<DbLedgerEntry, 'kind' | 'dbName' | 'sourceDb' | 'origin'>): { ok: boolean; reason?: string } {
  if (entry.kind === 'isolated') {
    return entry.dbName.includes('_rs_') ? { ok: true } : { ok: false, reason: `隔离库命名不含 _rs_，拒绝删除: ${entry.dbName}` };
  }
  if (entry.kind === 'per-branch') {
    if (!entry.sourceDb || entry.dbName === entry.sourceDb || !entry.dbName.startsWith(`${entry.sourceDb}_`)) {
      return { ok: false, reason: `分支独立库必须是「源库_后缀」形态且不等于源库，拒绝删除: ${entry.dbName}` };
    }
    return { ok: true };
  }
  // 来源未知的库：只有扫描补录的才允许（用户明知它是残留），且必须走强制通道——门禁在路由层
  return entry.origin === 'scan' ? { ok: true } : { ok: false, reason: '来源未知且不是扫描补录的条目，拒绝删除' };
}
