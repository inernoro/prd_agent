/**
 * Phase 5(2026-05-01) — 多分支数据库隔离助手。
 *
 * 北极星目标:让任意 schemaful DB 项目在 CDS 多分支部署时,**多分支不互相破坏数据**。
 *
 * 实现策略:同一个 mysql/postgres 实例下用 *不同 database name* 隔离。
 *   - profile.dbScope === 'shared'(默认):env 不动,所有分支共用同一 DB,migration 互相影响
 *   - profile.dbScope === 'per-branch':env 里的 DB 名相关 key 自动后缀 `_<branchSlug>`
 *
 * 例:
 *   原 env: { MYSQL_DATABASE: 'app' },branch='claude/feat-x'
 *   per-branch 后:{ MYSQL_DATABASE: 'app_claude_feat_x' }
 *   连接串通过 ${MYSQL_DATABASE} 引用,会跟着变;硬编码 DB 名的需用户手改成引用形式。
 *
 * 已知边界(MVP):
 *   - 不主动建库:`per-branch` 假定 DB 镜像支持 "首次写入时自动建库"(mysql/mariadb/postgres
 *     在 init scripts + ORM migration 阶段都会自动 CREATE DATABASE)。如果你的镜像
 *     不支持,需要在应用 command 启动前自加 `mysql -e "CREATE DATABASE IF NOT EXISTS ..."`
 *   - 不清理:分支删除后 _<branchSlug> 库残留,不会自动 drop。Phase 5.5+ 加 GC
 *   - 不支持 mongo per-collection 切换:mongo 用 db 维度即可,POSTGRES_DB 等同
 */

/**
 * 在 'per-branch' 模式下,需要后缀 branchSlug 的 env key 列表。
 * 不在列表内的 key 不动,杜绝意外破坏(如 MYSQL_USER 不该改)。
 *
 * Phase 8.8 后,cdscli 自动生成的 env 一律走 CDS_* 前缀,所以需要把对应的
 * CDS_* 版本也加进白名单 — 否则用户用 Phase 8.8+ 项目时,customEnv 里的 key
 * 全是 CDS_* 前缀,本函数找不到匹配 → 静默 noop → 多分支隔离失效(高优 bug)。
 *
 * 保留旧无前缀的 key 是为了向后兼容 Phase 8.8 之前导入的项目。
 */
import {
  PER_BRANCH_DB_ENV_KEYS, classifyDbEnvKeys, isDbUrl, dbUrlDbSegment, rewriteRelationalUrlDb,
} from './db-env-keys.js';

// 白名单本体在 db-env-keys.ts（与分类器同源）；这里保留同名导出，老调用方不必改 import
export { PER_BRANCH_DB_ENV_KEYS } from './db-env-keys.js';

/**
 * 把 git branch name 规范化成 DNS-friendly slug,与 preview-slug.ts 的 slugify 一致风格,
 * 但 *只用 _ 作分隔符*(因为塞进 SQL identifier,大部分 DB 允许 [a-z0-9_],但不允许 `-`)。
 *
 * 例:
 *   'claude/fix-bug-X' → 'claude_fix_bug_x'
 *   'main'             → 'main'
 *   'feat/auth/login'  → 'feat_auth_login'
 */
