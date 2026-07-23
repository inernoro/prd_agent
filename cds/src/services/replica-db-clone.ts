/**
 * 复制集一键隔离数据库（design.cds.replica-set MVP-2，2026-07-23）。
 *
 * 语义：dbMode=isolated 的成员启动前，把该服务当前使用的数据库**整库克隆**成
 * 隔离库 `<源库>_rs_<memberId>`，成员 env 指向隔离库后才启动——实验版本随便写，
 * 共享库零风险（隔离事故台账通道 4/8 的根治方向）。
 *
 * 保留语义：成员下线 / 复制集解散后隔离库**不删**，进入 branch.replicaDbSnapshots
 * 快照台账，UI 可见、手动删除才 drop。
 *
 * 三引擎适配（同实例内克隆，走 docker exec 在 infra 容器里执行）：
 *   - mongo    : mongodump --archive | mongorestore --nsFrom/--nsTo
 *   - mysql    : CREATE DATABASE + mysqldump | mysql
 *   - postgres : CREATE DATABASE + pg_dump | psql（不用 TEMPLATE——源库有活跃连接必失败）
 *
 * 凭据均通过 docker exec -e 环境变量传入（MYSQL_PWD / PGPASSWORD / RS_MONGO_PW），
 * 不落 shell 参数，脚本里只出现受白名单校验的库名（[a-z0-9_]），无注入面。
 */
import type { BranchEntry, BuildProfile, InfraService, ReplicaDbSnapshot } from '../types.js';
import type { StateService } from './state.js';
import { PER_BRANCH_DB_ENV_KEYS, applyPerBranchDbIsolation } from './db-scope-isolation.js';
import { detectInfraDataKind, runDockerExec, maskSecretValues } from '../routes/infra-data.js';

export type ReplicaDbEngine = 'mongo' | 'mysql' | 'postgres';

/** env key 家族 → 引擎（PER_BRANCH_DB_ENV_KEYS 的引擎归类） */
function engineForEnvKey(key: string): ReplicaDbEngine | null {
  if (key.includes('MONGO')) return 'mongo';
  if (key.includes('MYSQL') || key.includes('MARIADB')) return 'mysql';
  if (key.includes('POSTGRES')) return 'postgres';
  return null;
}

/** 库名白名单：只允许 [a-z0-9_]，防 shell/SQL 注入 + 三引擎通吃的安全字符集。 */
const DB_NAME_SAFE = /^[a-z0-9_]+$/i;

export interface ReplicaDbTarget {
  engine: ReplicaDbEngine;
  /** env 里实际存在、指向该库的全部 key（CDS_ 前缀与裸名可能并存，全部要覆写） */
  envKeys: string[];
  /** 克隆来源库名（已按 dbScope=per-branch 折算成运行时真实库名） */
  sourceDb: string;
  infra: InfraService;
}

/**
 * 解析某服务的数据库目标：库名 env key、运行时真实库名、承载它的 infra 容器。
 * 找不到（无 DB env / infra 未运行 / 引擎不支持）返回带原因的 null 结果。
 */
