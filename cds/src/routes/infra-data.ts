/**
 * 基础设施数据层操作（Railway 式「数据」面板的后端）
 *
 * 满足需求 #5/#6：对数据库的初始化与查看在 UI 内完成,而不是手动钻进容器。
 * backup/restore 已由 infra-backup.ts 覆盖,本文件补「查询 / 看结构 / 执行 init SQL」。
 *
 * API（项目级 infra,挂在 /api 下,与 infra-backup 同层）：
 *   POST /api/infra/:id/query     在该数据库执行一条只读/任意查询,返回文本输出
 *   GET  /api/infra/:id/schema    列出表 / 集合 / key（按类型给规范化查询）
 *   POST /api/infra/:id/init-sql  执行一段初始化 SQL/脚本（记破坏性操作）
 *
 * 设计要点（呼应 .claude/rules/compute-then-send.md 的「算/发」分离）：
 *   - buildInfraDataExec 是**纯函数**：给定 InfraService + 动作 + SQL,算出 docker exec
 *     的 argv + stdin + 需脱敏的密钥值。无 I/O,可在无 Docker 的环境单测（命令构造是最
 *     易错的部分）。
 *   - 路由处理只负责 spawn docker、喂 stdin、收 stdout、脱敏后返回（这部分需真实容器验证）。
 *
 * 安全：输出里出现的 infra 密码值统一脱敏；整个 /api 已在 CDS 鉴权之后。
 * 无 emoji（CLAUDE.md 规则 0）。
 */
import { Router } from 'express';
import { spawn } from 'node:child_process';
import type { StateService } from '../services/state.js';
import type { IShellExecutor, InfraService } from '../types.js';

export interface InfraDataRouterDeps {
  stateService: StateService;
  shell: IShellExecutor;
  /** Inline project-scope guard. No-op for admin/cookie auth; 403 for a project-scoped key reaching another project. */
  assertProjectAccess: (req: any, projectId: string) => { status: number; body: unknown } | null;
}

export type InfraDataKind = 'postgres' | 'mysql' | 'mongo' | 'redis' | 'clickhouse';
export type InfraDataAction = 'query' | 'schema' | 'init-sql';

/** 按镜像名判定数据库类型;不支持的返回 null。 */
export function detectInfraDataKind(image: string): InfraDataKind | null {
  const l = (image || '').toLowerCase();
  if (l.includes('postgres') || l.includes('timescale')) return 'postgres';
  if (l.includes('mysql') || l.includes('mariadb')) return 'mysql';
  if (l.includes('mongo')) return 'mongo';
  if (l.includes('redis')) return 'redis';
  if (l.includes('clickhouse')) return 'clickhouse';
  return null;
}

/** schema 浏览的规范化查询（redis 特殊处理）。 */
const SCHEMA_QUERY: Record<Exclude<InfraDataKind, 'redis'>, string> = {
  postgres: "SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') ORDER BY 1,2;",
  mysql: 'SHOW TABLES;',
  mongo: 'db.getCollectionNames();',
  clickhouse: 'SHOW TABLES;',
};

export interface InfraDataExec {
  kind: InfraDataKind;
  /** 传给 `docker` 的参数（argv[0] = 'exec'）。 */
  argv: string[];
  /** 通过 stdin 喂给容器内 CLI 的 SQL/命令（避免 shell 引号地狱）。 */
  stdin: string;
  /** 出现在输出里需要脱敏的密钥明文。 */
  secretValues: string[];
}

/**
 * 纯函数：算出对某 infra 执行数据操作的 docker exec 计划。
 * 不支持的类型 / 空 SQL 抛 Error,由调用方转 4xx。
 */
