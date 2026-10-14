import mysql, { type FieldPacket, type ResultSetHeader } from 'mysql2';
import pg, { type QueryResult, type FieldDef, type QueryArrayConfig } from 'pg';
import { isUtf8 } from 'node:buffer';
import { SqlConsoleExecutionError, type SqlConsoleResult, type SqlConsoleResultSet } from './sql-console-results.js';
import { isPreviewInstance } from './preview-instance.js';

export interface SqlConsoleOptions {
  runtime: 'mysql' | 'postgres';
  port: number;
  user: string;
  password: string;
  database: string;
  sql: string;
  readOnly: boolean;
  timeoutMs: number;
}

/** Database protocol metadata, rather than CLI display text, is the result boundary. */
export class SqlResultCollector {
  private sets: SqlConsoleResultSet[] = [];
  private records: string[] = [];
  private bytes = 0;
  private truncated = false;
  constructor(private cap = 256 * 1024) {}
  fields(columns: string[]): SqlConsoleResultSet {
    const set = { columns, rows: [] as Array<Array<string | null>>, rowCount: 0 };
    this.bytes += Buffer.byteLength(JSON.stringify(columns));
    this.sets.push(set);
    return set;
  }
  row(set: SqlConsoleResultSet, values: unknown[]): void {
    set.rowCount += 1;
    const row = values.map(value => value === null ? null : Buffer.isBuffer(value) ? (isUtf8(value) ? value.toString('utf8') : `\\x${value.toString('hex')}`) : String(value));
    const size = Buffer.byteLength(JSON.stringify(row));
    if (this.bytes + size > this.cap) { this.truncated = true; return; }
    this.bytes += size;
    set.rows.push(row);
  }
  record(value: string): void {
    const size = Buffer.byteLength(value);
    if (this.bytes + size > this.cap) { this.truncated = true; return; }
    this.bytes += size;
    this.records.push(value);
  }
  result(completed = true): SqlConsoleResult {
    const first = this.sets[0];
    return {
      columns: first?.columns || [], rows: first?.rows || [],
      rowCount: first?.rowCount || 0, resultSets: this.sets,
      output: this.records.join('\n') || (completed ? 'SQL 执行完成。' : 'SQL 执行已停止，未返回完整结果。'), truncated: this.truncated,
    };
  }
}

async function executeMysql(options: SqlConsoleOptions, collector: SqlResultCollector): Promise<void> {
  const control = mysql.createConnection({ host: '127.0.0.1', port: options.port, user: options.user, password: options.password, database: options.database, connectTimeout: Math.min(options.timeoutMs, 10_000) });
  const connection = mysql.createConnection({
    host: '127.0.0.1', port: options.port, user: options.user,
    password: options.password, database: options.database,
    charset: 'utf8mb4', multipleStatements: true, rowsAsArray: true,
    supportBigNumbers: true, bigNumberStrings: true, dateStrings: true,
    // Preserve JSON and numeric text instead of parsing it through JS numbers/objects.
    typeCast: (field, next) => field.type === 'JSON' ? field.string('utf8') : ['DECIMAL', 'NEWDECIMAL', 'LONGLONG', 'LONG', 'INT24', 'SHORT', 'TINY', 'FLOAT', 'DOUBLE'].includes(field.type) ? field.string() : next(),
    connectTimeout: Math.min(options.timeoutMs, 10_000),
  });
  const run = (sql: string, collect: boolean) => new Promise<void>((resolve, reject) => {
    let current: SqlConsoleResultSet | undefined;
    let stopping = false;
    const timer = setTimeout(async () => {
      stopping = true;
      let message = '数据库执行超时，已终止本次会话；已提交修改不会自动回滚，请核对结果后重试。';
      try {
        // A closed client socket does NOT stop a MySQL multi-statement batch. Reserve the
        // control connection before execution so timeout can stop the server's own thread.
        if (Number.isInteger(connection.threadId)) await new Promise<void>((done, fail) => {
          control.query({ sql: `KILL CONNECTION ${connection.threadId}`, timeout: 5_000 }, error => error ? fail(error) : done());
        });
      } catch {
        message = '数据库执行超时，未能确认数据库会话已终止。请先核对执行状态和已提交数据，暂勿重复提交。';
      } finally {
        connection.destroy();
        reject(new Error(message));
      }
    }, options.timeoutMs);
    const query = connection.query({ sql });
    query.on('fields', (fields: FieldPacket[] | undefined) => {
      current = collect && fields ? collector.fields(fields.map(field => field.name)) : undefined;
    });
    query.on('result', (row: unknown) => {
      if (!collect) return;
      if (current) collector.row(current, row as unknown[]);
      else {
        const header = row as ResultSetHeader;
        collector.record(`Query OK, ${header.affectedRows} row affected${header.info ? ` (${header.info})` : ''}`);
      }
    });
    query.on('error', error => { if (!stopping) { clearTimeout(timer); reject(error); } });
    query.on('end', () => { if (!stopping) { clearTimeout(timer); resolve(); } });
  });
  // Never pool these connections: abandoned transactions and session settings must disappear.
  connection.on('error', () => {}); // The pending Query owns the surfaced error.
  control.on('error', () => {});
  try {
    await new Promise<void>((resolve, reject) => control.connect(error => error ? reject(error) : resolve()));
    if (options.readOnly) await run('START TRANSACTION READ ONLY; SELECT 1', false);
    await run(options.sql, true);
  } finally {
    connection.destroy();
    control.destroy();
  }
}

