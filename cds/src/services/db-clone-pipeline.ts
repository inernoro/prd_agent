/**
 * 关系型整库克隆管线（数据库隔离收敛 4，2026-09-04）。
 *
 * 入参只有一个三元组：来源库、目标库、承载它们的实例（外加一个只用于记账的作用域）。
 * 复制集「一键隔离」与分支独立库「时间点克隆」都调这一条，dump→导入脚本、辅助容器限额、
 * 两阶段落盘（`dump | client` 管道会吞掉 dump 的退出码）只在这里维护一份。
 *
 * 只管 mysql / postgres：mongo 的克隆必须走专用实例（共享 mongod 大批量写入会崩，见
 * replica-db-clone.ts 的 cloneMongoViaDedicatedInstance），不在本管线里。
 *
 * 逐表行数校验：克隆完成后分别数源库、目标库每张基表的行数并比对。克隆是时间点快照，
 * 校验不一致不等于克隆坏了——常见原因是克隆期间源库又有写入；校验表的作用是把
 * 「哪张表差了多少」摆出来，而不是自动判死。
 */
import type { DbCloneVerification, InfraService } from '../types.js';
import type { DbEngine } from './db-env-keys.js';
import { runDockerExec, maskSecretValues, type DockerExecResult } from '../routes/infra-data.js';

export type DbCloneExec = (argv: string[], stdin: string, timeoutMs?: number, maxBytes?: number) => Promise<DockerExecResult>;

export interface DbCloneScope {
  kind: 'per-branch' | 'replica-member';
  projectId?: string;
  branchId: string;
  profileId: string;
  memberId?: string;
}

/** 克隆三元组：来源库 → 目标库，同一个实例内 */
export interface DbCloneSpec {
  engine: DbEngine;
  infra: InfraService;
  sourceDb: string;
  targetDb: string;
  scope: DbCloneScope;
}

const DB_NAME_SAFE = /^[a-z0-9_]+$/i;
const TABLE_NAME_SAFE = /^[A-Za-z0-9_]+$/;

interface EngineConn { user: string; pw: string; port: number; secrets: string[]; envFlags: string[] }

function assertResolved(key: string, value: string): string {
  if (/\$\{[^}]+\}/.test(value)) {
    throw new Error(`基础设施记录里的 ${key} 仍是未解析的模板 ${value}：项目环境变量里没有对应的值，先在「项目环境变量」补上再克隆 / 备份 / 回写`);
  }
  return value;
}

function connOf(spec: Pick<DbCloneSpec, 'engine' | 'infra'>): EngineConn {
  const env = spec.infra.env || {};
  if (spec.engine === 'mysql') {
    const pw = assertResolved(env.MYSQL_ROOT_PASSWORD ? 'MYSQL_ROOT_PASSWORD' : 'MARIADB_ROOT_PASSWORD', env.MYSQL_ROOT_PASSWORD || env.MARIADB_ROOT_PASSWORD || '');
    return { user: 'root', pw, port: spec.infra.containerPort || 3306, secrets: [pw], envFlags: ['-e', `MYSQL_PWD=${pw}`] };
  }
  if (spec.engine === 'postgres') {
    const pw = assertResolved('POSTGRES_PASSWORD', env.POSTGRES_PASSWORD || '');
    const user = assertResolved('POSTGRES_USER', env.POSTGRES_USER || 'postgres');
    return { user, pw, port: spec.infra.containerPort || 5432, secrets: [pw], envFlags: ['-e', `PGPASSWORD=${pw}`] };
  }
  throw new Error(`mongo 不走关系型克隆管线（共享实例写压会崩，须用专用实例通道）`);
}

function assertSpec(spec: DbCloneSpec): void {
  if (spec.engine === 'mongo') throw new Error('mongo 不走关系型克隆管线（共享实例写压会崩，须用专用实例通道）');
  if (!DB_NAME_SAFE.test(spec.sourceDb)) throw new Error(`源库名不合法: ${spec.sourceDb}`);
  if (!DB_NAME_SAFE.test(spec.targetDb)) throw new Error(`目标库名不合法: ${spec.targetDb}`);
  if (spec.targetDb.length > 60) throw new Error(`目标库名超长（${spec.targetDb.length} > 60，mysql/postgres 标识符上限）`);
  if (spec.sourceDb.toLowerCase() === spec.targetDb.toLowerCase()) throw new Error(`目标库不能等于源库: ${spec.sourceDb}`);
}

/**
 * 生成克隆的 docker argv（独立限额辅助容器，共享 DB 容器的网络命名空间；
 * 同镜像自带客户端工具）。凭据只经 `-e` 注入，不进脚本正文。
 */
