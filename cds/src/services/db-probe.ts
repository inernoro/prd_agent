/**
 * 库探测（收敛 0「可信数据面」，2026-09-03）。
 *
 * 设计文档 doc/design.cds.database-isolation.md 第九节的落地：用户看到的「连着哪个库」
 * 必须是**实测值**，配置推断只能站在旁边当「配置说的」。三列并排，机器给判定：
 *
 *   配置说的   resolveReplicaDbTarget 折算：项目默认 / 分支覆盖 → dbScope → 库名加不加后缀
 *   容器持有   docker inspect 运行中应用容器的真实 env（容器是按**部署那一刻**的配置起的，
 *              配置改了没重部署，这里就会和「配置说的」对不上——最常见的失信来源）
 *   连上的库   进基础设施容器起引擎客户端，用**应用自己的凭据**（拍板 A：从应用容器的
 *              连接串/用户变量取，不扩大凭据可见范围）问一句 current database / 版本 / 表数
 *
 * 判定 judgeDbProbe 是纯函数，原因文案说人话：mismatch 必须指出「容器未按当前配置重新部署」
 * 或「连接串未跟随」，让用户知道该做什么，而不是只看见红。
 *
 * 探测只读：只发 SELECT / db.getName 一类语句，绝不写库（与隔离审计的金丝雀不同）。
 * 报告不落任何密码：凭据经 docker exec -e 注入，argv 里的连接串在报告里不出现。
 */
import type { BranchEntry, BuildProfile, InfraService } from '../types.js';
import type { StateService } from './state.js';
import { runDockerExec, type DockerExecResult } from '../routes/infra-data.js';
import { resolveReplicaDbTarget, type ReplicaDbEngine, type ReplicaDbTarget } from './replica-db-clone.js';
import { resolveEffectiveProfile } from './container.js';

export type DbProbeExec = (argv: string[], stdin: string, timeoutMs?: number, maxBytes?: number) => Promise<DockerExecResult>;

export type DbProbeVerdict = 'match' | 'mismatch' | 'not-running' | 'probe-failed' | 'no-db' | 'not-applicable';

export interface DbProbeConfigured {
  dbScope: 'shared' | 'per-branch';
  dbScopeSource: 'branch-override' | 'baseline' | 'default';
  engine: ReplicaDbEngine | null;
  /** 配置折算出的运行时库名（per-branch 已加后缀）；定位不到为 null */
  dbName: string | null;
  /** 指向该库的 env key（容器持有列按这些 key 读） */
  envKeys: string[];
  infraId: string | null;
  /** 定位失败原因（来自 resolveReplicaDbTarget） */
  reason?: string;
  /** 定位不到时区分：none = 不涉及数据库（正常）；unrecognized = 有疑似变量但认不出（要处理） */
  involvement?: 'db' | 'unrecognized' | 'none';
  suspectEnvKeys?: string[];
}

export interface DbProbeContainer {
  containerName: string | null;
  /** docker State.Status；没有容器记录为 missing；inspect 失败为 unknown */
  status: string;
  running: boolean;
  /** 容器真实 env 里库名 key 的值；多 key 值不一致时取第一个并在 error 里说明 */
  dbName: string | null;
  inspectedAt: string;
  error?: string;
}

export type DbProbeCredentialSource = 'app-url' | 'app-env' | 'infra-root' | 'none';

export interface DbProbeLive {
  /** 是否真的发了探测命令（容器没跑 / 定位不到库时为 false） */
  attempted: boolean;
  ok: boolean;
  currentDb: string | null;
  serverVersion: string | null;
  /** 集合数 / 表数（体量感，判断「这是不是那个库」） */
  objectCount: number | null;
  credentialSource: DbProbeCredentialSource | null;
  error?: string;
  probedAt: string;
}

