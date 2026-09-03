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
import { createHash } from 'node:crypto';
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

/**
 * 引擎中立的库名 key（2026-07-28 真机验收补）。
 *
 * Spring / 通用配置风格把库名写成 `DB_NAME` / `DATABASE_NAME` —— 名字里**不含引擎**。
 * 上面那三条模式全靠 key 名带 MYSQL / POSTGRES / MONGO 才能归类，于是这类项目在
 * 隔离入口就被判「环境变量里没有数据库名」，功能整个不可用。生产 CDS 上的标识中台
 * (IMP) 正是如此：DB_NAME + SPRING_DATASOURCE_URL / *_DATASOURCE_URL / *_DB_URL，
 * 六个服务全部 dbIsolatable.ok=false —— JDBC 改写修好了也永远走不到。
 *
 * 这类 key 的引擎不能猜，只能从同一份 env 里的**关系型连接 URL scheme** 读出来
 *（`jdbc:mysql://…` 就是 mysql，明写在那里）。读不出唯一引擎时保持原样拒绝，
 * 绝不臆断——克隆错引擎的库比不能隔离危险得多。
 */
const ENGINE_NEUTRAL_DB_ENV_PATTERN = /^(CDS_)?(DB|DATABASE)_{1,2}(NAME)$/i;

/**
 * 关系型连接 URL 的 scheme —— **识别与改写共用这一条**（Codex PR #1275 二轮 P1）。
 *
 * 曾经是两条各写各的：引擎探测认 `(jdbc:)?(mysql|mariadb|postgres(ql)?)`，而下游
 * 决定「哪些 URL 要跟着改库名」的那条只列了 `mysql|mariadb|postgres|postgresql|
 * jdbc:mysql|jdbc:postgresql`，漏掉 `jdbc:mariadb` 与 `jdbc:postgres`。后果是最坏的
 * 那种：用 `DB_NAME` + `SPRING_DATASOURCE_URL=jdbc:mariadb://…` 的 Java 服务被判为
 * 可隔离（探测认得），克隆照跑、库名 key 照改，但那条 JDBC URL 进不了改写集合——
 * 应用读的正是它，于是副本流量继续打在源库上，控制面还报「隔离成功」。这正是
 * 已经修过两轮的「隔离是假的」原样复活。合成一条 SSOT，从根上不给漂移留缝。
 */
const RELATIONAL_URL_SCHEME = /^(jdbc:)?(mysql|mariadb|postgres(ql)?):\/\//i;

/**
 * 这个值是不是关系型连接 URL —— 「能否据此判引擎」与「要不要跟着改库名」必须是
 * 同一个答案，所以两处都调这个函数，不各自 test 各自的正则。
 */
export function isRelationalUrl(value: unknown): boolean {
  return typeof value === 'string' && RELATIONAL_URL_SCHEME.test(value.trim());
}

/** 一份 env 里出现过的全部关系型引擎（去重）。 */
export function relationalEnginesFromUrls(env: Record<string, string>): ReplicaDbEngine[] {
  const found = new Set<ReplicaDbEngine>();
  for (const value of Object.values(env)) {
    if (typeof value !== 'string') continue;
    const m = RELATIONAL_URL_SCHEME.exec(value.trim());
    if (!m) continue;
    const scheme = m[2].toLowerCase();
    found.add(scheme.startsWith('postgres') ? 'postgres' : 'mysql');
  }
  return [...found];
}

/** 从一份 env 的关系型连接 URL 里读出唯一引擎；零个或多于一个都返回 null。 */
export function engineFromRelationalUrls(env: Record<string, string>): ReplicaDbEngine | null {
  const found = relationalEnginesFromUrls(env);
  return found.length === 1 ? found[0] : null;
}

/**
 * 关系型连接 URL 的主机名（小写，去端口去凭据）。解析不出返回 null。
 * 复合 scheme（`jdbc:mysql://`）与带凭据的 authority（`user:pw@host:3306`）都要认。
 */