export function buildInfraDataExec(svc: InfraService, action: InfraDataAction, sql: string): InfraDataExec {
  const kind = detectInfraDataKind(svc.dockerImage);
  if (!kind) {
    throw new Error(`暂不支持对该类型基础设施执行数据操作（镜像 ${svc.dockerImage}）。支持：PostgreSQL / MySQL / MongoDB / Redis / ClickHouse。`);
  }
  const c = svc.containerName;
  const env = svc.env || {};
  const body = action === 'schema'
    ? (kind === 'redis' ? 'SCAN 0 COUNT 100' : SCHEMA_QUERY[kind])
    : sql;
  if (action !== 'schema' && !body.trim()) {
    throw new Error('SQL / 命令不能为空');
  }

  if (kind === 'postgres') {
    const user = env.POSTGRES_USER || 'postgres';
    const db = env.POSTGRES_DB || user;
    const pw = env.POSTGRES_PASSWORD || '';
    const argv = ['exec', '-i', '-e', `PGPASSWORD=${pw}`, c, 'psql', '-U', user, '-d', db, '-v', 'ON_ERROR_STOP=1', '-P', 'pager=off'];
    return { kind, argv, stdin: body, secretValues: [pw].filter(Boolean) };
  }
  if (kind === 'mysql') {
    const user = env.MYSQL_USER || 'root';
    const pw = (env.MYSQL_USER ? env.MYSQL_PASSWORD : env.MYSQL_ROOT_PASSWORD) || env.MYSQL_PASSWORD || env.MYSQL_ROOT_PASSWORD || '';
    const db = env.MYSQL_DATABASE || '';
    const argv = ['exec', '-i', c, 'mysql', `-u${user}`, ...(pw ? [`-p${pw}`] : []), '--table', ...(db ? [db] : [])];
    return { kind, argv, stdin: body, secretValues: [pw].filter(Boolean) };
  }
  if (kind === 'mongo') {
    const user = env.MONGO_INITDB_ROOT_USERNAME || '';
    const pw = env.MONGO_INITDB_ROOT_PASSWORD || '';
    // Connect to the app's configured database (not admin) so query/schema/init-sql
    // operate on the user's own data. The root user still authenticates via admin.
    const dbName = svc.dbName || env.MONGO_INITDB_DATABASE || 'app';
    const uri = user
      ? `mongodb://${user}:${pw}@localhost:27017/${dbName}?authSource=admin`
      : `mongodb://localhost:27017/${dbName}`;
    const argv = ['exec', '-i', c, 'mongosh', uri, '--quiet'];
    return { kind, argv, stdin: body, secretValues: [pw].filter(Boolean) };
  }
  if (kind === 'redis') {
    // Honour requirepass: read the password from common env keys and pass -a.
    // --no-auth-warning keeps the "insecure -a" notice out of the returned output.
    const pw = env.REDIS_PASSWORD || env.REDIS_PASS || env.REDISCLI_AUTH || '';
    const argv = ['exec', '-i', c, 'redis-cli', ...(pw ? ['-a', pw, '--no-auth-warning'] : [])];
    return { kind, argv, stdin: body, secretValues: [pw].filter(Boolean) };
  }
  // clickhouse
  const user = env.CLICKHOUSE_USER || 'default';
  const pw = env.CLICKHOUSE_PASSWORD || '';
  const db = env.CLICKHOUSE_DB || 'default';
  const argv = ['exec', '-i', c, 'clickhouse-client', '--user', user, ...(pw ? ['--password', pw] : []), '--database', db, '--multiquery'];
  return { kind, argv, stdin: body, secretValues: [pw].filter(Boolean) };
}

/** 把输出里出现的密钥明文替换成 ***。 */
export function maskSecretValues(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 3) out = out.split(s).join('***');
  }
  return out;
}

export interface DockerExecResult {
  stdout: string;
  stderr: string;
  code: number;
  truncated: boolean;
}