export function slugifyBranchForDb(branch: string): string {
  return branch
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

/**
 * 应用 per-branch DB 隔离到 env map。返回新 map(不修改入参)。
 *
 * dbScope='shared' 或未传 → 原样返回(等价 noop)。
 * dbScope='per-branch' → 把 PER_BRANCH_DB_ENV_KEYS 里的 key 值加 `_<slug>` 后缀。
 *
 * 幂等:已含 _<slug> 后缀的值不重复加(避免 reconcile 反复跑导致变 `app_x_x_x`)。
 *
 * 此函数应在 mergedEnv 收集完毕、`resolveEnvTemplates` *之前* 调用,
 * 这样 ${MYSQL_DATABASE} 引用会展开成新值。
 */
export function applyPerBranchDbIsolation(
  env: Record<string, string>,
  dbScope: 'shared' | 'per-branch' | undefined,
  branch: string,
): Record<string, string> {
  if (dbScope !== 'per-branch') return env;
  const rows = explainPerBranchDbIsolation(env, dbScope, branch);
  if (rows.length === 0) return env;
  const result: Record<string, string> = { ...env };
  for (const row of rows) {
    if (row.to !== undefined) result[row.key] = row.to;
  }
  return result;
}

export type PerBranchDbRewriteKind =
  /** 白名单库名变量加后缀 */
  | 'db-name-suffix'
  /** 框架 / 引擎中立库名变量：已识别，按项目约定不加后缀 */
  | 'db-name-kept'
  /** 连接串库名段跟着同名库名变量一起加了后缀（或服务只有硬编码连接串，直接加后缀） */
  | 'url-followed'
  /** 连接串库名段是 ${...} 模板，展开后自然跟随，不动 */
  | 'url-template'
  /** 连接串库名段对不上任何库名变量（指向别的库）——不动，但必须让用户看见 */
  | 'url-unfollowed'
  /** 连接串跟着的是不加后缀的框架变量，同样不动（保持一致） */
  | 'url-kept';

export interface PerBranchDbRewriteRow {
  key: string;
  kind: PerBranchDbRewriteKind;
  from: string;
  /** 有改写才有 to */
  to?: string;
  reason?: string;
}

const DB_SEGMENT_SAFE = /^[A-Za-z0-9_]+$/;

/**
 * 分支独立库会对这份 env 的每个库相关变量做什么（收敛 2 的 SSOT；applyPerBranchDbIsolation 只是
 * 把这里的 to 套回去）。规则：
 *   1. 白名单库名变量加 `_<slug>` 后缀；框架 / 引擎中立变量只识别不改（按项目约定）。
 *   2. 数据库连接串（mysql / mariadb / postgres / jdbc:* / mongodb）的库名段：
 *      - 等于某个**被改写**变量的原值 → 跟着改成同一个新库名；
 *      - 等于某个**不改写**变量的值 → 不动（url-kept，与变量一致）；
 *      - 服务里没有任何库名变量、只有硬编码连接串 → 直接给库名段加后缀（此前这类项目的
 *        分支独立库是假的：变量改了，应用读的串没改）；
 *      - 是 ${...} 模板 → 不动，展开后自然跟随；
 *      - 对不上任何库名变量 → 不动，报 url-unfollowed 让配置检查器标「连接串未跟随」。
 *   3. 幂等：已带后缀的一律不重复加。
 */
export function explainPerBranchDbIsolation(
  env: Record<string, string>,
  dbScope: 'shared' | 'per-branch' | undefined,
  branch: string,
): PerBranchDbRewriteRow[] {
  if (dbScope !== 'per-branch') return [];
  const slug = slugifyBranchForDb(branch);
  if (!slug) return [];
  const suffix = `_${slug}`;
  const rows: PerBranchDbRewriteRow[] = [];
  const classified = classifyDbEnvKeys(env);
  // 原值 → 新值（被改写的）；原值 → 原值（保持的）
  const rewrittenValues = new Map<string, string>();
  const keptValues = new Set<string>();
  for (const k of classified) {
    const original = env[k.key];
    if (k.rewritten) {
      const to = original.endsWith(suffix) ? original : `${original}${suffix}`;
      if (to !== original) rows.push({ key: k.key, kind: 'db-name-suffix', from: original, to });
      rewrittenValues.set(original, to);
      if (original.endsWith(suffix)) rewrittenValues.set(original, original);
    } else {
      rows.push({ key: k.key, kind: 'db-name-kept', from: original, reason: '已识别，按项目约定不加后缀' });
      keptValues.add(original);
    }
  }
  const hasDbNameKeys = classified.length > 0;
  for (const [key, value] of Object.entries(env)) {
    if (!isDbUrl(value)) continue;
    const segment = dbUrlDbSegment(value);
    if (!segment) continue;
    if (segment.includes('${')) { rows.push({ key, kind: 'url-template', from: value }); continue; }
    if (!DB_SEGMENT_SAFE.test(segment)) continue;
    if (segment.endsWith(suffix)) continue; // 幂等
    const target = rewrittenValues.get(segment);
    if (target !== undefined) {
      if (target === segment) continue;
      const to = rewriteRelationalUrlDb(value, segment, target);
      if (to) rows.push({ key, kind: 'url-followed', from: value, to });
      continue;
    }
    if (keptValues.has(segment)) { rows.push({ key, kind: 'url-kept', from: value, reason: '库名变量按项目约定不加后缀，连接串保持一致' }); continue; }
    if (!hasDbNameKeys) {
      const to = rewriteRelationalUrlDb(value, segment, `${segment}${suffix}`);
      if (to) rows.push({ key, kind: 'url-followed', from: value, to });
      continue;
    }
    rows.push({
      key, kind: 'url-unfollowed', from: value,
      reason: `连接串里的库名 ${segment} 对不上本服务任何库名变量，分支独立库没有改它——请确认它是否该跟随，或改用 \${变量} 引用`,
    });
  }
  return rows;
}

/**
 * 给 caller 用的内省函数:返回某 env map 在 per-branch 模式下会被改写成什么样。
 * 不实际改 env,只输出 diff,供 deploy SSE 流告诉用户"per-branch 把 DATABASE 改成了 X"。
 *
 * 返回 { from, to } 二元组列表;空数组 = 没有任何 key 被改写。
 */
export function previewPerBranchDbDiff(
  env: Record<string, string>,
  dbScope: 'shared' | 'per-branch' | undefined,
  branch: string,
): Array<{ key: string; from: string; to: string }> {
  return explainPerBranchDbIsolation(env, dbScope, branch)
    .filter((r): r is PerBranchDbRewriteRow & { to: string } => r.to !== undefined)
    .map((r) => ({ key: r.key, from: r.from, to: r.to }));
}