export function relationalUrlHost(url: string): string | null {
  const m = /^[a-zA-Z][a-zA-Z0-9+.:-]*:\/\/([^/?#]*)/.exec((url || '').trim());
  if (!m) return null;
  let authority = m[1];
  const at = authority.lastIndexOf('@');
  if (at >= 0) authority = authority.slice(at + 1);
  // IPv6 字面量 `[::1]:3306`
  const v6 = /^\[([^\]]+)\]/.exec(authority);
  const host = (v6 ? v6[1] : authority.replace(/:\d+$/, '')).toLowerCase();
  return host || null;
}

/**
 * 某个 infra 实例在容器网络里可能被写成的主机名集合。
 *
 * 与 `computeProfileAliases`（container.ts）同源语义：服务 id 本身、容器名，
 * 以及去掉尾部项目标识后的短别名（`mysql-mdimp` → `mysql`）。这里刻意做得
 * 宽松一点——判错方向只会让一条本该改写的 URL 落进 unboundUrlKeys（如实报出、
 * 不改），比错改一条指向别的服务器的连接串安全得多。
 */
export function infraHostAliases(infra: InfraService): Set<string> {
  const out = new Set<string>();
  const id = (infra.id || '').toLowerCase();
  if (id) out.add(id);
  if (infra.containerName) out.add(infra.containerName.toLowerCase());
  const dash = id.lastIndexOf('-');
  if (dash > 0) out.add(id.slice(0, dash));
  return out;
}

/** infra 服务镜像 → 引擎（三种受支持的数据库之一，否则 null）。 */
function engineOfInfra(svc: InfraService): ReplicaDbEngine | null {
  const kind = detectInfraDataKind(svc.dockerImage);
  return kind === 'mongo' || kind === 'mysql' || kind === 'postgres' ? kind : null;
}

/**
 * 引擎中立库名 key（DB_NAME）的引擎判定，多引擎项目下用 profile 自己的 dependsOn 收敛
 *（Codex PR #1275 八轮 P2）。
 *
 * 只按「全 env 的 URL 是否唯一」判定是不够的：项目级 customEnv 会把**所有**引擎的连接串
 * 灌给每个服务，多引擎项目里 URL 集合恒为 {mysql, postgres} → 判不出唯一引擎 → DB_NAME
 * 被当成不可归类的 key 过滤掉 → presentKeys 空 → 直接返回「没有数据库名」。而下方那套
 * dependsOn 消歧只在 enginesPresent.length > 1 时才跑，此刻 presentKeys 已经空了，永远轮不到。
 * 结果就是：本轮刚刚宣传的「支持 DB_NAME」在多引擎项目上依然不可用。
 *
 * 收敛用**交集**而非直接采信 dependsOn：引擎必须同时满足「profile 明确声明依赖它」与
 * 「env 里确实有它的连接串」。只满足一边说明配置本身有歧义，宁可继续 fail-closed。
 */
function resolveNeutralEngine(
  state: StateService,
  branch: BranchEntry,
  profile: BuildProfile,
  runtimeEnv: Record<string, string>,
): ReplicaDbEngine | null {
  const unique = engineFromRelationalUrls(runtimeEnv);
  if (unique) return unique;
  const candidates = relationalEnginesFromUrls(runtimeEnv);
  if (candidates.length < 2) return null; // 一个都没有 → 无从判定，照旧 fail-closed
  const declared = new Set(profile.dependsOn || []);
  if (declared.size === 0) return null;
  const byDepends = [...new Set(
    state.getInfraServicesForProject(branch.projectId)
      .filter((svc) => svc.status === 'running' && declared.has(svc.id))
      .map(engineOfInfra)
      .filter((e): e is ReplicaDbEngine => e !== null && candidates.includes(e)),
  )];
  return byDepends.length === 1 ? byDepends[0] : null;
}

/**
 * 判定某个 env key 是否为库名 key，并归类引擎（白名单 → 框架风格 → 引擎中立三路）。
 * 引擎中立那一路必须由调用方提供 env 上下文，否则无从判断引擎，直接不认。
 */
function classifyDbEnvKey(key: string, neutralEngine?: ReplicaDbEngine | null): ReplicaDbEngine | null {
  if ((PER_BRANCH_DB_ENV_KEYS as readonly string[]).includes(key)) return engineForEnvKey(key);
  for (const { engine, re } of FRAMEWORK_DB_ENV_PATTERNS) {
    if (re.test(key)) return engine;
  }
  if (neutralEngine && ENGINE_NEUTRAL_DB_ENV_PATTERN.test(key)) return neutralEngine;
  return null;
}

/** 框架风格 key（应用真正消费的配置）排在白名单 key 之前——两者值冲突时以应用视角为准。 */
function isFrameworkDbKey(key: string, neutralEngine?: ReplicaDbEngine | null): boolean {
  return !(PER_BRANCH_DB_ENV_KEYS as readonly string[]).includes(key)
    && classifyDbEnvKey(key, neutralEngine) !== null;
}

/**
 * 库名 key 的**来源层级**（数字越小越优先，Codex PR #1275 九轮 P1）。
 *
 * 0 = profile.env（服务自己声明的）
 * 1 = 分支 scope customEnv
 * 2 = 项目 customEnv（灌给全部服务的默认值）
 *
 * 为什么来源比 key 的引擎专属度更权威：四轮修的是「项目级泛化 DB_NAME 压过 profile
 * 自己的 MYSQL_DATABASE」，当时的解法是一律把中立 key 降档——**这在反方向上是错的**。
 * 项目级 env 里放一个 `MYSQL_DATABASE=infra_default`（infra 预设常见），而服务自己
 * 用 `DB_NAME=app` + `SPRING_DATASOURCE_URL=.../app` 时，按专属度排会选中
 * `infra_default`：克隆的是 infra 默认库，应用的 DB_NAME 与 JDBC URL 仍指向 app，
 * 而控制面照报隔离成功——与四轮那条是同一种事故的镜像。
 *
 * 谁更贴近这个服务，谁说了算：profile > 分支 > 项目；同层内才比引擎专属度。
 */
function dbEnvKeyProvenance(key: string, provenance: ReadonlyMap<string, number>): number {
  return provenance.get(key) ?? 2;
}

/**
 * 库名 key 的取用优先级（数字越小越优先，Codex PR #1275 四轮 P1）。
 * 注意：这是**同来源层级内**的次级判据，主判据是上面的来源层级。
 *
 * 引擎中立 key（DB_NAME / DATABASE_NAME）**只在没有任何自带引擎的 key 时才算数**。
 * 它靠同 env 的连接串反推引擎，本身不携带归属信息，而项目级 customEnv 会把一个
 * 泛化的 DB_NAME 灌给全部服务 —— 若它和 profile 自己的 MYSQL_DATABASE 并列，
 * 仅靠「框架 key 优先」分不出高下，排序退化成 merged env 的插入顺序，项目级那个
 * 先进来就赢。后果：sourceDb 取到与本服务无关的库名 → 克隆错库；应用连接串的
 * 路径段对不上这个值 → urlEnvValues 漏掉它 → 副本仍打源库，控制面还报隔离成功。
 *
 * 0 = 自带引擎的框架风格 key（MYSQL_DATABASE / POSTGRES_DB / MongoDB__DatabaseName…）
 * 1 = CDS 自己的 per-branch 白名单 key（同样自带引擎，但不是应用直接读的那个）
 * 2 = 引擎中立 key（兜底，仅当前两类都不存在）
 */
function dbEnvKeyRank(key: string, neutralEngine?: ReplicaDbEngine | null): number {
  // 不传 neutralEngine 时 classify 只认自带引擎的两类 —— 据此把中立 key 分出来。
  if (classifyDbEnvKey(key) === null) return 2;
  return isFrameworkDbKey(key, neutralEngine) ? 0 : 1;
}

export interface ReplicaDbTarget {
  engine: ReplicaDbEngine;
  /** env 里实际存在、指向该库的全部 key（CDS_ 前缀与裸名可能并存，全部要覆写） */
  envKeys: string[];
  /** 连接串 env key（mongo 专用隔离实例通道需要把副本改指新实例） */
  connEnvKeys: string[];
  /** 关系型连接 URL 的 env key → 原值（库名段等于源库的那些，隔离时按新库名重写）。 */
  urlEnvValues?: Record<string, string>;
  /**
   * 库名段虽等于源库、但主机**不是**选定 infra 的连接串 key（Codex 十一轮 P1）。
   * 这些不改写——克隆只发生在选定实例上，改了会把副本指向另一台服务器上的
   * 同名隔离库（那里根本没有，或更糟：那里恰好有别的数据）。如实报出供 UI 展示，
   * 让「哪些连接没被隔离」可见，而不是静默。
   */
  unboundUrlKeys?: string[];
  /** 克隆来源库名（已按 dbScope=per-branch 折算成运行时真实库名） */
  sourceDb: string;
  infra: InfraService;
}

/** Mongo 连接串 env key 家族（.NET 双下划线 / 通用 URI 风格） */
const MONGO_CONN_ENV_PATTERN = /^(CDS_)?MONGO(DB)?_{1,2}(CONNECTION_?STRING|URI|URL)$/i;

/**
 * 解析某服务的数据库目标：库名 env key、运行时真实库名、承载它的 infra 容器。
 * 找不到（无 DB env / infra 未运行 / 引擎不支持）返回带原因的 null 结果。
 */
/**
 * 关系型连接 URL 里把库名段换成隔离库（Codex 第三十二轮 P1）。
 *
 * CDS 的 mysql/postgres 预设注入的是 `DATABASE_URL / MYSQL_URL / POSTGRES_URL`，
 * 形如 `mysql://app:pw@mysql:3306/<db>`——**库名是 URL 路径里的字面量**，而应用
 * 真正读的就是这个 URL。此前隔离只改 `MYSQL_DATABASE` / `POSTGRES_DB`（那是
 * 服务端初始化变量，不是应用的连接配置），于是副本照旧写主库，控制面与隔离审计
 * 却双双报告「已隔离」——隔离在关系型上一直是假的。
 *
 * 只改路径段：主机/端口/凭据/查询参数原样保留（关系型隔离走同实例建新库，
 * 不像 mongo 那样另起专用实例）。无法解析或路径段对不上源库时返回 null，
 * 由调用方按「不认识就不动」处理，绝不瞎改用户的连接串。
 *
 * scheme 允许内嵌冒号（2026-07-27 真机核对补）：Java/Spring 项目的连接串是
 * `jdbc:mysql://host:3306/db?useSSL=false` 这种**复合 scheme**。下面的
 * RELATIONAL_URL_SCHEME 一直把 `jdbc:mysql` / `jdbc:postgresql` 列为已识别，
 * 但此处的 scheme 段原本写成 `[a-zA-Z][a-zA-Z0-9+.-]*`（不含冒号），JDBC URL
 * 一律解析失败 → 收集阶段的探测也失败 → 这些 key 根本进不了 urlEnvValues →
 * **静默不改写**。于是第三十二轮修好的「关系型隔离是假的」在 Java 项目上原样
 * 复活：控制面报告已隔离，Spring 应用照旧写主库。核对生产 CDS 上的标识中台
 * (IMP) 项目环境变量时发现——它的库连接全部走 SPRING_DATASOURCE_URL /
 * *_DATASOURCE_URL / *_DB_URL 这类 JDBC 形态。
 */
export function rewriteRelationalUrlDb(url: string, sourceDb: string, isolatedDb: string): string | null {
  const m = /^([a-zA-Z][a-zA-Z0-9+.:-]*:\/\/[^/?#]*)\/([^/?#]*)([?#].*)?$/.exec(url);
  if (!m) return null;
  const [, prefix, dbSegment, tail] = m;
  if (dbSegment !== sourceDb) return null;
  return `${prefix}/${isolatedDb}${tail || ''}`;
}

// 「值看起来像关系型连接 URL」的判定与引擎探测共用上面那条 RELATIONAL_URL_SCHEME，
// 不再各写一份（两份漂移过一次，见该常量的注释）。

/**
 * 隔离时的 env 覆写公共部分：库名 key + 关系型连接 URL 的库名段重写。
 * （Codex 第三十二轮 P1：只改库名 key 对关系型无效，应用读的是 URL。）
 */
function baseIsolationEnvOverride(target: ReplicaDbTarget, dbName: string): Record<string, string> {
  const envOverride: Record<string, string> = {};
  for (const key of target.envKeys) envOverride[key] = dbName;
  for (const [key, url] of Object.entries(target.urlEnvValues || {})) {
    const rewritten = rewriteRelationalUrlDb(url, target.sourceDb, dbName);
    if (rewritten) envOverride[key] = rewritten;
  }
  return envOverride;
}

export function resolveReplicaDbTarget(
  state: StateService,
  branch: BranchEntry,
  profile: BuildProfile,
  opts: {
    /**
     * 基础设施实例的筛选口径。克隆默认只认台账 running（不往停掉的实例里写）；
     * 库探测（db-probe）传 'any'：台账状态不是真相，容器是否真在跑由 docker 实测说了算，
     * 探测只读、失败无害，不该被台账里一个过期的 error 挡在门外。
     */
    infraStatus?: 'running' | 'any';
  } = {},
): { target: ReplicaDbTarget | null; reason?: string } {
  const infraOk = (svc: InfraService): boolean => opts.infraStatus === 'any' || svc.status === 'running';
  // 与部署路径 getMergedEnv（branches.ts）同优先级：project customEnv → 分支 scope
  // → profile.env。分支级 env 覆写过库名/连接串时（Codex P1），不合入会把隔离目标
  // 解析到项目级默认库——克隆的不是该分支实际在用的库，或漏掉分支级连接串 key。
  const projectEnv = state.getCustomEnv(branch.projectId) || {};
  const scopeEnv = state.getCustomEnvScope(branch.id) || {};
  const profileEnv = profile.env || {};
  const merged: Record<string, string> = { ...projectEnv, ...scopeEnv, ...profileEnv };
  // 记下每个 key 的来源层级，供库名 key 排序用（见 dbEnvKeyProvenance）
  const envProvenance = new Map<string, number>();
  for (const key of Object.keys(projectEnv)) envProvenance.set(key, 2);
  for (const key of Object.keys(scopeEnv)) envProvenance.set(key, 1);
  for (const key of Object.keys(profileEnv)) envProvenance.set(key, 0);
  const runtimeEnv = applyPerBranchDbIsolation(merged, profile.dbScope, branch.branch);

  // 引擎中立 key（DB_NAME / DATABASE_NAME）的引擎从同 env 的关系型 URL scheme 读，
  // 读不出唯一引擎就当它不是库名 key（fail-closed，见 ENGINE_NEUTRAL_DB_ENV_PATTERN）。
  const neutralEngine = resolveNeutralEngine(state, branch, profile, runtimeEnv);
  const presentKeys = Object.keys(runtimeEnv)
    .filter((key) => classifyDbEnvKey(key, neutralEngine) !== null
      && typeof runtimeEnv[key] === 'string' && runtimeEnv[key] !== '')
    // 先按来源层级（profile > 分支 > 项目，见 dbEnvKeyProvenance），同层再按引擎
    // 专属度（见 dbEnvKeyRank）；两级都相同时保持稳定序
    .sort((a, b) => {
      const byProvenance = dbEnvKeyProvenance(a, envProvenance) - dbEnvKeyProvenance(b, envProvenance);
      if (byProvenance !== 0) return byProvenance;
      return dbEnvKeyRank(a, neutralEngine) - dbEnvKeyRank(b, neutralEngine);
    });
  if (presentKeys.length === 0) {
    // 可诊断的失败原因（2026-07-28 真机验收补）：只说「没有数据库名」等于把人挡在
    // 门外还不告诉他差什么——生产上标识中台六个服务全是这条，光看文案根本判断不出
    // 是「真没配」还是「配了但 CDS 不认」。这里把**看到了什么**如实报出来：
    // 疑似库名 key（只报 key 名，不报值，值可能含凭据）、以及引擎能否从连接 URL 推出。
    // 用户据此一眼知道该补 URL 还是该改 key 名；排障也不必再去猜。
    const suspects = Object.keys(runtimeEnv).filter(
      (k) => /(^|_)(DB|DATABASE)(_|$)/i.test(k) || /DATASOURCE|JDBC/i.test(k),
    );
    const detail = suspects.length > 0
      ? `。检测到疑似数据库相关变量：${suspects.slice(0, 12).join(', ')}`
        + (neutralEngine
          ? `；已从连接串推断引擎=${neutralEngine}，但其中没有能识别的库名 key（引擎中立库名 key 仅认 DB_NAME / DATABASE_NAME）`
          : '；且**未能从任何连接串推断出引擎**（需要形如 mysql:// 或 jdbc:mysql:// 的 URL），因此 DB_NAME 这类不含引擎的 key 无法归类')
      : '';
    return {
      target: null,
      reason: '该服务的环境变量里没有数据库名（MYSQL_DATABASE / POSTGRES_DB / MONGO_INITDB_DATABASE / MongoDB__DatabaseName 等家族），无法定位要隔离的库'
        + detail,
    };
  }

  // 引擎判定（Codex P1）：项目级 customEnv 会把**所有**引擎的库名 key 都灌进来
  //（多引擎项目里连 postgres 的服务也能看到 MONGO_INITDB_DATABASE），此前按
  // 首个 key 定引擎是插入顺序依赖的——选错引擎后面的实例定位都被框死在错引擎里，
  // 隔离克隆出来的就是别的引擎的生产数据。多引擎并存时按 dependsOn 声明或
  // CDS_<实例>_PORT/HOST 模板引用收敛；仍多义 → fail-closed。
  const enginesPresent = [...new Set(
    presentKeys.map((k) => classifyDbEnvKey(k, neutralEngine)).filter((e): e is ReplicaDbEngine => e !== null),
  )];
  let engine: ReplicaDbEngine | null = enginesPresent[0] ?? null;
  if (enginesPresent.length > 1) {
    const running = state.getInfraServicesForProject(branch.projectId).filter(infraOk);
    const engineOf = engineOfInfra;
    const declared = new Set(profile.dependsOn || []);
    const byDepends = [...new Set(
      running.filter((s) => declared.has(s.id)).map(engineOf)
        .filter((e): e is ReplicaDbEngine => e !== null && enginesPresent.includes(e)),
    )];
    if (byDepends.length === 1) {
      engine = byDepends[0];
    } else {
      const tokenOf = (id: string): string => `CDS_${id.toUpperCase().replace(/-/g, '_')}_`;
      const rawValues = Object.values(merged).join('\n');
      const byRef = [...new Set(
        running.filter((s) => rawValues.includes(tokenOf(s.id))).map(engineOf)
          .filter((e): e is ReplicaDbEngine => e !== null && enginesPresent.includes(e)),
      )];
      if (byRef.length === 1) {
        engine = byRef[0];
      } else {
        return {
          target: null,
          reason: `该服务的环境变量同时出现 ${enginesPresent.join(' / ')} 多个引擎的库名 key，且无法从 dependsOn 或 CDS_<实例>_PORT/HOST 模板确定它真正连接的引擎——为防克隆错引擎的数据，已拒绝（fail-closed）。请在服务 profile 的 dependsOn 里声明数据库实例`,
        };
      }
    }
  }
  const firstKey = presentKeys.find((k) => classifyDbEnvKey(k, neutralEngine) === engine);
  const sourceDb = firstKey ? runtimeEnv[firstKey] : undefined;
  if (!engine || !sourceDb) {
    return { target: null, reason: '数据库 env key 无法归类到 mongo/mysql/postgres 引擎' };
  }
  if (!DB_NAME_SAFE.test(sourceDb)) {
    return { target: null, reason: `源库名含不安全字符，拒绝克隆: ${sourceDb}` };
  }
  // 只覆写「同引擎且指向同一个库」的 key——同引擎但值不同的 key（如 init 库 ≠ 应用库）
  // 不能一起改，否则会把无关库名静默改指到克隆库
  const envKeys = presentKeys.filter((key) => classifyDbEnvKey(key, neutralEngine) === engine && runtimeEnv[key] === sourceDb);

  const infraCandidates = state.getInfraServicesForProject(branch.projectId)
    .filter((svc) => infraOk(svc) && detectInfraDataKindForEngine(svc, engine));
  if (infraCandidates.length === 0) {
    return {
      target: null,
      reason: opts.infraStatus === 'any'
        ? `项目里没有 ${engine} 基础设施实例，无法定位这个库在哪`
        : `项目里没有运行中的 ${engine} 基础设施容器，无法执行克隆`,
    };
  }
  // 实例定位（Codex P1）：优先 profile.dependsOn 显式声明；多实例同引擎且未声明时
  // 不再盲选第一个——按 env 原始值里的 CDS_<实例ID>_PORT/HOST 模板 token 关联
  //（与 service-graph 同源的连接证据）；仍无法唯一定位 → fail-closed 拒绝，
  // 防止把「另一个实例上的同名库」克隆出来当实验数据。
  const dependsOn = new Set(profile.dependsOn || []);
  let infra = infraCandidates.find((svc) => dependsOn.has(svc.id));
  if (!infra) {
    if (infraCandidates.length === 1) {
      infra = infraCandidates[0];
    } else {
      const tokenFor = (id: string): string => `CDS_${id.toUpperCase().replace(/-/g, '_')}_`;
      const allEnvValues = Object.values(merged).join('\n');
      const referenced = infraCandidates.filter((svc) => allEnvValues.includes(tokenFor(svc.id)));
      if (referenced.length === 1) {
        infra = referenced[0];
      } else {
        return {
          target: null,
          reason: `项目里有 ${infraCandidates.length} 个运行中的 ${engine} 实例（${infraCandidates.map((s) => s.id).join(' / ')}），且该服务未通过 dependsOn 或 CDS_<实例>_PORT/HOST 模板指明连接哪一个——为防克隆到错误实例的同名库，已拒绝（fail-closed）。请在服务 profile 的 dependsOn 里声明目标实例`,
        };
      }
    }
  }

  const connEnvKeys = engine === 'mongo'
    ? Object.keys(runtimeEnv).filter((key) => MONGO_CONN_ENV_PATTERN.test(key))
    : [];

  // 关系型连接 URL（Codex 第三十二轮 P1）：库名写死在 URL 路径里，必须一并覆写，
  // 否则改了 MYSQL_DATABASE 也没用——应用读的是 URL。只收「路径段确实等于源库」
  // 的那些，避免把指向别的库/别的实例的连接串误改。
  //
  // 但「路径段相等」还不够（Codex PR #1275 十一轮 P1）：同一个 profile 可能有两条
  // 库名相同、**主机不同**的 JDBC URL（如主库与只读从库、或另一套环境的同名库）。
  // 克隆只发生在 target.infra 上，若把另一台主机的那条也改成隔离库名，副本会连到
  // 一台**根本没有这个库**的服务器（或更糟：那台上恰好有同名库，于是写进不该写的
  // 数据），而控制面照报「隔离可用」。
  //
  // 绑定规则刻意分两档，避免为了治歧义反而误伤单主机的常规配置：
  //  - 候选 URL 只有一个主机 → 无歧义，全收（保持既有行为，包括 IP / 外部主机 /
  //    我们推不出来的别名形态，IMP 那种 `jdbc:mysql://mysql:3306/impdb` 即此档）；
  //  - 出现两个及以上主机 → 只收主机名指向**选定 infra** 的那些，其余进
  //    unboundUrlKeys 如实报出（不改也不静默 —— 隔离范围要可见）。
  const urlEnvValues: Record<string, string> = {};
  const unboundUrlKeys: string[] = [];
  if (engine !== 'mongo') {
    const candidates: Array<[string, string]> = [];
    for (const [key, value] of Object.entries(runtimeEnv)) {
      if (!isRelationalUrl(value)) continue;
      if (rewriteRelationalUrlDb(value, sourceDb, 'probe') !== null) candidates.push([key, value]);
    }
    const hosts = new Set(candidates.map(([, value]) => relationalUrlHost(value) || ''));
    if (hosts.size <= 1) {
      for (const [key, value] of candidates) urlEnvValues[key] = value;
    } else {
      const aliases = infraHostAliases(infra);
      for (const [key, value] of candidates) {
        const host = relationalUrlHost(value) || '';
        if (aliases.has(host)) urlEnvValues[key] = value;
        else unboundUrlKeys.push(key);
      }
    }
  }

  return {
    target: {
      engine,
      envKeys,
      connEnvKeys,
      urlEnvValues,
      ...(unboundUrlKeys.length > 0 ? { unboundUrlKeys } : {}),
      sourceDb,
      infra,
    },
  };
}

function detectInfraDataKindForEngine(svc: InfraService, engine: ReplicaDbEngine): boolean {
  const kind = detectInfraDataKind(svc.dockerImage);
  return kind === engine;
}

/**
 * 隔离库名生成：`<源库>_rs_<哈希6位>_<成员id>`，成员 id 里 SQL 标识符不允许的
 * 字符（如 `guard-1` / `res-1` 的连字符）归一为下划线——生成名必须自证通过 DB_NAME_SAFE。
 * （复验 R2-P1-1：guard-N 直拼进库名被自家白名单拒绝，隔离 100% 失败于第 1 步。）
 *
 * 哈希段 = sha1(分支id::profileId)（Codex P1 两连，2026-07-26）：res-N / guard-N
 * 这类确定性成员 id 在**不同分支**乃至同分支的**不同 profile** 上都会重复——
 * mongo 专用实例容器名由库名派生，第二次克隆的幂等 `docker rm -f` 会直接摧毁
 * 前一个正在使用的隔离实例；mysql/pg 共享实例内同名库同样互相覆盖。
 * 分支 + profile 双重身份揉进哈希后，容器名与库名天然唯一。
 */
export function isolatedDbNameFor(sourceDb: string, memberId: string, branchId: string, profileId: string): string {
  const safeMember = memberId.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  const scopeHash = createHash('sha1').update(`${branchId}::${profileId}`).digest('hex').slice(0, 6);
  return `${sourceDb}_rs_${scopeHash}_${safeMember}`.toLowerCase();
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
  /** 分支 id：揉进隔离库名/专用实例容器名的哈希段，防跨分支同名互杀（Codex P1） */
  branchId: string;
  /**
   * 本 CDS 实例 id（computeCdsInstanceId，Codex 第十九轮 P1）：多 master 共宿主
   * 时揉进专用实例容器名 + 打 cds.instance label——异 master 管同一分支/profile
   * 的克隆不再同名互杀；幂等清理前也按 label 验归属，异实例容器拒删。
   */
  instanceId?: string;
  /**
   * 专用隔离实例的发布地址（Codex 第三十八轮 P1）。传入 `CDS_HOST`（docker 网桥
   * 地址，即容器实际连过来的那个 IP），端口只发布在这一个地址上。
   * 该值为必填，禁止缺省时退回全网卡。
   */
  publishHost: string;
  now?: () => Date;
  onOutput?: (line: string) => void;
}): Promise<CloneResult> {
  const { target, memberId, profileId } = opts;
  const dbName = isolatedDbNameFor(target.sourceDb, memberId, opts.branchId, profileId);
  if (!DB_NAME_SAFE.test(dbName)) throw new Error(`隔离库名不合法: ${dbName}`);
  if (dbName.length > 60) {
    throw new Error(`隔离库名超长（${dbName.length} > 60，mysql/postgres 标识符上限），源库名过长时暂不支持隔离`);
  }
  const c = target.infra.containerName;
  const env = target.infra.env || {};
  const image = target.infra.dockerImage;
  const port = target.infra.containerPort
    || (target.engine === 'mysql' ? 3306 : target.engine === 'postgres' ? 5432 : 27017);

  // mongo 走「专用隔离实例」通道（八轮验收终局取证：共享 mongod 8.0.20 在本宿主
  // 上凡大批量写入随机 SIGSEGV[docker events die exitCode=139]，纯读从未崩——
  // 写压必须彻底移出共享实例）
  if (target.engine === 'mongo') {
    return cloneMongoViaDedicatedInstance({ target, memberId, profileId, dbName, instanceId: opts.instanceId, publishHost: opts.publishHost, now: opts.now, onOutput: opts.onOutput });
  }

  // ── mysql / postgres：共享实例内克隆（写入量小、历轮验收无崩溃记录，维持原路径）──
  // 复验 R3-P0：独立限额辅助容器（同镜像自带 client 工具、共享 DB 网络命名空间），
  // 压力大时被杀的是辅助容器，不是数据库本体。
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
  const secrets: string[] = [];

  // 两阶段 dump→导入（Codex P1）：`dump | client` 管道在 POSIX sh 下退出码取
  // 末端 client——dump 半路失败而 client 消费掉空/残缺流照样 0 退出，set -e
  // 拦不住，快照被记成克隆成功、副本对着空库跑实验。落盘中间产物让两个进程
  // 的退出码都被 set -e 逐个把关（与 mongo 通道的 dump 落盘同款思路；文件写在
  // 辅助容器自身层，随 --rm 自动消失）。
  if (target.engine === 'mysql') {
    const user = 'root';
    const pw = env.MYSQL_ROOT_PASSWORD || env.MARIADB_ROOT_PASSWORD || '';
    secrets.push(pw);
    const conn = `-h127.0.0.1 -P${port} -u${user}`;
    argv = helper(['-e', `MYSQL_PWD=${pw}`],
      `set -e; mysql ${conn} -e 'CREATE DATABASE IF NOT EXISTS \`${dbName}\`'; ` +
      `mysqldump ${conn} --single-transaction --routines --triggers ${target.sourceDb} > /tmp/rsclone.sql; ` +
      `mysql ${conn} ${dbName} < /tmp/rsclone.sql; rm -f /tmp/rsclone.sql`);
  } else {
    const user = env.POSTGRES_USER || 'postgres';
    const pw = env.POSTGRES_PASSWORD || '';
    secrets.push(pw);
    const conn = `-h 127.0.0.1 -p ${port} -U ${user}`;
    argv = helper(['-e', `PGPASSWORD=${pw}`],
      `set -e; psql ${conn} -d postgres -v ON_ERROR_STOP=1 -c 'CREATE DATABASE "${dbName}"' 2>/dev/null || true; ` +
      `pg_dump ${conn} ${target.sourceDb} > /tmp/rsclone.sql; ` +
      `psql ${conn} -q -v ON_ERROR_STOP=1 -d ${dbName} < /tmp/rsclone.sql; rm -f /tmp/rsclone.sql`);
  }

  opts.onOutput?.(`── 一键隔离数据库: 克隆 ${target.sourceDb} → ${dbName}（${target.engine} @ ${c}，独立限额辅助容器）──`);
  const result = await runDockerExec(argv, '', 600_000, 64 * 1024);
  if (result.code !== 0) {
    // 失败原因保留头尾双段（复验 R3-P2）；失败残留延迟重试清理（复验 R3-P1/R4）
    const raw = `${result.stderr || result.stdout}`.trim();
    const detail = maskSecretValues(raw.length > 900 ? `${raw.slice(0, 300)}\n…\n${raw.slice(-500)}` : raw, secrets);
    let residue = `（警告：半成品克隆库 ${dbName} 未能自动清理，请到数据库工作台手动 DROP）`;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      try {
        await dropReplicaDb({
          id: `rsdb_${profileId}_${memberId}`, profileId, memberId,
          engine: target.engine, sourceDb: target.sourceDb, dbName, infraContainer: c,
          clonedAt: (opts.now?.() ?? new Date()).toISOString(),
        }, env);
        residue = '（半成品克隆库已自动清理）';
        break;
      } catch {
        if (attempt < 5) await new Promise((r) => setTimeout(r, 20_000));
      }
    }
    throw new Error(`数据库克隆失败（${target.engine}）: ${detail || `exit ${result.code}`}${residue}`);
  }
  opts.onOutput?.(`── 隔离库 ${dbName} 克隆完成 ──`);

  // 关系型隔离的 env 覆写必须连 DATABASE_URL/MYSQL_URL/POSTGRES_URL 一起改
  //（Codex 第三十二轮 P1）——只改 MYSQL_DATABASE/POSTGRES_DB 时应用照旧连主库。
  const envOverride: Record<string, string> = baseIsolationEnvOverride(target, dbName);
  return {
    envOverride,
    snapshot: {
      id: `rsdb_${profileId}_${memberId}`,
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

/**
 * mongo 专用隔离实例克隆通道（八轮验收终局方案，2026-07-24）。
 *
 * 取证结论：共享 mongod 8.0.20 在本宿主上凡「大批量写入」随机段错误
 * （生命周期取证器 die exitCode=139；WT cache 收紧、辅助容器隔离、单并发限流、
 * 索引串行重建全部无效——纯读 dump 从未触发）。因此写压彻底移出共享实例：
 *
 *   阶段1  mongodump 只读共享库 → gzip 落盘（唯一触碰共享库的操作，已证安全）
 *   阶段2  docker run 专用 mongo 实例（默认 mongo:7.0——早于 8.0.4 引入的
 *          TCMalloc rseq 变更；独立容器、内存 1.5G 上限、WT cache 1G）
 *   阶段3  mongorestore 写入专用实例（写崩也只崩专用实例，共享库零风险）
 *
 * 成员 env 覆写连接串 + 库名，直连专用实例——隔离升级为「实例级」，与用户
 * 「复制出去、剥离主库、随时可回」的心智完全一致。快照删除 = 移除专用容器。
 * 专用实例镜像可经 CDS_REPLICA_ISO_MONGO_IMAGE 覆盖。
 */
async function cloneMongoViaDedicatedInstance(opts: {
  target: ReplicaDbTarget;
  memberId: string;
  profileId: string;
  dbName: string;
  instanceId?: string;
  /** 专用实例端口的发布地址（见 cloneReplicaDb 同名参数与下方 runIso 说明）。 */
  publishHost: string;
  now?: () => Date;
  onOutput?: (line: string) => void;
}): Promise<CloneResult> {
  const { target, memberId, profileId, dbName, onOutput } = opts;
  const c = target.infra.containerName;
  const env = target.infra.env || {};
  const image = target.infra.dockerImage;
  const port = target.infra.containerPort || 27017;
  const user = env.MONGO_INITDB_ROOT_USERNAME || '';
  const pw = env.MONGO_INITDB_ROOT_PASSWORD || '';
  const secrets = [pw].filter(Boolean);

  // fail-closed：成员必须能经连接串 env 指向专用实例，否则隔离只是幻觉
  if (!target.connEnvKeys?.length) {
    throw new Error('该服务的环境变量里没有 Mongo 连接串 key（MongoDB__ConnectionString / MONGO_URI 家族），无法把副本指向专用隔离实例，已中止');
  }

  // 源库大小闸门（现在保护的是宿主 CPU/磁盘与克隆时长；共享库本体已零写入风险）
  const maxMb = replicaCloneMaxMb();
  const sizeRead = await mongoAdminEval(c, port, env,
    `print(Number(db.getSiblingDB('${target.sourceDb}').stats().dataSize))`);
  const dataBytes = parseMongoNumber(sizeRead.stdout);
  if (sizeRead.code !== 0 || !Number.isFinite(dataBytes)) {
    throw new Error('无法读取源库数据量，已中止克隆（fail-closed）');
  }
  if (dataBytes > maxMb * 1024 ** 2) {
    throw new Error(
      `源库 ${target.sourceDb} 数据量 ${(dataBytes / 1024 ** 3).toFixed(2)}G 超过克隆上限 ${maxMb}MB（可经 CDS_REPLICA_CLONE_MAX_MB 调整）`,
    );
  }

  // dump 归档走 docker 托管卷（Codex 第二十三轮 P1，替代宿主 bind）：容器化
  // master 用宿主 docker socket 时，`-v 主机路径` 的 bind source 在 **daemon
  // 宿主**解析，而 fs.rmSync 清的是 master 容器自己的文件系统——每次成功隔离
  // 都会在宿主 /tmp 留下整份生产派生 dump.archive.gz（敏感数据滞留 + 磁盘
  // 耗尽）。托管卷让数据与清理都发生在 daemon 命名空间（docker volume rm），
  // 与 projects.ts 的 docker cp 同一教训：跨命名空间的 bind 路径不可信。
  // 卷名带实例段（第二十二轮 P1 同款）：共宿主双 master 并发克隆同名目标不撞卷。
  const scratchVol = `cds-rsclone-${opts.instanceId ? `${opts.instanceId.slice(0, 6)}-` : ''}${dbName}`;
  // 实例段进容器名（Codex 第十九轮 P1）：不带实例段时，两个共宿主的 CDS master
  // 管到同一分支/profile 会得到完全相同的容器名——一边开始隔离就把另一边活着
  // 的隔离实例 rm -f 掉。dropReplicaDb 的 cds-rsdb- 前缀守卫不受影响（快照存的
  // 是完整容器名）。
  const isoName = `cds-rsdb-${opts.instanceId ? `${opts.instanceId.slice(0, 6)}-` : ''}${dbName}`;
  const isoImage = process.env.CDS_REPLICA_ISO_MONGO_IMAGE || 'mongo:7.0';
  const authFlags = user ? `-u "$RS_MONGO_USER" -p "$RS_MONGO_PW" --authenticationDatabase admin` : '';
  const authEnv = user ? ['-e', `RS_MONGO_USER=${user}`, '-e', `RS_MONGO_PW=${pw}`] : [];
  const toolsHelper = (network: string, script: string): string[] => [
    'run', '--rm', '-i', '--pull', 'never',
    '--network', `container:${network}`,
    '--memory', '768m', '--memory-swap', '768m', '--cpus', '1',
    '-v', `${scratchVol}:/rsclone`,
    '--entrypoint', 'sh',
    ...authEnv,
    image,
    '-c', script,
  ];

  try {
    // 清掉上次失败/崩溃残留的同名卷（陈旧归档会被 restore 成错误数据）；
    // 同 master 并发同目标克隆已被 isolationInFlight 互斥，rm 不会撞在途卷
    await runDockerExec(['volume', 'rm', '-f', scratchVol], '', 60_000, 8 * 1024).catch(() => undefined);
    onOutput?.(`── 一键隔离数据库: ${target.sourceDb} → 专用隔离实例 ${isoName}（${isoImage}）──`);
    // 幂等：清掉可能的同名残留（上次失败/重试）。清理前验归属（Codex 第十九轮
    // P1 backstop）：同名容器带 cds.instance 且不等于本实例时拒删——实例段进名
    // 后正常不会撞名，这里兜的是历史遗留名/异常改名的边角。
    if (opts.instanceId) {
      const owner = await runDockerExec(
        ['inspect', '-f', '{{index .Config.Labels "cds.instance"}}', isoName], '', 20_000, 4 * 1024,
      );
      const ownerLabel = owner.code === 0 ? owner.stdout.trim() : '';
      if (ownerLabel && ownerLabel !== opts.instanceId) {
        throw new Error(`同名隔离实例 ${isoName} 属于另一个 CDS 实例（cds.instance=${ownerLabel}），拒绝清理/覆盖——请检查多 master 共宿主配置`);
      }
    }
    await runDockerExec(['rm', '-f', isoName], '', 60_000, 8 * 1024);

    onOutput?.('── 阶段1/3: mongodump 只读落盘（共享库只读，零写入）──');
    const dump = await runDockerExec(toolsHelper(c,
      `set -e; command -v mongodump >/dev/null 2>&1 || { echo 'mongo 镜像缺少 mongodump（database tools），无法克隆'; exit 41; }; ` +
      `mongodump --host 127.0.0.1 --port ${port} ${authFlags} --archive=/rsclone/dump.archive.gz --gzip -d ${target.sourceDb} --numParallelCollections=1`,
    ), '', 600_000, 64 * 1024);
    if (dump.code !== 0) throw cloneStageError('mongo dump', dump, secrets);

    onOutput?.(`── 阶段2/3: 启动专用隔离实例（${isoImage}，内存上限 1.5G / WT cache 1G${user ? '，root 认证=源库同凭据' : '，源库无认证、实例保持同姿态'}）──`);
    // 认证（Codex P1）：专用实例复用**源库的 root 凭据**（不新增落盘密钥、与共享
    // infra 的安全姿态一致）；源库本身无认证时保持同姿态。
    //
    // 发布面（Codex 第三十八轮 P1）：`-p 27017` 会把端口发布到宿主**全部网卡**，
    // 源库无 root 凭据时这就是一份无认证的生产派生克隆挂在公网/内网可达地址上。
    // 而消费方（副本容器）用的连接串是 `mongodb://${CDS_HOST}:<port>`——CDS_HOST
    // 是 docker 网桥地址，所以只发布在这一个地址上就够：宿主上任意网络的容器都能
    // 经网桥 IP 连到，宿主之外则完全够不着。
    //
    // 不用 Codex 建议的 127.0.0.1：容器访问不到宿主的 loopback，绑上去等于把隔离
    // 功能整个打死。绑在「消费方实际使用的那个地址」才是既收紧又不破坏的解。
    const publishHost = opts.publishHost.trim();
    if (!publishHost || ['0.0.0.0', '*', '::'].includes(publishHost)) {
      throw new Error('专用隔离实例必须绑定私网地址，禁止发布到全部网卡');
    }
    const publishSpec = `${publishHost}::27017`;
    const runIso = await runDockerExec([
      'run', '-d', '--name', isoName,
      '--label', 'cds.type=rsdb',
      ...(opts.instanceId ? ['--label', `cds.instance=${opts.instanceId}`] : []),
      '--restart', 'unless-stopped',
      '-p', publishSpec,
      // 日志限额（2026-07-27 宕机复盘 P1）：专用隔离实例是长跑容器，默认 json-file
      // 无上限，restore 期间的 mongod 日志尤其密集。
      '--log-opt', 'max-size=50m', '--log-opt', 'max-file=3',
      '--memory', '1536m', '--memory-swap', '1536m',
      ...(user ? ['-e', `MONGO_INITDB_ROOT_USERNAME=${user}`, '-e', `MONGO_INITDB_ROOT_PASSWORD=${pw}`] : []),
      isoImage, 'mongod', '--wiredTigerCacheSizeGB', '1',
    ], '', 300_000, 16 * 1024);
    if (runIso.code !== 0) throw cloneStageError('启动专用实例', runIso, secrets);
    let ready = false;
    for (let i = 0; i < 45; i += 1) {
      const ping = await runDockerExec(
        ['exec', isoName, 'mongosh', '--quiet', '--eval', 'print(db.runCommand({ping:1}).ok)'],
        '', 20_000, 4 * 1024,
      );
      if (ping.code === 0 && /1\s*$/.test((ping.stdout || '').trim())) { ready = true; break; }
      await new Promise((r) => setTimeout(r, 2_000));
    }
    if (!ready) throw new Error('专用隔离实例未在 90s 内就绪');
    const portRead = await runDockerExec(['port', isoName, '27017/tcp'], '', 20_000, 4 * 1024);
    const portMatch = /:(\d+)\s*$/m.exec((portRead.stdout || '').trim());
    if (portRead.code !== 0 || !portMatch) {
      throw new Error(`无法确定专用实例宿主端口: ${(portRead.stdout || portRead.stderr).trim().slice(0, 200)}`);
    }
    const isoHostPort = Number(portMatch[1]);

    onOutput?.('── 阶段3/3: mongorestore 写入专用实例（写压不触碰共享库）──');
    const restore = await runDockerExec(toolsHelper(isoName,
      `set -e; mongorestore --host 127.0.0.1 --port 27017 ${authFlags} --archive=/rsclone/dump.archive.gz --gzip ` +
      `--nsFrom='${target.sourceDb}.*' --nsTo='${dbName}.*' --numParallelCollections=1 --numInsertionWorkersPerCollection=1`,
    ), '', 900_000, 64 * 1024);
    if (restore.code !== 0) throw cloneStageError('mongo restore', restore, secrets);
    onOutput?.(`── 隔离库 ${dbName} 就绪 @ 专用实例 ${isoName}（宿主端口 ${isoHostPort}）──`);

    const envOverride: Record<string, string> = {};
    Object.assign(envOverride, baseIsolationEnvOverride(target, dbName));
    // 连接串覆写：保留 ${CDS_HOST} 模板，随容器启动的既有模板解析链路落成宿主地址；
    // 实例带认证时凭据入串（percent-encode 防特殊字符撞 ${VAR} 模板展开）
    for (const key of target.connEnvKeys) envOverride[key] = dedicatedConnString(user, pw, isoHostPort);
    return {
      envOverride,
      snapshot: {
        id: `rsdb_${profileId}_${memberId}`,
        profileId,
        memberId,
        engine: 'mongo',
        sourceDb: target.sourceDb,
        dbName,
        infraContainer: c,
        dedicatedContainer: isoName,
        dedicatedHostPort: isoHostPort,
        ...(user ? { dedicatedAuth: 'source-infra' as const } : {}),
        clonedAt: (opts.now?.() ?? new Date()).toISOString(),
      },
    };
  } catch (err) {
    // 失败善后：专用实例整容器移除（含匿名卷）——不存在「半成品残留库」问题
    await runDockerExec(['rm', '-f', '-v', isoName], '', 60_000, 8 * 1024).catch(() => undefined);
    throw err;
  } finally {
    // daemon 命名空间内清理归档卷（best-effort；失败留给下次同名克隆的 pre-rm）
    await runDockerExec(['volume', 'rm', '-f', scratchVol], '', 60_000, 8 * 1024).catch(() => undefined);
  }
}

function cloneStageError(stage: string, r: { code: number; stderr: string; stdout: string }, secrets: string[]): Error {
  const raw = `${r.stderr || r.stdout}`.trim();
  const detail = maskSecretValues(raw.length > 900 ? `${raw.slice(0, 300)}\n…\n${raw.slice(-500)}` : raw, secrets);
  return new Error(`数据库克隆失败（${stage}）: ${detail || `exit ${r.code}`}`);
}

/** mongod admin eval 通道（root 凭据经 URI，脚本经 --eval，输出 --quiet）。
 * 导出给隔离审计（replica-isolation-audit）复用——主库侧金丝雀读写同一凭据链路。 */
export function mongoAdminEval(
  containerName: string,
  port: number,
  env: Record<string, string>,
  script: string,
): ReturnType<typeof runDockerExec> {
  const user = env.MONGO_INITDB_ROOT_USERNAME || '';
  const pw = env.MONGO_INITDB_ROOT_PASSWORD || '';
  const uri = user
    ? `mongodb://${encodeURIComponent(user)}:${encodeURIComponent(pw)}@localhost:${port}/admin?authSource=admin`
    : `mongodb://localhost:${port}/admin`;
  return runDockerExec(['exec', '-i', containerName, 'mongosh', uri, '--quiet', '--eval', script], '', 30_000, 16 * 1024);
}

/** mongosh 数值输出解析：脚本端必须 Number() 强转（int64 会打成 Long('…')），这里再兜底提取行尾数字。 */
function parseMongoNumber(stdout: string): number {
  const m = /(\d+)\s*$/.exec((stdout || '').trim());
  return m ? Number(m[1]) : NaN;
}

/**
 * 整库克隆大小上限（MB）。mongo 已走专用隔离实例（共享库零写入风险），
 * 上限保护的是宿主 CPU/磁盘与克隆时长；默认 3072，可经 CDS_REPLICA_CLONE_MAX_MB 调整。
 */
/**
 * 从已有隔离库快照重建 env 覆写（统一战线同库复用，2026-07-25）：
 * 多个服务隔离同一个源库时只克隆一次，后来的服务 / 后加的副本直接
 * 连到既有专用实例（mongo）或既有隔离库（mysql/pg 共享实例通道）。
 */
/**
 * 专用实例连接串：带认证时凭据 percent-encode 入串（authSource=admin），
 * `$` 会被编码为 %24，不会撞上容器 env 的 ${VAR} 模板展开。
 */
function dedicatedConnString(user: string, pw: string, hostPort: number): string {
  const cred = user ? `${encodeURIComponent(user)}:${encodeURIComponent(pw)}@` : '';
  const authSuffix = user ? '/?authSource=admin' : '';
  return `mongodb://${cred}\${CDS_HOST}:${hostPort}${authSuffix}`;
}

/**
 * 专用隔离实例的真实凭据活取（Codex 第二十二轮 P2）：实例在克隆时刻用**当时的**
 * 源库 root 凭据初始化；源库其后轮换密码时，按 infra 现值重建连接串会连不上
 * 老实例。容器自身 env 即凭据 SSOT（不落盘任何密钥），inspect 失败（容器被删
 * 等）返回 null，调用方退回 infra 现值兜底（与旧行为等价）。
 */
export async function dedicatedAuthFromContainer(snapshot: ReplicaDbSnapshot): Promise<{ user: string; pw: string } | null> {
  if (!snapshot.dedicatedContainer || snapshot.dedicatedAuth !== 'source-infra') return null;
  const r = await runDockerExec(['inspect', '-f', '{{json .Config.Env}}', snapshot.dedicatedContainer], '', 20_000, 16 * 1024);
  if (r.code !== 0) return null;
  try {
    const envs = JSON.parse(r.stdout.trim()) as string[];
    const get = (k: string): string => {
      const hit = envs.find((e) => e.startsWith(`${k}=`));
      return hit ? hit.slice(k.length + 1) : '';
    };
    const user = get('MONGO_INITDB_ROOT_USERNAME');
    return user ? { user, pw: get('MONGO_INITDB_ROOT_PASSWORD') } : null;
  } catch {
    return null;
  }
}

export function envOverrideFromSnapshot(
  target: ReplicaDbTarget,
  snapshot: ReplicaDbSnapshot,
  /** 专用实例真实凭据（dedicatedAuthFromContainer 活取）；缺省退 infra 现值 */
  authOverride?: { user: string; pw: string } | null,
): Record<string, string> {
  const envOverride: Record<string, string> = baseIsolationEnvOverride(target, snapshot.dbName);
  if (snapshot.dedicatedContainer && snapshot.dedicatedHostPort) {
    // 带认证标记的实例复用源库 root 凭据（优先容器活取，退 infra env，不落盘）；
    // 旧无认证实例（快照无标记）维持裸串，不误发凭据
    const env = target.infra?.env || {};
    const user = snapshot.dedicatedAuth === 'source-infra'
      ? (authOverride?.user || env.MONGO_INITDB_ROOT_USERNAME || '')
      : '';
    const pw = snapshot.dedicatedAuth === 'source-infra'
      ? (authOverride ? authOverride.pw : (env.MONGO_INITDB_ROOT_PASSWORD || ''))
      : '';
    for (const key of target.connEnvKeys) envOverride[key] = dedicatedConnString(user, pw, snapshot.dedicatedHostPort);
  }
  return envOverride;
}

export function replicaCloneMaxMb(): number {
  const raw = Number(process.env.CDS_REPLICA_CLONE_MAX_MB);
  return Number.isFinite(raw) && raw > 0 ? Math.max(64, raw) : 3072;
}

/** 删除隔离库（快照台账的手动清理动作）。 */
export async function dropReplicaDb(snapshot: ReplicaDbSnapshot, infraEnv: Record<string, string>): Promise<void> {
  const dbName = snapshot.dbName;
  if (!DB_NAME_SAFE.test(dbName) || !dbName.includes('_rs_')) {
    throw new Error(`拒绝删除非隔离库命名的数据库: ${dbName}`);
  }
  // 专用隔离实例：删除 = 整容器移除（含匿名数据卷），不触碰共享库
  if (snapshot.dedicatedContainer) {
    if (!snapshot.dedicatedContainer.startsWith('cds-rsdb-')) {
      throw new Error(`拒绝删除非隔离实例命名的容器: ${snapshot.dedicatedContainer}`);
    }
    const rm = await runDockerExec(['rm', '-f', '-v', snapshot.dedicatedContainer], '', 120_000, 16 * 1024);
    if (rm.code !== 0 && !/No such container/i.test(rm.stderr || '')) {
      throw new Error(`删除专用隔离实例失败: ${(rm.stderr || rm.stdout).trim().slice(-300)}`);
    }
    return;
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
      ? `mongodb://${encodeURIComponent(user)}:${encodeURIComponent(pw)}@localhost:27017/${dbName}?authSource=admin`
      : `mongodb://localhost:27017/${dbName}`;
    argv = ['exec', '-i', c, 'mongosh', uri, '--quiet', '--eval', 'db.dropDatabase()'];
  }
  const result = await runDockerExec(argv, '', 120_000, 16 * 1024);
  if (result.code !== 0) {
    throw new Error(`删除隔离库失败: ${maskSecretValues((result.stderr || result.stdout).trim().slice(-400), secrets)}`);
  }
}
