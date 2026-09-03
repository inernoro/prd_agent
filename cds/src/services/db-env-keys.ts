/**
 * 库名变量与数据库连接串的识别规则（收敛 1 / 2 的最底层 SSOT，无内部依赖）。
 *
 * 为什么单独成模块：分支独立库改写（db-scope-isolation）与复制集定位（replica-db-clone）
 * 此前各持一份规则——前者只认白名单，后者认三家族——「.NET 项目在项目设置里被说没库、
 * 复制集却能定位」就是从两份规则开始分裂的。现在两边都从这里取，谁也不能再长出第二份。
 *
 * 三家族：
 *   whitelist  PER_BRANCH_DB_ENV_KEYS，分支独立库会给它加后缀
 *   framework  应用框架风格（.NET 双下划线 MongoDB__DatabaseName 等），按项目约定不加后缀
 *   neutral    引擎中立（DB_NAME / DATABASE_NAME），引擎只能从同 env 的关系型连接串 scheme 读
 */

export type DbEngine = 'mongo' | 'mysql' | 'postgres';

export const PER_BRANCH_DB_ENV_KEYS = [
  // Phase 8.8 之后:CDS_* 前缀(cdscli scan 生成的标准命名)
  'CDS_MYSQL_DATABASE',
  'CDS_POSTGRES_DB',
  'CDS_MARIADB_DATABASE',
  'CDS_MONGO_INITDB_DATABASE',
  // 向后兼容:Phase 8.8 之前导入的项目用的无前缀名
  'MYSQL_DATABASE',
  'MARIADB_DATABASE',
  'POSTGRES_DB',
  'POSTGRESQL_DB',
  'MONGO_INITDB_DATABASE',
];

/** env key 家族 → 引擎（PER_BRANCH_DB_ENV_KEYS 的引擎归类） */
export function engineForEnvKey(key: string): DbEngine | null {
  if (key.includes('MONGO')) return 'mongo';
  if (key.includes('MYSQL') || key.includes('MARIADB')) return 'mysql';
  if (key.includes('POSTGRES')) return 'postgres';
  return null;
}

/**
 * 补充家族：应用框架风格的库名 env key（如 .NET 双下划线 `MongoDB__DatabaseName`）。
 * 只用于定位，**不进 PER_BRANCH_DB_ENV_KEYS**——那份白名单驱动 per-branch 库名改写，
 * 部分项目（如 prd-agent）刻意让框架 key 不随分支加后缀。
 */
export const FRAMEWORK_DB_ENV_PATTERNS: Array<{ engine: DbEngine; re: RegExp }> = [
  { engine: 'mongo', re: /^(CDS_)?MONGO(DB)?_{1,2}DATABASE(_?NAME)?$/i },
  { engine: 'mysql', re: /^(CDS_)?(MYSQL|MARIADB)_{1,2}DATABASE(_?NAME)?$/i },
  { engine: 'postgres', re: /^(CDS_)?(POSTGRES(QL)?|PG)_{1,2}(DB|DATABASE)(_?NAME)?$/i },
];

/**
 * 引擎中立的库名 key（Spring / 通用配置风格 `DB_NAME` / `DATABASE_NAME`）。
 * 引擎不能猜，只能从同一份 env 里的关系型连接 URL scheme 读出来；读不出唯一引擎就不认。
 */
export const ENGINE_NEUTRAL_DB_ENV_PATTERN = /^(CDS_)?(DB|DATABASE)_{1,2}(NAME)$/i;

/** 关系型连接 URL 的 scheme —— 识别与改写共用这一条（两份漂移过一次）。 */
export const RELATIONAL_URL_SCHEME = /^(jdbc:)?(mysql|mariadb|postgres(ql)?):\/\//i;
/** mongo 连接 URI 的 scheme */
export const MONGO_URL_SCHEME = /^mongodb(\+srv)?:\/\//i;

export function isRelationalUrl(value: unknown): boolean {
  return typeof value === 'string' && RELATIONAL_URL_SCHEME.test(value.trim());
}

/** 值是不是数据库连接串（关系型或 mongo）；redis:// 之类不算 */
export function isDbUrl(value: unknown): boolean {
  return typeof value === 'string' && (RELATIONAL_URL_SCHEME.test(value.trim()) || MONGO_URL_SCHEME.test(value.trim()));
}