export function relationalCloneArgv(spec: DbCloneSpec): { argv: string[]; secrets: string[] } {
  assertSpec(spec);
  const conn = connOf(spec);
  const c = spec.infra.containerName;
  const helper = (script: string): string[] => [
    'run', '--rm', '-i', '--pull', 'never',
    '--network', `container:${c}`,
    '--memory', '768m', '--memory-swap', '768m', '--cpus', '1',
    '--entrypoint', 'sh',
    ...conn.envFlags,
    spec.infra.dockerImage,
    '-c', script,
  ];
  // 两阶段 dump→导入：落盘中间产物让两个进程的退出码都被 set -e 逐个把关
  //（`dump | client` 管道在 POSIX sh 下退出码取末端 client，dump 半路失败也是 0）。
  if (spec.engine === 'mysql') {
    const flags = `-h127.0.0.1 -P${conn.port} -u${conn.user}`;
    return {
      argv: helper(
        `set -e; mysql ${flags} -e 'CREATE DATABASE IF NOT EXISTS \`${spec.targetDb}\`'; ` +
        `mysqldump ${flags} --single-transaction --routines --triggers ${spec.sourceDb} > /tmp/rsclone.sql; ` +
        `mysql ${flags} ${spec.targetDb} < /tmp/rsclone.sql; rm -f /tmp/rsclone.sql`,
      ),
      secrets: conn.secrets,
    };
  }
  const flags = `-h 127.0.0.1 -p ${conn.port} -U ${conn.user}`;
  return {
    argv: helper(
      `set -e; psql ${flags} -d postgres -v ON_ERROR_STOP=1 -c 'CREATE DATABASE "${spec.targetDb}"' 2>/dev/null || true; ` +
      `pg_dump ${flags} ${spec.sourceDb} > /tmp/rsclone.sql; ` +
      `psql ${flags} -q -v ON_ERROR_STOP=1 -d ${spec.targetDb} < /tmp/rsclone.sql; rm -f /tmp/rsclone.sql`,
    ),
    secrets: conn.secrets,
  };
}

/**
 * 整库替换（回写 / 用另一个库刷新当前库）：dump 来源库 → 删掉并重建目标库 → 导入。
 * 目标库会短暂不存在，调用方必须先备份目标库并演练验证（见 db-write-back.ts 的门禁）。
 * postgres 先踢掉目标库上的连接，否则 DROP DATABASE 会因为有会话而失败。
 */
export function relationalReplaceArgv(spec: DbCloneSpec): { argv: string[]; secrets: string[] } {
  assertSpec(spec);
  const conn = connOf(spec);
  const c = spec.infra.containerName;
  const helper = (script: string): string[] => [
    'run', '--rm', '-i', '--pull', 'never',
    '--network', `container:${c}`,
    '--memory', '768m', '--memory-swap', '768m', '--cpus', '1',
    '--entrypoint', 'sh',
    ...conn.envFlags,
    spec.infra.dockerImage,
    '-c', script,
  ];
  if (spec.engine === 'mysql') {
    const flags = `-h127.0.0.1 -P${conn.port} -u${conn.user}`;
    return {
      argv: helper(
        `set -e; mysqldump ${flags} --single-transaction --routines --triggers ${spec.sourceDb} > /tmp/rsclone.sql; ` +
        `mysql ${flags} -e 'DROP DATABASE IF EXISTS \`${spec.targetDb}\`; CREATE DATABASE \`${spec.targetDb}\`'; ` +
        `mysql ${flags} ${spec.targetDb} < /tmp/rsclone.sql; rm -f /tmp/rsclone.sql`,
      ),
      secrets: conn.secrets,
    };
  }
  const flags = `-h 127.0.0.1 -p ${conn.port} -U ${conn.user}`;
  return {
    argv: helper(
      `set -e; pg_dump ${flags} ${spec.sourceDb} > /tmp/rsclone.sql; ` +
      `psql ${flags} -d postgres -v ON_ERROR_STOP=1 -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${spec.targetDb}' AND pid <> pg_backend_pid()" >/dev/null; ` +
      `psql ${flags} -d postgres -v ON_ERROR_STOP=1 -c 'DROP DATABASE IF EXISTS "${spec.targetDb}"' -c 'CREATE DATABASE "${spec.targetDb}"'; ` +
      `psql ${flags} -q -v ON_ERROR_STOP=1 -d ${spec.targetDb} < /tmp/rsclone.sql; rm -f /tmp/rsclone.sql`,
    ),
    secrets: conn.secrets,
  };
}

/**
 * 还原脚本（备份文件经 stdin 喂给 docker exec）：目标库先删后建，再把 gunzip 流灌进去。
 * 返回的是 `sh -c` 的脚本正文与 exec 前缀；调用方用 streamDockerExec 把宿主文件接到 stdin。
 */