export interface DbProbeServiceResult {
  profileId: string;
  profileName: string;
  configured: DbProbeConfigured;
  container: DbProbeContainer;
  live: DbProbeLive;
  verdict: DbProbeVerdict;
  reasons: string[];
}

export interface DbProbeReport {
  branchId: string;
  projectId: string;
  branch: string;
  probedAt: string;
  services: DbProbeServiceResult[];
  summary: {
    services: number;
    match: number;
    mismatch: number;
    notRunning: number;
    probeFailed: number;
    noDb: number;
    /** 不涉及数据库的服务（web / 静态），不算缺库 */
    notApplicable: number;
  };
}

const SCOPE_LABEL = { shared: '共享库', 'per-branch': '分支独立库' } as const;

/** 判定：纯函数，可离线单测。顺序即优先级：定位不到 → 没在跑 → 容器与配置不符 → 实测失败 → 连上的与容器不符 → 一致 */
export function judgeDbProbe(
  configured: DbProbeConfigured,
  container: DbProbeContainer,
  live: DbProbeLive,
): { verdict: DbProbeVerdict; reasons: string[] } {
  if (!configured.dbName) {
    if (configured.involvement === 'none') {
      return { verdict: 'not-applicable', reasons: ['没有任何数据库相关变量，不涉及数据库'] };
    }
    return { verdict: 'no-db', reasons: [configured.reason || '配置里定位不到这个服务的数据库'] };
  }
  if (!container.containerName) {
    return {
      verdict: 'not-running',
      reasons: [`这个服务还没有容器（分支尚未部署或该服务未启动），无法实测；配置说的是 ${configured.dbName}（${SCOPE_LABEL[configured.dbScope]}），部署后再看`],
    };
  }
  if (!container.running) {
    return {
      verdict: 'not-running',
      reasons: [`容器 ${container.containerName} 未运行（状态 ${container.status}${container.error ? `，${container.error}` : ''}），无法实测；配置说的是 ${configured.dbName}（${SCOPE_LABEL[configured.dbScope]}）`],
    };
  }
  if (container.dbName !== configured.dbName) {
    return {
      verdict: 'mismatch',
      reasons: [
        `容器实际持有 ${container.dbName ?? '(未设置)'}，配置说的是 ${configured.dbName}（${SCOPE_LABEL[configured.dbScope]}）：容器未按当前配置重新部署，重新部署后才会一致`,
        ...(container.error ? [container.error] : []),
      ],
    };
  }
  if (!live.attempted || !live.ok) {
    return {
      verdict: 'probe-failed',
      reasons: [`实测失败：${live.error || '未发出探测命令'}。容器 env 写的是 ${container.dbName}，但没能连上确认`],
    };
  }
  if (live.currentDb !== container.dbName) {
    return {
      verdict: 'mismatch',
      reasons: [`连上的库是 ${live.currentDb ?? '(空)'}，容器 env 写的是 ${container.dbName}：应用连接串没有跟随库名变量，请检查连接串里的库名段`],
    };
  }
  return { verdict: 'match', reasons: [] };
}