export function resolveReplicaDbTarget(
  state: StateService,
  branch: BranchEntry,
  profile: BuildProfile,
): { target: ReplicaDbTarget | null; reason?: string } {
  const merged: Record<string, string> = {
    ...state.getCustomEnv(branch.projectId),
    ...(profile.env || {}),
  };
  const runtimeEnv = applyPerBranchDbIsolation(merged, profile.dbScope, branch.branch);

  const presentKeys = PER_BRANCH_DB_ENV_KEYS.filter(
    (key) => typeof runtimeEnv[key] === 'string' && runtimeEnv[key] !== '',
  );
  if (presentKeys.length === 0) {
    return { target: null, reason: '该服务的环境变量里没有数据库名（MYSQL_DATABASE / POSTGRES_DB / MONGO_INITDB_DATABASE 家族），无法定位要隔离的库' };
  }

  // 取第一个能归类引擎的 key；同引擎的 CDS_ 前缀与裸名 key 一起覆写
  let engine: ReplicaDbEngine | null = null;
  let sourceDb = '';
  for (const key of presentKeys) {
    const kind = engineForEnvKey(key);
    if (!kind) continue;
    engine = kind;
    sourceDb = runtimeEnv[key];
    break;
  }
  if (!engine || !sourceDb) {
    return { target: null, reason: '数据库 env key 无法归类到 mongo/mysql/postgres 引擎' };
  }
  if (!DB_NAME_SAFE.test(sourceDb)) {
    return { target: null, reason: `源库名含不安全字符，拒绝克隆: ${sourceDb}` };
  }
  const envKeys = presentKeys.filter((key) => engineForEnvKey(key) === engine);

  const infraCandidates = state.getInfraServicesForProject(branch.projectId)
    .filter((svc) => svc.status === 'running' && detectInfraDataKindForEngine(svc, engine));
  if (infraCandidates.length === 0) {
    return { target: null, reason: `项目里没有运行中的 ${engine} 基础设施容器，无法执行克隆` };
  }
  // 优先 profile.dependsOn 显式声明的那个（多库项目防克隆到错的实例）
  const dependsOn = new Set(profile.dependsOn || []);
  const infra = infraCandidates.find((svc) => dependsOn.has(svc.id)) || infraCandidates[0];

  return { target: { engine, envKeys, sourceDb, infra } };
}

function detectInfraDataKindForEngine(svc: InfraService, engine: ReplicaDbEngine): boolean {
  const kind = detectInfraDataKind(svc.dockerImage);
  return kind === engine;
}

export interface CloneResult {
  /** 成员 env 覆写：全部库名 key → 隔离库名 */
  envOverride: Record<string, string>;
  snapshot: ReplicaDbSnapshot;
}

/**
 * 执行整库克隆（同实例内）。成功返回 env 覆写 + 快照记录；失败抛错（信息已脱敏）。
 * 克隆是停快照：克隆时间点之后主库的写入不会同步到隔离库。
 */
export async function cloneReplicaDb(opts: {
  target: ReplicaDbTarget;
  memberId: string;
  profileId: string;
  now?: () => Date;
  onOutput?: (line: string) => void;
}): Promise<CloneResult> {
  const { target, memberId, profileId } = opts;
  const dbName = `${target.sourceDb}_rs_${memberId}`.toLowerCase();
  if (!DB_NAME_SAFE.test(dbName)) throw new Error(`隔离库名不合法: ${dbName}`);
  if (dbName.length > 60) {
    throw new Error(`隔离库名超长（${dbName.length} > 60，mysql/postgres 标识符上限），源库名过长时暂不支持隔离`);
  }
  const c = target.infra.containerName;
  const env = target.infra.env || {};

  let argv: string[];
  let stdin = '';
  const secrets: string[] = [];

  if (target.engine === 'mysql') {
    const user = 'root';
    const pw = env.MYSQL_ROOT_PASSWORD || env.MARIADB_ROOT_PASSWORD || '';
    secrets.push(pw);
    argv = ['exec', '-i', '-e', `MYSQL_PWD=${pw}`, c, 'sh', '-c',
      `set -e; mysql -u${user} -e 'CREATE DATABASE IF NOT EXISTS \`${dbName}\`'; ` +
      `mysqldump -u${user} --single-transaction --routines --triggers ${target.sourceDb} | mysql -u${user} ${dbName}`];
  } else if (target.engine === 'postgres') {
    const user = env.POSTGRES_USER || 'postgres';
    const pw = env.POSTGRES_PASSWORD || '';
    secrets.push(pw);
    argv = ['exec', '-i', '-e', `PGPASSWORD=${pw}`, c, 'sh', '-c',
      `set -e; psql -U ${user} -d postgres -v ON_ERROR_STOP=1 -c 'CREATE DATABASE "${dbName}"' 2>/dev/null || true; ` +
      `pg_dump -U ${user} ${target.sourceDb} | psql -U ${user} -q -v ON_ERROR_STOP=1 -d ${dbName}`];
  } else {
    const user = env.MONGO_INITDB_ROOT_USERNAME || '';
    const pw = env.MONGO_INITDB_ROOT_PASSWORD || '';
    secrets.push(pw);
    const auth = user ? `-u "$RS_MONGO_USER" -p "$RS_MONGO_PW" --authenticationDatabase admin` : '';
    argv = ['exec', '-i',
      ...(user ? ['-e', `RS_MONGO_USER=${user}`, '-e', `RS_MONGO_PW=${pw}`] : []),
      c, 'sh', '-c',
      `set -e; command -v mongodump >/dev/null 2>&1 || { echo 'mongo 镜像缺少 mongodump（database tools），无法克隆'; exit 41; }; ` +
      `mongodump ${auth} --archive -d ${target.sourceDb} | mongorestore ${auth} --archive --nsFrom='${target.sourceDb}.*' --nsTo='${dbName}.*'`];
  }

  opts.onOutput?.(`── 一键隔离数据库: 克隆 ${target.sourceDb} → ${dbName}（${target.engine} @ ${c}）──`);
  const result = await runDockerExec(argv, stdin, 600_000, 64 * 1024);
  if (result.code !== 0) {
    const detail = maskSecretValues(`${result.stderr || result.stdout}`.trim().slice(-800), secrets);
    throw new Error(`数据库克隆失败（${target.engine}）: ${detail || `exit ${result.code}`}`);
  }
  opts.onOutput?.(`── 隔离库 ${dbName} 克隆完成 ──`);

  const envOverride: Record<string, string> = {};
  for (const key of target.envKeys) envOverride[key] = dbName;
  return {
    envOverride,
    snapshot: {
      id: `rsdb_${memberId}`,
      profileId,
      memberId,
      engine: target.engine,
      sourceDb: target.sourceDb,
      dbName,
      infraContainer: c,
      clonedAt: (opts.now?.() ?? new Date()).toISOString(),
    },
  };
}