export function runDockerExec(argv: string[], stdin: string, timeoutMs = 30_000, maxBytes = 256 * 1024): Promise<DockerExecResult> {
  return new Promise((resolve) => {
    const proc = spawn('docker', argv, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let truncated = false;
    let settled = false;
    const finish = (r: DockerExecResult) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };
    const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* noop */ } finish({ stdout: out, stderr: err + '\n[超时] 操作被中止（30s）', code: -1, truncated }); }, timeoutMs);
    proc.stdout.on('data', (c: Buffer) => {
      if (out.length < maxBytes) out += c.toString();
      else truncated = true;
    });
    proc.stderr.on('data', (c: Buffer) => { if (err.length < 16 * 1024) err += c.toString(); });
    proc.on('error', (e) => finish({ stdout: out, stderr: `${err}\n${e.message}`, code: -1, truncated }));
    proc.on('close', (code) => finish({ stdout: out, stderr: err, code: code ?? -1, truncated }));
    try { proc.stdin.write(stdin); proc.stdin.end(); } catch { /* noop */ }
  });
}

export function createInfraDataRouter(deps: InfraDataRouterDeps): Router {
  const { stateService, assertProjectAccess } = deps;
  const router = Router();

  async function handle(req: import('express').Request, res: import('express').Response, action: InfraDataAction): Promise<void> {
    // infra id 在多项目下并非全局唯一,带 ?project= 时按项目精确定位(也用于消歧)。
    const projectFilter = typeof req.query.project === 'string' ? req.query.project : null;
    // 省略 ?project= 且该 id 在多个项目存在时,拒绝"全局首个"猜测(admin/cookie 鉴权对所有项目
    // 放行,猜错就会在别的租户库上执行查询/init-sql)。要求显式指定项目。
    if (!projectFilter && stateService.getProjectInfraServicesById(req.params.id).length > 1) {
      res.status(400).json({ error: 'project_required', message: `基础设施 "${req.params.id}" 在多个项目中存在,请用 ?project=<projectId> 指定目标项目后再操作。` });
      return;
    }
    const svc = projectFilter
      ? (stateService.getInfraServicesForProject(projectFilter).find((s) => s.id === req.params.id) || null)
      : stateService.getInfraService(req.params.id);
    if (!svc) {
      res.status(404).json({ error: `基础设施服务不存在: ${req.params.id}` });
      return;
    }
    // 强制项目隔离:这些端点会执行任意查询/初始化 SQL 并回显数据库内容(含应用敏感数据),
    // 项目级 key 必须只能操作自己项目的基础设施,否则 403 project_mismatch。对 admin/cookie
    // 鉴权(无 cdsProjectKey)为 no-op——与 branches.ts / project-compose.ts 同一守卫。
    const mismatch = assertProjectAccess(req, svc.projectId);
    if (mismatch) {
      res.status(mismatch.status).json(mismatch.body as Record<string, unknown>);
      return;
    }
    if (svc.status !== 'running') {
      res.status(409).json({ error: `服务 "${svc.id}" 当前未运行（status=${svc.status}），请先启动再执行数据操作。` });
      return;
    }
    const sql = typeof req.body?.sql === 'string' ? req.body.sql : '';
    if (sql.length > 100 * 1024) {
      res.status(413).json({ error: 'SQL / 命令过长（上限 100KB）' });
      return;
    }
    let plan: InfraDataExec;
    try {
      plan = buildInfraDataExec(svc, action, sql);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }
    const r = await runDockerExec(plan.argv, plan.stdin);
    if (action === 'init-sql' && r.code === 0) {
      stateService.recordDestructiveOp({
        type: 'purge-database',
        summary: `对 ${svc.id} 执行初始化 SQL（${plan.kind}）`,
      });
    }
    res.json({
      kind: plan.kind,
      exitCode: r.code,
      truncated: r.truncated,
      output: maskSecretValues(r.stdout, plan.secretValues),
      error: r.code === 0 ? null : maskSecretValues(r.stderr, plan.secretValues),
    });
  }

  router.post('/infra/:id/query', (req, res) => { void handle(req, res, 'query'); });
  router.get('/infra/:id/schema', (req, res) => { void handle(req, res, 'schema'); });
  router.post('/infra/:id/init-sql', (req, res) => { void handle(req, res, 'init-sql'); });

  return router;
}
