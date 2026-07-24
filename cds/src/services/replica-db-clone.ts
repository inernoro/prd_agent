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

/**
 * 补充家族：应用框架风格的库名 env key（如 .NET 双下划线 `MongoDB__DatabaseName`）。
 * 只用于复制集隔离时的库定位，**不进 PER_BRANCH_DB_ENV_KEYS**——那份白名单驱动
 * per-branch 库名改写，部分项目（如 prd-agent）刻意让框架 key 不随分支加后缀。
 * （验收 P1-1：此前只认白名单家族，prd-agent 的 MongoDB__DatabaseName 直接 409。）
 */
const FRAMEWORK_DB_ENV_PATTERNS: Array<{ engine: ReplicaDbEngine; re: RegExp }> = [
  { engine: 'mongo', re: /^(CDS_)?MONGO(DB)?_{1,2}DATABASE(_?NAME)?$/i },
  { engine: 'mysql', re: /^(CDS_)?(MYSQL|MARIADB)_{1,2}DATABASE(_?NAME)?$/i },
  { engine: 'postgres', re: /^(CDS_)?(POSTGRES(QL)?|PG)_{1,2}(DB|DATABASE)(_?NAME)?$/i },
];

/** 判定某个 env key 是否为库名 key，并归类引擎（白名单 + 框架风格两路）。 */
function classifyDbEnvKey(key: string): ReplicaDbEngine | null {
  if ((PER_BRANCH_DB_ENV_KEYS as readonly string[]).includes(key)) return engineForEnvKey(key);
  for (const { engine, re } of FRAMEWORK_DB_ENV_PATTERNS) {
    if (re.test(key)) return engine;
  }
  return null;
}

/** 框架风格 key（应用真正消费的配置）排在白名单 key 之前——两者值冲突时以应用视角为准。 */
function isFrameworkDbKey(key: string): boolean {
  return !(PER_BRANCH_DB_ENV_KEYS as readonly string[]).includes(key) && classifyDbEnvKey(key) !== null;
}

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

  const presentKeys = Object.keys(runtimeEnv)
    .filter((key) => classifyDbEnvKey(key) !== null && typeof runtimeEnv[key] === 'string' && runtimeEnv[key] !== '')
    // 框架风格 key 优先（应用真正读的配置）；同类内保持稳定序
    .sort((a, b) => Number(isFrameworkDbKey(b)) - Number(isFrameworkDbKey(a)));
  if (presentKeys.length === 0) {
    return { target: null, reason: '该服务的环境变量里没有数据库名（MYSQL_DATABASE / POSTGRES_DB / MONGO_INITDB_DATABASE / MongoDB__DatabaseName 等家族），无法定位要隔离的库' };
  }

  const firstKey = presentKeys[0];
  const engine = classifyDbEnvKey(firstKey);
  const sourceDb = runtimeEnv[firstKey];
  if (!engine || !sourceDb) {
    return { target: null, reason: '数据库 env key 无法归类到 mongo/mysql/postgres 引擎' };
  }
  if (!DB_NAME_SAFE.test(sourceDb)) {
    return { target: null, reason: `源库名含不安全字符，拒绝克隆: ${sourceDb}` };
  }
  // 只覆写「同引擎且指向同一个库」的 key——同引擎但值不同的 key（如 init 库 ≠ 应用库）
  // 不能一起改，否则会把无关库名静默改指到克隆库
  const envKeys = presentKeys.filter((key) => classifyDbEnvKey(key) === engine && runtimeEnv[key] === sourceDb);

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

/**
 * 隔离库名生成：`<源库>_rs_<成员id>`，成员 id 里 SQL 标识符不允许的字符（如
 * `guard-1` / `res-1` 的连字符）归一为下划线——生成名必须自证通过 DB_NAME_SAFE。
 * （复验 R2-P1-1：guard-N 直拼进库名被自家白名单拒绝，隔离 100% 失败于第 1 步。）
 */
