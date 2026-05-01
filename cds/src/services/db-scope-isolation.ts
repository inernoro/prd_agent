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
 */
const PER_BRANCH_DB_ENV_KEYS = [
  'MYSQL_DATABASE',
  'MARIADB_DATABASE',
  'POSTGRES_DB',
  'POSTGRESQL_DB',
  'MONGO_INITDB_DATABASE',
];

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
  const slug = slugifyBranchForDb(branch);
  if (!slug) return env;
  const suffix = `_${slug}`;
  const result: Record<string, string> = { ...env };
  for (const key of PER_BRANCH_DB_ENV_KEYS) {
    const original = result[key];
    if (typeof original !== 'string' || original === '') continue;
    // 幂等:已含 _<slug> 后缀就不重复加
    if (original.endsWith(suffix)) continue;
    result[key] = `${original}${suffix}`;
  }
  return result;
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
  if (dbScope !== 'per-branch') return [];
  const slug = slugifyBranchForDb(branch);
  if (!slug) return [];
  const suffix = `_${slug}`;
  const diffs: Array<{ key: string; from: string; to: string }> = [];
  for (const key of PER_BRANCH_DB_ENV_KEYS) {
    const original = env[key];
    if (typeof original !== 'string' || original === '') continue;
    if (original.endsWith(suffix)) continue;
    diffs.push({ key, from: original, to: `${original}${suffix}` });
  }
  return diffs;
}