function parseEnvList(lines: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of lines) {
    const idx = line.indexOf('=');
    if (idx > 0) out[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return out;
}

/** docker inspect 一次拿状态 + 真实 env（少一次往返；容器不存在时 code≠0） */
async function inspectContainer(
  exec: DbProbeExec, containerName: string,
): Promise<{ status: string; running: boolean; env: Record<string, string> | null; error?: string }> {
  const r = await exec(['inspect', '-f', '{{.State.Status}}\t{{json .Config.Env}}', containerName], '', 20_000, 64 * 1024);
  if (r.code !== 0) {
    const msg = (r.stderr || r.stdout || '').trim();
    const missing = /No such (object|container)/i.test(msg);
    return { status: missing ? 'missing' : 'unknown', running: false, env: null, error: missing ? '容器不存在' : (msg.slice(0, 200) || 'docker inspect 失败') };
  }
  const raw = r.stdout.trim();
  const tab = raw.indexOf('\t');
  const status = (tab >= 0 ? raw.slice(0, tab) : raw).trim() || 'unknown';
  try {
    const env = parseEnvList(JSON.parse(tab >= 0 ? raw.slice(tab + 1) : '[]') as string[]);
    return { status, running: status === 'running', env };
  } catch {
    return { status, running: status === 'running', env: null, error: 'docker inspect 输出无法解析' };
  }
}

/** 应用连接串里的凭据（拍板 A：优先用应用自己的） */
function credentialsFromUrl(url: string): { user: string; pw: string } | null {
  const m = /^[a-zA-Z][a-zA-Z0-9+.:-]*:\/\/([^/?#@]+)@/.exec(url);
  if (!m) return null;
  const [userRaw, pwRaw = ''] = m[1].split(':');
  const dec = (s: string): string => { try { return decodeURIComponent(s); } catch { return s; } };
  return userRaw ? { user: dec(userRaw), pw: dec(pwRaw) } : null;
}

interface Credential { user: string; pw: string; source: DbProbeCredentialSource; authSource?: string }

function resolveCredential(engine: ReplicaDbEngine, appEnv: Record<string, string>, target: ReplicaDbTarget): Credential {
  // 1. 应用连接串
  const urlKeys = [
    ...Object.keys(target.urlEnvValues || {}),
    ...target.connEnvKeys,
    ...Object.keys(appEnv).filter((k) => /(DATABASE|MYSQL|POSTGRES|PG|MONGO(DB)?|DATASOURCE)_*(URL|URI|CONNECTION_?STRING)$/i.test(k)),
  ];
  for (const key of [...new Set(urlKeys)]) {
    const v = appEnv[key];
    if (!v) continue;
    const c = credentialsFromUrl(v);
    if (c) {
      const authSource = /[?&]authSource=([^&]+)/.exec(v)?.[1];
      return { ...c, source: 'app-url', authSource };
    }
  }
  // 2. 应用 env 里的用户/密码变量（CDS 预设注入的 CDS_MYSQL_USER 等）
  const pairs: Record<ReplicaDbEngine, Array<[string, string]>> = {
    mysql: [['CDS_MYSQL_USER', 'CDS_MYSQL_PASSWORD'], ['MYSQL_USER', 'MYSQL_PASSWORD'], ['DB_USER', 'DB_PASSWORD'], ['DATABASE_USER', 'DATABASE_PASSWORD']],
    postgres: [['CDS_POSTGRES_USER', 'CDS_POSTGRES_PASSWORD'], ['POSTGRES_USER', 'POSTGRES_PASSWORD'], ['PGUSER', 'PGPASSWORD'], ['DB_USER', 'DB_PASSWORD'], ['DATABASE_USER', 'DATABASE_PASSWORD']],
    mongo: [['CDS_MONGO_USER', 'CDS_MONGO_PASSWORD'], ['MONGO_USER', 'MONGO_PASSWORD'], ['MONGO_INITDB_ROOT_USERNAME', 'MONGO_INITDB_ROOT_PASSWORD']],
  };
  for (const [u, p] of pairs[engine]) {
    if (appEnv[u]) return { user: appEnv[u], pw: appEnv[p] || '', source: 'app-env' };
  }
  // 3. 应用 env 里什么凭据都没有：退回基础设施 root（如实标注来源；见拍板 A 的兜底）
  const infraEnv = target.infra.env || {};
  if (engine === 'mysql') {
    const pw = infraEnv.MYSQL_ROOT_PASSWORD || infraEnv.MARIADB_ROOT_PASSWORD || '';
    return { user: 'root', pw, source: pw ? 'infra-root' : 'none' };
  }
  if (engine === 'postgres') {
    const user = infraEnv.POSTGRES_USER || 'postgres';
    return { user, pw: infraEnv.POSTGRES_PASSWORD || '', source: infraEnv.POSTGRES_PASSWORD ? 'infra-root' : 'none' };
  }
  const user = infraEnv.MONGO_INITDB_ROOT_USERNAME || '';
  return { user, pw: infraEnv.MONGO_INITDB_ROOT_PASSWORD || '', source: user ? 'infra-root' : 'none' };
}

function enginePort(engine: ReplicaDbEngine, infra: InfraService): number {
  return infra.containerPort || (engine === 'mysql' ? 3306 : engine === 'postgres' ? 5432 : 27017);
}

const DB_NAME_SAFE = /^[a-zA-Z0-9_]+$/;

/** 只读探测：current database / 版本 / 对象数，三列 tab 分隔 */
async function liveProbe(
  exec: DbProbeExec, engine: ReplicaDbEngine, target: ReplicaDbTarget, dbName: string,
  appEnv: Record<string, string>, probedAt: string,
): Promise<DbProbeLive> {
  const base: DbProbeLive = { attempted: true, ok: false, currentDb: null, serverVersion: null, objectCount: null, credentialSource: null, probedAt };
  if (!DB_NAME_SAFE.test(dbName)) return { ...base, attempted: false, error: `库名含不安全字符，拒绝探测: ${dbName}` };
  const cred = resolveCredential(engine, appEnv, target);
  const c = target.infra.containerName;
  const port = enginePort(engine, target.infra);
  let argv: string[];
  if (engine === 'mysql') {
    argv = ['exec', '-i', '-e', `MYSQL_PWD=${cred.pw}`, c, 'mysql', `-u${cred.user}`, '-h127.0.0.1', `-P${port}`, '-N', '-B', '-e',
      `SELECT DATABASE(), VERSION(), (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE())`, dbName];
  } else if (engine === 'postgres') {
    argv = ['exec', '-i', '-e', `PGPASSWORD=${cred.pw}`, c, 'psql', '-U', cred.user, '-h', '127.0.0.1', '-p', String(port), '-d', dbName, '-t', '-A', '-F', '\t', '-c',
      `SELECT current_database(), current_setting('server_version'), (SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema'))`];
  } else {
    const auth = cred.user ? `${encodeURIComponent(cred.user)}:${encodeURIComponent(cred.pw)}@` : '';
    const authSource = cred.user ? `?authSource=${encodeURIComponent(cred.authSource || 'admin')}` : '';
    const uri = `mongodb://${auth}127.0.0.1:${port}/${dbName}${authSource}`;
    argv = ['exec', '-i', c, 'mongosh', uri, '--quiet', '--eval',
      `print([db.getName(), db.version(), db.getCollectionNames().length].join("\\t"))`];
  }
  const r = await exec(argv, '', 20_000, 16 * 1024);
  const secrets = [cred.pw].filter(Boolean);
  const mask = (s: string): string => secrets.reduce((acc, sec) => acc.split(sec).join('***'), s);
  if (r.code !== 0) {
    const msg = mask((r.stderr || r.stdout || '').trim()).split('\n').filter(Boolean).slice(-3).join(' ');
    return { ...base, credentialSource: cred.source, error: msg.slice(0, 300) || `客户端退出码 ${r.code}` };
  }
  const line = r.stdout.trim().split('\n').filter(Boolean).pop() || '';
  const [currentDb = '', version = '', count = ''] = line.split('\t').map((s) => s.trim());
  if (!currentDb) return { ...base, credentialSource: cred.source, error: '客户端没有返回库名' };
  const n = Number(count);
  return {
    ...base, ok: true, credentialSource: cred.source,
    currentDb, serverVersion: version || null, objectCount: Number.isFinite(n) ? n : null,
  };
}

function scopeSource(profile: BuildProfile, branch: BranchEntry): DbProbeConfigured['dbScopeSource'] {
  if (branch.profileOverrides?.[profile.id]?.dbScope !== undefined) return 'branch-override';
  return profile.dbScope !== undefined ? 'baseline' : 'default';
}

export async function probeBranchDb(
  state: StateService,
  branchId: string,
  opts: { profileId?: string; exec?: DbProbeExec; now?: () => Date } = {},
): Promise<DbProbeReport> {
  const branch = state.getBranch(branchId);
  if (!branch) throw new Error(`分支不存在: ${branchId}`);
  const exec = opts.exec || runDockerExec;
  const now = opts.now || (() => new Date());
  const probedAt = now().toISOString();
  const profiles = state.getEffectiveProfilesForBranch(branch)
    .filter((p) => !opts.profileId || p.id === opts.profileId);
  if (opts.profileId && profiles.length === 0) throw new Error(`服务不存在: ${opts.profileId}`);

  const services: DbProbeServiceResult[] = [];
  for (const baseline of profiles) {
    const effective = resolveEffectiveProfile(baseline, branch);
    // 台账里的基础设施状态不是真相（error 可能只是上次重建失败），定位库时不按它过滤；
    // 容器到底在不在跑，由下面的 docker inspect / 客户端实测说了算。
    const { target, reason, involvement, suspects } = resolveReplicaDbTarget(state, branch, effective, { infraStatus: 'any' });
    const configured: DbProbeConfigured = {
      dbScope: effective.dbScope === 'per-branch' ? 'per-branch' : 'shared',
      dbScopeSource: scopeSource(baseline, branch),
      engine: target?.engine ?? null,
      dbName: target?.sourceDb ?? null,
      envKeys: target?.envKeys ?? [],
      infraId: target?.infra.id ?? null,
      ...(target ? { involvement: 'db' as const } : {
        reason: (reason || '').replace(/，无法定位要隔离的库/, '，无法定位要实测的库'),
        involvement: involvement ?? 'unrecognized',
        suspectEnvKeys: suspects ?? [],
      }),
    };

    const containerName = branch.services?.[baseline.id]?.containerName || null;
    let container: DbProbeContainer = { containerName, status: 'missing', running: false, dbName: null, inspectedAt: now().toISOString() };
    let appEnv: Record<string, string> | null = null;
    if (containerName && configured.involvement !== 'none') {
      const ins = await inspectContainer(exec, containerName);
      appEnv = ins.env;
      const values = configured.envKeys.map((k) => ins.env?.[k]).filter((v): v is string => typeof v === 'string' && v !== '');
      const distinct = [...new Set(values)];
      container = {
        containerName, status: ins.status, running: ins.running,
        dbName: distinct[0] ?? null,
        inspectedAt: now().toISOString(),
        ...(ins.error ? { error: ins.error } : {}),
        ...(distinct.length > 1 ? { error: `容器 env 里库名 key 值不一致: ${configured.envKeys.map((k) => `${k}=${ins.env?.[k] ?? '(未设置)'}`).join(' · ')}` } : {}),
      };
    }

    let live: DbProbeLive = { attempted: false, ok: false, currentDb: null, serverVersion: null, objectCount: null, credentialSource: null, probedAt: now().toISOString() };
    if (target && container.running && container.dbName && appEnv) {
      live = await liveProbe(exec, target.engine, target, container.dbName, appEnv, now().toISOString());
    }

    const { verdict, reasons } = judgeDbProbe(configured, container, live);
    services.push({ profileId: baseline.id, profileName: baseline.name || baseline.id, configured, container, live, verdict, reasons });
  }

  const count = (v: DbProbeVerdict): number => services.filter((s) => s.verdict === v).length;
  return {
    branchId, projectId: branch.projectId, branch: branch.branch, probedAt, services,
    summary: {
      services: services.length,
      match: count('match'), mismatch: count('mismatch'), notRunning: count('not-running'),
      probeFailed: count('probe-failed'), noDb: count('no-db'), notApplicable: count('not-applicable'),
    },
  };
}