/** 一份 env 里出现过的全部关系型引擎（去重）。 */
export function relationalEnginesFromUrls(env: Record<string, string>): DbEngine[] {
  const found = new Set<DbEngine>();
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
export function engineFromRelationalUrls(env: Record<string, string>): DbEngine | null {
  const found = relationalEnginesFromUrls(env);
  return found.length === 1 ? found[0] : null;
}

/**
 * 判定某个 env key 是否为库名 key，并归类引擎（白名单 → 框架风格 → 引擎中立三路）。
 * 引擎中立那一路必须由调用方提供 env 上下文，否则无从判断引擎，直接不认。
 */
export function classifyDbEnvKey(key: string, neutralEngine?: DbEngine | null): DbEngine | null {
  if ((PER_BRANCH_DB_ENV_KEYS as readonly string[]).includes(key)) return engineForEnvKey(key);
  for (const { engine, re } of FRAMEWORK_DB_ENV_PATTERNS) {
    if (re.test(key)) return engine;
  }
  if (neutralEngine && ENGINE_NEUTRAL_DB_ENV_PATTERN.test(key)) return neutralEngine;
  return null;
}

export type DbEnvKeyFamily = 'whitelist' | 'framework' | 'neutral';

export interface DbEnvKeyClassification {
  key: string;
  engine: DbEngine;
  family: DbEnvKeyFamily;
  /** 分支独立库会不会给它加后缀——只有白名单家族会；其余「已识别，按项目约定不加后缀」 */
  rewritten: boolean;
}

/** 一份 env 里全部库名变量的分类（空值不算声明；顺序保持 env 插入顺序）。 */
export function classifyDbEnvKeys(env: Record<string, string>): DbEnvKeyClassification[] {
  const neutralEngine = engineFromRelationalUrls(env);
  const out: DbEnvKeyClassification[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== 'string' || value === '') continue;
    const engine = classifyDbEnvKey(key, neutralEngine);
    if (!engine) continue;
    const whitelisted = (PER_BRANCH_DB_ENV_KEYS as readonly string[]).includes(key);
    const family: DbEnvKeyFamily = whitelisted ? 'whitelist'
      : ENGINE_NEUTRAL_DB_ENV_PATTERN.test(key) && !FRAMEWORK_DB_ENV_PATTERNS.some((f) => f.re.test(key)) ? 'neutral'
        : 'framework';
    out.push({ key, engine, family, rewritten: whitelisted });
  }
  return out;
}

/** 疑似数据库相关、但分类器认不出的变量名（只报 key，不报值）。 */
export function suspectDbEnvKeys(env: Record<string, string>): string[] {
  const classified = new Set(classifyDbEnvKeys(env).map((k) => k.key));
  return Object.keys(env).filter(
    (k) => !classified.has(k) && typeof env[k] === 'string' && env[k] !== ''
      && (/(^|_)(DB|DATABASE)(_|$)/i.test(k) || /DATASOURCE|JDBC/i.test(k)),
  );
}

export type DbInvolvement = 'db' | 'unrecognized' | 'none';

/** 一份 env 涉不涉及数据库：认得库名变量 → db；只有疑似变量 → unrecognized；什么都没有 → none */
export function dbInvolvementOf(env: Record<string, string>): { involvement: DbInvolvement; suspects: string[] } {
  if (classifyDbEnvKeys(env).length > 0) return { involvement: 'db', suspects: [] };
  const suspects = suspectDbEnvKeys(env);
  return { involvement: suspects.length > 0 ? 'unrecognized' : 'none', suspects };
}

const DB_URL_RE = /^([a-zA-Z][a-zA-Z0-9+.:-]*:\/\/[^/?#]*)\/([^/?#]*)([?#].*)?$/;

/** 连接串路径里的库名段（解析不出或为空返回 null） */
export function dbUrlDbSegment(url: string): string | null {
  const m = DB_URL_RE.exec((url || '').trim());
  return m && m[2] ? m[2] : null;
}

/**
 * 连接 URL 里把库名段换成另一个库名，只改路径段：主机/端口/凭据/查询参数原样保留。
 * 无法解析或路径段对不上 sourceDb 时返回 null，由调用方按「不认识就不动」处理。
 * scheme 允许内嵌冒号（`jdbc:mysql://`）。
 */
export function rewriteRelationalUrlDb(url: string, sourceDb: string, isolatedDb: string): string | null {
  const m = DB_URL_RE.exec(url);
  if (!m) return null;
  const [, prefix, dbSegment, tail] = m;
  if (dbSegment !== sourceDb) return null;
  return `${prefix}/${isolatedDb}${tail || ''}`;
}