export function isolatedDbNameFor(sourceDb: string, memberId: string): string {
  const safeMember = memberId.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  return `${sourceDb}_rs_${safeMember}`.toLowerCase();
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
  const dbName = isolatedDbNameFor(target.sourceDb, memberId);
  if (!DB_NAME_SAFE.test(dbName)) throw new Error(`隔离库名不合法: ${dbName}`);
  if (dbName.length > 60) {
    throw new Error(`隔离库名超长（${dbName.length} > 60，mysql/postgres 标识符上限），源库名过长时暂不支持隔离`);
  }
  const c = target.infra.containerName;
  const env = target.infra.env || {};
  const image = target.infra.dockerImage;
  const port = target.infra.containerPort
    || (target.engine === 'mysql' ? 3306 : target.engine === 'postgres' ? 5432 : 27017);

  /**
   * 复验 R3-P0：克隆此前经 docker exec 在数据库容器 **同 cgroup** 内跑 dump+restore，
   * 内存压力可把生产 mongod OOM 打崩（实测共享主库 unclean shutdown）。改为独立
   * 辅助容器：`docker run --rm` 同镜像（自带 client 工具），共享 DB 容器网络命名空间
   * （127.0.0.1:<port> 直连），并施加内存/CPU 硬上限——压力大时被杀的是辅助容器，
   * 不是数据库本体。dump/restore 再加单并发限流，进一步压低对主库的冲击。
   */
  const helper = (extraEnv: string[], script: string): string[] => [
    'run', '--rm', '-i', '--pull', 'never',
    '--network', `container:${c}`,
    '--memory', '768m', '--memory-swap', '768m', '--cpus', '1',
    '--entrypoint', 'sh',
    ...extraEnv,
    image,
    '-c', script,
  ];

  let argv: string[];
  let stdin = '';
  const secrets: string[] = [];

  if (target.engine === 'mysql') {
    const user = 'root';
    const pw = env.MYSQL_ROOT_PASSWORD || env.MARIADB_ROOT_PASSWORD || '';
    secrets.push(pw);
    const conn = `-h127.0.0.1 -P${port} -u${user}`;
    argv = helper(['-e', `MYSQL_PWD=${pw}`],
      `set -e; mysql ${conn} -e 'CREATE DATABASE IF NOT EXISTS \`${dbName}\`'; ` +
      `mysqldump ${conn} --single-transaction --routines --triggers ${target.sourceDb} | mysql ${conn} ${dbName}`);
  } else if (target.engine === 'postgres') {
    const user = env.POSTGRES_USER || 'postgres';
    const pw = env.POSTGRES_PASSWORD || '';
    secrets.push(pw);
    const conn = `-h 127.0.0.1 -p ${port} -U ${user}`;
    argv = helper(['-e', `PGPASSWORD=${pw}`],
      `set -e; psql ${conn} -d postgres -v ON_ERROR_STOP=1 -c 'CREATE DATABASE "${dbName}"' 2>/dev/null || true; ` +
      `pg_dump ${conn} ${target.sourceDb} | psql ${conn} -q -v ON_ERROR_STOP=1 -d ${dbName}`);
  } else {
    const user = env.MONGO_INITDB_ROOT_USERNAME || '';
    const pw = env.MONGO_INITDB_ROOT_PASSWORD || '';
    secrets.push(pw);
    const conn = `--host 127.0.0.1 --port ${port}`;
    const auth = user ? `-u "$RS_MONGO_USER" -p "$RS_MONGO_PW" --authenticationDatabase admin` : '';
    argv = helper(user ? ['-e', `RS_MONGO_USER=${user}`, '-e', `RS_MONGO_PW=${pw}`] : [],
      `set -e; command -v mongodump >/dev/null 2>&1 || { echo 'mongo 镜像缺少 mongodump（database tools），无法克隆'; exit 41; }; ` +
      `mongodump ${conn} ${auth} --archive -d ${target.sourceDb} --numParallelCollections=1 | ` +
      `mongorestore ${conn} ${auth} --archive --nsFrom='${target.sourceDb}.*' --nsTo='${dbName}.*' --numParallelCollections=1 --numInsertionWorkersPerCollection=1`);
  }

  opts.onOutput?.(`── 一键隔离数据库: 克隆 ${target.sourceDb} → ${dbName}（${target.engine} @ ${c}，独立限额辅助容器）──`);
  const result = await runDockerExec(argv, stdin, 600_000, 64 * 1024);
  if (result.code !== 0) {
    // 失败原因保留头尾双段（复验 R3-P2：进度日志刷满缓冲把真正的致命错误挤掉）
    const raw = `${result.stderr || result.stdout}`.trim();
    const detail = maskSecretValues(raw.length > 900 ? `${raw.slice(0, 300)}\n…\n${raw.slice(-500)}` : raw, secrets);
    // 失败残留清理（复验 R3-P1：半成品克隆库脱管，台账不可见、官方删除通道触达不了）
    let residue = '';
    try {
      await dropReplicaDb({
        id: `rsdb_${memberId}`, profileId, memberId,
        engine: target.engine, sourceDb: target.sourceDb, dbName, infraContainer: c,
        clonedAt: (opts.now?.() ?? new Date()).toISOString(),
      }, env);
      residue = '（半成品克隆库已自动清理）';
    } catch {
      residue = `（警告：半成品克隆库 ${dbName} 未能自动清理，请到数据库工作台手动 DROP）`;
    }
    throw new Error(`数据库克隆失败（${target.engine}）: ${detail || `exit ${result.code}`}${residue}`);
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