export function relationalRestoreScript(engine: DbEngine, infra: InfraService, targetDb: string): { argv: string[]; script: string; secrets: string[] } {
  if (!DB_NAME_SAFE.test(targetDb)) throw new Error(`目标库名不合法: ${targetDb}`);
  const conn = connOf({ engine, infra });
  let script: string;
  if (engine === 'mysql') {
    const flags = `-u${conn.user} -h127.0.0.1 -P${conn.port}`;
    // mysqldump --databases 带 CREATE DATABASE / USE 原库名；还原到指定目标时统一改成目标库名
    script = `set -e; mysql ${flags} -e 'DROP DATABASE IF EXISTS \`${targetDb}\`; CREATE DATABASE \`${targetDb}\`'; ` +
      `gunzip -c | sed -E 's/^(CREATE DATABASE[^\`]*\`)[^\`]+(\`)/\\1${targetDb}\\2/; s/^USE \`[^\`]+\`;/USE \`${targetDb}\`;/' | mysql ${flags} ${targetDb}`;
  } else {
    const flags = `-U ${conn.user} -h 127.0.0.1 -p ${conn.port}`;
    script = `set -e; psql ${flags} -d postgres -v ON_ERROR_STOP=1 -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${targetDb}' AND pid <> pg_backend_pid()" >/dev/null; ` +
      `psql ${flags} -d postgres -v ON_ERROR_STOP=1 -c 'DROP DATABASE IF EXISTS "${targetDb}"' -c 'CREATE DATABASE "${targetDb}"'; ` +
      `gunzip -c | psql ${flags} -q -v ON_ERROR_STOP=1 -d ${targetDb} >/dev/null`;
  }
  return { argv: ['exec', '-i', ...conn.envFlags, infra.containerName, 'sh', '-c', script], script, secrets: conn.secrets };
}

function dropDbArgv(spec: DbCloneSpec): string[] {
  const conn = connOf(spec);
  const c = spec.infra.containerName;
  if (spec.engine === 'mysql') {
    return ['exec', '-i', ...conn.envFlags, c, 'mysql', `-u${conn.user}`, '-h127.0.0.1', `-P${conn.port}`, '-e', `DROP DATABASE IF EXISTS \`${spec.targetDb}\``];
  }
  return ['exec', '-i', ...conn.envFlags, c, 'psql', '-U', conn.user, '-h', '127.0.0.1', '-p', String(conn.port), '-d', 'postgres', '-c', `DROP DATABASE IF EXISTS "${spec.targetDb}"`];
}

/**
 * 执行整库克隆（同实例内）。失败抛错（信息已脱敏，保留头尾双段）。
 * `cleanupOnFailure`（默认开）：失败时尽力 DROP 掉半成品目标库，不让下一次「目标库已存在」
 * 的判定把半份数据当成初始化完成；复制集通道自带更强的延迟重试清理，传 false 由它接管。
 */
export async function cloneRelationalDbInPlace(
  spec: DbCloneSpec,
  opts: { exec?: DbCloneExec; onOutput?: (line: string) => void; timeoutMs?: number; cleanupOnFailure?: boolean } = {},
): Promise<{ targetDb: string; clonedAt: string }> {
  const exec = opts.exec ?? runDockerExec;
  const { argv, secrets } = relationalCloneArgv(spec);
  opts.onOutput?.(`── 克隆 ${spec.sourceDb} → ${spec.targetDb}（${spec.engine} @ ${spec.infra.containerName}，独立限额辅助容器）──`);
  const result = await exec(argv, '', opts.timeoutMs ?? 600_000, 64 * 1024);
  if (result.code !== 0) {
    const raw = `${result.stderr || result.stdout}`.trim();
    const detail = maskSecretValues(raw.length > 900 ? `${raw.slice(0, 300)}\n…\n${raw.slice(-500)}` : raw, secrets);
    let residue = '';
    if (opts.cleanupOnFailure !== false) {
      const dropped = await exec(dropDbArgv(spec), '', 60_000, 8 * 1024).then((r) => r.code === 0).catch(() => false);
      residue = dropped ? '（半成品目标库已清理）' : `（警告：半成品目标库 ${spec.targetDb} 未能自动清理，请到数据库工作台手动 DROP）`;
    }
    throw new Error(`${detail || `exit ${result.code}`}${residue}`);
  }
  return { targetDb: spec.targetDb, clonedAt: new Date().toISOString() };
}

/** 解析客户端「表名<分隔符>行数」逐行输出（mysql -N -B 用制表符，psql -tA 用竖线） */
export function parseTableCounts(stdout: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of stdout.split('\n')) {
    const m = /^\s*([A-Za-z0-9_]+)\s*[\t|]\s*(\d+)\s*$/.exec(line);
    if (m) out[m[1]] = Number(m[2]);
  }
  return out;
}