/**
 * pg Query's protocol handlers provide CommandComplete even when a later statement fails.
 * Keep this small adapter separate from SQL policy; it never parses or replays SQL.
 * The pg version is locked and these hooks are exercised against real PostgreSQL.
 */
class ConsolePgQuery extends pg.Query {
  private current?: SqlConsoleResultSet;
  constructor(sql: string, private collector: SqlResultCollector) {
    const config: QueryArrayConfig = { text: sql, rowMode: 'array', types: { getTypeParser: () => (value: string) => value } };
    super(config);
    this.on('row', (row: unknown[]) => { if (this.current) collector.row(this.current, row); });
  }
  handleRowDescription(message: { fields: FieldDef[] }): void {
    this.current = this.collector.fields(message.fields.map(field => field.name));
    (pg.Query.prototype as unknown as { handleRowDescription(message: unknown): void }).handleRowDescription.call(this, message);
  }
  handleCommandComplete(message: { text: string }, connection: unknown): void {
    this.collector.record(message.text);
    this.current = undefined;
    (pg.Query.prototype as unknown as { handleCommandComplete(message: unknown, connection: unknown): void }).handleCommandComplete.call(this, message, connection);
  }
}

async function executePostgres(options: SqlConsoleOptions, collector: SqlResultCollector): Promise<void> {
  const client = new pg.Client({
    host: '127.0.0.1', port: options.port, user: options.user,
    password: options.password, database: options.database,
    connectionTimeoutMillis: Math.min(options.timeoutMs, 10_000),
    statement_timeout: options.timeoutMs,
  });
  client.on('error', () => {});
  const timer = setTimeout(() => { void client.end(); }, options.timeoutMs);
  try {
    await client.connect();
    // Anchor the snapshot before user SQL; transaction_read_only cannot then be turned off.
    if (options.readOnly) await client.query('BEGIN READ ONLY; SELECT 1');
    await new Promise<void>((resolve, reject) => {
      const query = new ConsolePgQuery(options.sql, collector);
      query.on('error', reject);
      query.on('end', (_result: QueryResult) => resolve());
      client.query(query);
    });
  } finally {
    clearTimeout(timer);
    await client.end();
  }
}

export async function executeSqlConsole(options: SqlConsoleOptions): Promise<SqlConsoleResult> {
  if (isPreviewInstance()) throw new Error('CDS 预览实例不连接真实数据库。请返回正式 CDS 控制面执行数据库操作。');
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new Error('数据库缺少内部连接端口，未执行 SQL。');
  }
  const collector = new SqlResultCollector();
  try {
    if (options.runtime === 'mysql') await executeMysql(options, collector);
    else await executePostgres(options, collector);
    return collector.result();
  } catch (error) {
    throw new SqlConsoleExecutionError((error as Error).message, collector.result(false));
  }
}
