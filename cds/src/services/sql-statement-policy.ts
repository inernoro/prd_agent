/**
 * 数据工作台的 SQL 语句准入策略（唯一判定源）。
 *
 * ## 为什么要有这一份
 *
 * 工作台把 SQL 分两条路走：只读的进 `/data/query`，会改数据的进 `/data/query-write`
 * （要 data-write 权限 + 输入资源名二次确认）。判「这条是读还是写」的规则此前**抄了三份**：
 * 后端两个 normalize 函数各一份、前端 `sqlCommandIsReadOnly` 再一份。三份各自漂移的结果是
 * 一批**两条路都不收**的正常语句——最典型的是 CTE：`WITH x AS (...) SELECT ...` 的语句头
 * 是 `with`，不在只读白名单里，于是被丢进写路径；写白名单里也没有 `with`，于是被拒。
 * 用户看到的就是「明明是个查询，工作台说不支持」。
 *
 * 现在判据只有这一份，前端那份由守卫测试钉着必须与它逐字一致。
 *
 * ## 放行到什么程度
 *
 * 这是给**自己项目的库**用的管理面板，不是给公网的查询框。DDL（create/alter/drop/rename）、
 * DML（insert/update/delete/truncate）、账号维护（grant/revoke/alter user）、维护动作
 * （analyze/optimize/repair/flush）一律放行——它们本来就是用户要在这块面板上干的活，
 * 拦下来只会逼他去别处开一个 mysql 客户端，安全性没多一分。
 *
 * 唯一无条件拦死的是**把数据库当跳板去读写宿主文件系统**的那几个：
 * `INTO OUTFILE` / `INTO DUMPFILE` / `LOAD DATA` / `LOAD_FILE()` / `COPY ... PROGRAM` /
 * `pg_read_file` 等。它们越过的是数据库边界，不是数据边界，与「用户能不能改自己的数据」无关。
 */

/** 只读语句头。 */
export const READ_STATEMENT_HEADS: readonly string[] = [
  'select', 'show', 'describe', 'desc', 'explain', 'with', 'table', 'values',
];

/**
 * 会改数据 / 改结构 / 改账号的语句头。走写路径（权限 + 二次确认）。
 * 事务与会话控制（begin/commit/set）也在这里：它们不是只读，放进读路径会让人误以为安全。
 */
export const WRITE_STATEMENT_HEADS: readonly string[] = [
  'insert', 'update', 'delete', 'replace', 'merge', 'upsert',
  'create', 'alter', 'drop', 'truncate', 'rename', 'comment',
  'call', 'do', 'set', 'use', 'reset',
  'grant', 'revoke',
  'analyze', 'optimize', 'repair', 'check', 'checksum', 'vacuum', 'refresh', 'reindex',
  'flush', 'lock', 'unlock',
];

/**
 * 事务控制：**两条通道都不收**。
 *
 * 每次执行都是一个新的 `mysql` / `psql` 进程，而单语句限制又不允许把事务和它包住的
 * 操作一起发过来。于是 `BEGIN` 成功、`UPDATE` 在另一个连接里自动提交、`ROLLBACK` 也
 * 成功——三条全绿，数据却改了回不去。这不是「拦一个危险操作」，是**不能给出一个假的
 * 安全信号**（Codex P1，2026-09-01）。真要用事务，整段脚本走「初始化 SQL」：那边是
 * 一个进程跑完整个脚本，BEGIN ... COMMIT 才真的成立。
 */
export const TRANSACTION_CONTROL_HEADS: readonly string[] = [
  'begin', 'start', 'commit', 'rollback', 'savepoint', 'release',
];

