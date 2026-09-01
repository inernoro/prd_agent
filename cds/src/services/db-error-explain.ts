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
 * 表找不到时补一句「为什么 + 下一步」；不是这类错误、或请求本来就没带 schema
 * （那说明用的就是当前库，1146 的字面意思已经准确）时原样返回。
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
  if (!isMissingTableOrSchemaError(raw) || !wanted || wanted === database) return raw;
  return [
    `在这个资源上找不到 ${wanted}.${table}：当前连接的是库 ${database}，而请求要的是库 ${wanted}。`,
    '两种可能：这张表在另一台数据库容器上（左侧表列表可能是旧的，刷新一下面板即可）；'
      + '或者当前账号没有那个库的权限。',
    `下一步：刷新工作台重新拉表列表；如果这张表确实属于另一个资源，请到那个资源的工作台打开。`,
    raw ? `原始错误：${raw}` : '',
  ].filter(Boolean).join('\n');
}