/** 删除隔离库（快照台账的手动清理动作）。 */
export async function dropReplicaDb(snapshot: ReplicaDbSnapshot, infraEnv: Record<string, string>): Promise<void> {
  const dbName = snapshot.dbName;
  if (!DB_NAME_SAFE.test(dbName) || !dbName.includes('_rs_')) {
    throw new Error(`拒绝删除非隔离库命名的数据库: ${dbName}`);
  }
  const c = snapshot.infraContainer;
  let argv: string[];
  const secrets: string[] = [];
  if (snapshot.engine === 'mysql') {
    const pw = infraEnv.MYSQL_ROOT_PASSWORD || infraEnv.MARIADB_ROOT_PASSWORD || '';
    secrets.push(pw);
    argv = ['exec', '-i', '-e', `MYSQL_PWD=${pw}`, c, 'mysql', '-uroot', '-e', `DROP DATABASE IF EXISTS \`${dbName}\``];
  } else if (snapshot.engine === 'postgres') {
    const user = infraEnv.POSTGRES_USER || 'postgres';
    const pw = infraEnv.POSTGRES_PASSWORD || '';
    secrets.push(pw);
    argv = ['exec', '-i', '-e', `PGPASSWORD=${pw}`, c, 'psql', '-U', user, '-d', 'postgres', '-c', `DROP DATABASE IF EXISTS "${dbName}"`];
  } else {
    const user = infraEnv.MONGO_INITDB_ROOT_USERNAME || '';
    const pw = infraEnv.MONGO_INITDB_ROOT_PASSWORD || '';
    secrets.push(pw);
    const uri = user
      ? `mongodb://${user}:${pw}@localhost:27017/${dbName}?authSource=admin`
      : `mongodb://localhost:27017/${dbName}`;
    argv = ['exec', '-i', c, 'mongosh', uri, '--quiet', '--eval', 'db.dropDatabase()'];
  }
  const result = await runDockerExec(argv, '', 120_000, 16 * 1024);
  if (result.code !== 0) {
    throw new Error(`删除隔离库失败: ${maskSecretValues((result.stderr || result.stdout).trim().slice(-400), secrets)}`);
  }
}