export function compareTableCounts(source: Record<string, number>, target: Record<string, number>, now: Date): DbCloneVerification {
  const names = [...new Set([...Object.keys(source), ...Object.keys(target)])].sort();
  const tables: DbCloneVerification['tables'] = [];
  const mismatched: string[] = [];
  const sourceOnly: string[] = [];
  const targetOnly: string[] = [];
  for (const table of names) {
    const s = source[table];
    const t = target[table];
    if (s === undefined) { targetOnly.push(table); continue; }
    if (t === undefined) { sourceOnly.push(table); continue; }
    tables.push({ table, source: s, target: t });
    if (s !== t) mismatched.push(table);
  }
  return { ok: mismatched.length === 0 && sourceOnly.length === 0 && targetOnly.length === 0, measuredAt: now.toISOString(), tables, mismatched, sourceOnly, targetOnly };
}

function clientArgv(spec: DbCloneSpec, dbName: string, sql: string): { argv: string[]; secrets: string[] } {
  const conn = connOf(spec);
  const c = spec.infra.containerName;
  if (spec.engine === 'mysql') {
    return { argv: ['exec', '-i', ...conn.envFlags, c, 'mysql', `-u${conn.user}`, '-h127.0.0.1', `-P${conn.port}`, '-N', '-B', '-e', sql], secrets: conn.secrets };
  }
  return { argv: ['exec', '-i', ...conn.envFlags, c, 'psql', '-U', conn.user, '-h', '127.0.0.1', '-p', String(conn.port), '-d', dbName, '-tA', '-c', sql], secrets: conn.secrets };
}

async function tableCountsOf(spec: DbCloneSpec, dbName: string, exec: DbCloneExec): Promise<Record<string, number>> {
  const listSql = spec.engine === 'mysql'
    ? `SELECT table_name FROM information_schema.tables WHERE table_schema = '${dbName}' AND table_type = 'BASE TABLE' ORDER BY table_name`
    : `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`;
  const list = clientArgv(spec, dbName, listSql);
  const r = await exec(list.argv, '', 60_000, 256 * 1024);
  if (r.code !== 0) throw new Error(`列 ${dbName} 的表失败：${maskSecretValues((r.stderr || r.stdout).trim().slice(-300), list.secrets)}`);
  const tables = r.stdout.split('\n').map((s) => s.trim()).filter((s) => TABLE_NAME_SAFE.test(s));
  if (tables.length === 0) return {};
  const countSql = tables.map((t) => spec.engine === 'mysql'
    ? `SELECT '${t}', COUNT(*) FROM \`${dbName}\`.\`${t}\``
    : `SELECT '${t}', COUNT(*) FROM "${t}"`).join(' UNION ALL ');
  const count = clientArgv(spec, dbName, countSql);
  const c = await exec(count.argv, '', 600_000, 1024 * 1024);
  if (c.code !== 0) throw new Error(`数 ${dbName} 的行失败：${maskSecretValues((c.stderr || c.stdout).trim().slice(-300), count.secrets)}`);
  return parseTableCounts(c.stdout);
}

/** 某个库的逐表行数（回写预览、回写后校验共用） */
export async function relationalTableCounts(engine: DbEngine, infra: InfraService, dbName: string, exec: DbCloneExec = runDockerExec): Promise<Record<string, number>> {
  if (engine === 'mongo') throw new Error('mongo 不走关系型逐表行数');
  if (!DB_NAME_SAFE.test(dbName)) throw new Error(`库名不合法: ${dbName}`);
  return tableCountsOf({ engine, infra, sourceDb: dbName, targetDb: dbName, scope: { kind: 'per-branch', branchId: '', profileId: '' } }, dbName, exec);
}

/** 克隆后逐表行数校验：源库与目标库各数一遍，比对 */
export async function verifyCloneRowCounts(spec: DbCloneSpec, opts: { exec?: DbCloneExec; now?: () => Date } = {}): Promise<DbCloneVerification> {
  assertSpec(spec);
  const exec = opts.exec ?? runDockerExec;
  const source = await tableCountsOf(spec, spec.sourceDb, exec);
  const target = await tableCountsOf(spec, spec.targetDb, exec);
  return compareTableCounts(source, target, opts.now?.() ?? new Date());
}

/** 校验结果一句话（部署日志与台账共用） */
export function describeCloneVerification(v: DbCloneVerification): string {
  if (v.ok) return `${v.tables.length} 张表行数一致`;
  const parts: string[] = [];
  if (v.mismatched.length) parts.push(`${v.mismatched.length} 张表行数不一致（${v.mismatched.join(', ')}）`);
  if (v.sourceOnly.length) parts.push(`${v.sourceOnly.length} 张表只在源库（${v.sourceOnly.join(', ')}）`);
  if (v.targetOnly.length) parts.push(`${v.targetOnly.length} 张表只在目标库（${v.targetOnly.join(', ')}）`);
  return parts.join('；');
}