/** 越过数据库边界去碰宿主文件系统 / 外部进程的写法，两条路都不收。 */
const HOST_ESCAPE_PATTERNS: readonly RegExp[] = [
  /\binto\s+outfile\b/i,
  /\binto\s+dumpfile\b/i,
  /\bload\s+data\b/i,
  /\bload_file\s*\(/i,
  /\bcopy\b[\s\S]*\bprogram\b/i,
  /\bpg_read_file\b/i,
  /\bpg_read_binary_file\b/i,
  /\bpg_ls_dir\b/i,
];

/** 只读路径额外要拦的写关键字：CTE 后面可以跟 DELETE/UPDATE（PostgreSQL），头是 `with` 也不代表只读。 */
const WRITE_KEYWORDS_IN_READ_PATH = /\b(insert|update|delete|drop|alter|create|truncate|replace|grant|revoke|call|lock|unlock)\b/i;

export type SqlStatementKind = 'read' | 'write' | 'unknown';

export interface SqlStatementClassification {
  /** 语句头（小写）；取不到时为空串。 */
  head: string;
  kind: SqlStatementKind;
}

/** 去掉尾分号与首尾空白后的语句体。 */
export function normalizeStatementBody(sql: string): string {
  return String(sql ?? '').trim().replace(/;+$/g, '').trim();
}

export function classifySqlStatement(sql: string): SqlStatementClassification {
  const body = normalizeStatementBody(sql);
  const head = body.match(/^\s*([a-z]+)/i)?.[1]?.toLowerCase() || '';
  if (READ_STATEMENT_HEADS.includes(head)) {
    // 改数据的 CTE（PostgreSQL 的 `WITH x AS (DELETE ... RETURNING *) SELECT ...`）语句头
    // 也是 with，但它是写。只看语句头会把它判成读，而读通道又因为含 DELETE 拒收——
    // 两条路都不收，这条合法语句就没地方跑了（Codex P2，2026-09-01）。
    if (WRITE_KEYWORDS_IN_READ_PATH.test(body)) return { head, kind: 'write' };
    return { head, kind: 'read' };
  }
  if (WRITE_STATEMENT_HEADS.includes(head)) return { head, kind: 'write' };
  return { head, kind: 'unknown' };
}

/** 命中宿主逃逸写法就抛；两条路径共用。 */
export function assertNoHostEscape(sql: string): void {
  for (const pattern of HOST_ESCAPE_PATTERNS) {
    if (pattern.test(sql)) {
      throw new Error('检测到读写宿主文件或调用外部进程的 SQL（如 INTO OUTFILE / LOAD DATA / COPY ... PROGRAM），已拒绝执行。');
    }
  }
}

function transactionControlError(): Error {
  return new Error(
    '事务控制语句（BEGIN / COMMIT / ROLLBACK / SAVEPOINT）在这里不成立：每次执行都是一条独立连接，'
    + 'BEGIN 之后的语句会在别的连接里自动提交，ROLLBACK 也回滚不了任何东西——三条都会「成功」，数据却改了回不去。'
    + '要用事务，请把整段脚本放进工作台的「初始化 SQL」一起执行（那边是同一个进程跑完整个脚本）。',
  );
}

function assertSingleStatement(body: string, label: string): void {
  if (body.includes(';')) {
    throw new Error(`${label}一次只允许执行一条语句；要跑多条语句请用工作台的「初始化 SQL」输入框。`);
  }
}

/**
 * 只读路径：语句头必须在只读白名单里，且整条语句不含写关键字
 * （挡住 `WITH ... DELETE`、`SELECT ... FOR UPDATE` 这类披着读皮的写）。
 */
export function normalizeReadOnlyStatement(sql: string): string {
  const body = normalizeStatementBody(sql);
  if (!body) throw new Error('SQL 不能为空');
  if (body.length > 20_000) throw new Error('SQL 过长（上限 20KB）');
  assertSingleStatement(body, '只读 SQL Console ');
  if (TRANSACTION_CONTROL_HEADS.includes(classifySqlStatement(body).head)) throw transactionControlError();
  const { head, kind } = classifySqlStatement(body);
  if (kind !== 'read') {
    throw new Error(`只读通道只接受 ${READ_STATEMENT_HEADS.join(' / ').toUpperCase()}；"${head || body.slice(0, 12)}" 属于写操作，请走写 SQL 通道。`);
  }
  assertNoHostEscape(body);
  return body;
}

/**
 * 写路径：语句头必须在写白名单里（只读语句不该走这条，避免绕过读路径的关键字检查）。
 */
export function normalizeWriteStatement(sql: string): string {
  const body = normalizeStatementBody(sql);
  if (!body) throw new Error('SQL 不能为空');
  if (body.length > 20_000) throw new Error('SQL 过长（上限 20KB）');
  assertSingleStatement(body, '写 SQL ');
  const { head, kind } = classifySqlStatement(body);
  if (TRANSACTION_CONTROL_HEADS.includes(head)) throw transactionControlError();
  if (kind === 'read') {
    throw new Error('这条是只读语句，请走只读通道执行。');
  }
  if (kind !== 'write') {
    throw new Error(`无法识别的语句 "${head || body.slice(0, 12)}"，已拒绝执行。`);
  }
  assertNoHostEscape(body);
  return body;
}
