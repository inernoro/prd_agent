/**
 * 把数据库返回的裸错误翻译成「为什么 + 下一步」。
 *
 * 目前只放「表找不到」这一类；账号认证失败那一类在 `branch-db-identity.ts`
 * （它需要分支账号身份的上下文），两处都别再各写一份措辞。
 *
 * ## 这条为什么存在（2026-09-01 现场）
 *
 * 工作台左侧表树里点一张表，前端会带上 `schema=<列表时所在的库>`。而 MySQL 这一侧
 * **把 schema 整个丢掉了**：预览拼的是 `SELECT * FROM \`table\``，走的是连接的默认库；
 * 查字段用的是 `TABLE_SCHEMA = DATABASE()`。于是只要「列表所在的库」与「当前连接的库」
 * 不是同一个，点哪张表都是 `ERROR 1146 ... doesn't exist`，而报文里那个库名和用户在
 * 面板上看到的库名对不上，完全没法自己判断发生了什么。
 *
 * 两种真实成因：一是表在**同一台库的另一个 database**（合法，qualify 一下就能读）；
 * 二是表根本在**另一台数据库容器**上（左侧列表是旧的，比如面板开着跨越了一次部署）。
 * 前者已经修成带库名限定，后者拼不出来——那就把话说清楚，别让人对着 1146 猜。
 */

/** MySQL 1146 / 1049、PostgreSQL 42P01：表或库不存在。 */
export function isMissingTableOrSchemaError(message: string): boolean {
  const text = String(message || '');
  return /ERROR\s*1146|ERROR\s*1049|42S02|42P01|Unknown database|doesn'?t exist|does not exist/i.test(text);
}

/**
 * MySQL 1142 / PostgreSQL 42501：库或表存在，但当前账号没权限读。
 *
 * 修完「带库名限定」之后，跨库点表的报文就从「表不存在」变成了这一条（实测：
 * `SELECT command denied to user 'cds_...' for table 'distributed_lock'`）——
 * 它比 1146 准确，但对用户依然是天书，同样要给下一步。
 */
export function isTablePermissionError(message: string): boolean {
  const text = String(message || '');
  return /ERROR\s*1142|ERROR\s*1044|command denied|permission denied for (table|relation|schema)|42501/i.test(text);
}

/**
 * 点表打不开时补一句「为什么 + 下一步」。
 *
 * 只在**请求的库与当前连接的库不是同一个**时才加解释：同库内的 1146 字面意思已经
 * 准确（就是没这张表），再套一段指引只会添乱。
 */
export function explainMissingTable(params: {
  /** 这次连接实际所在的库。 */
  database: string;
  /** 请求里带的 schema（前端从表树带过来的库名）。 */
  requestedSchema?: string;
  table: string;
  rawError: string;
}): string {
  const { database, requestedSchema, table, rawError } = params;
  const raw = String(rawError || '').trim();
  const wanted = String(requestedSchema || '').trim();
  if (!wanted || wanted === database) return raw;
  const missing = isMissingTableOrSchemaError(raw);
  const denied = isTablePermissionError(raw);
  if (!missing && !denied) return raw;
  return [
    denied
      ? `当前账号读不了 ${wanted}.${table}：这个资源的连接在库 ${database} 上，对库 ${wanted} 没有查询权限。`
      : `在这个资源上找不到 ${wanted}.${table}：当前连接的是库 ${database}，而请求要的是库 ${wanted}。`,
    FOREIGN_SCHEMA_CAUSE,
    FOREIGN_SCHEMA_NEXT_STEP,
    raw ? `原始错误：${raw}` : '',
  ].filter(Boolean).join('\n');
}

const FOREIGN_SCHEMA_CAUSE = '常见成因：这张表属于另一个数据库资源，而左侧表列表是旧的（面板开着跨过了一次部署或切换）。';
const FOREIGN_SCHEMA_NEXT_STEP = '下一步：刷新工作台重新拉表列表；如果这张表确实属于另一个资源，到那个资源的工作台打开它。';

/**
 * MySQL 侧请求了**本分支库以外**的库时的拒绝文案（执行之前就拒，不发查询）。
 *
 * 为什么要在执行前拒：MySQL 的 schema 就是 database，一旦允许请求方自带库名，
 * 用回落到服务自带账号（典型是 root）的资源上就能读到同实例里**别的分支、别的项目**
 * 的库，越过了 `mysqlDatabaseForBranch` 这条边界（Codex P1，2026-09-01）。
 * PostgreSQL 的 schema 是库内命名空间，不构成同样的越界，故不受此限。
 */
export function foreignSchemaRefusal(params: { database: string; requestedSchema: string; table: string }): string {
  const { database, requestedSchema, table } = params;
  return [
    `这个资源的工作台只能读它自己的库 ${database}，不能读 ${requestedSchema}.${table}。`,
    FOREIGN_SCHEMA_CAUSE,
    FOREIGN_SCHEMA_NEXT_STEP,
  ].join('\n');
}
