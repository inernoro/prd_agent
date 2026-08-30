/**
 * MySQL 连接上限兜底（2026-08-29）。
 *
 * 事故：mdimp 项目的两台 MySQL 都跑在 `mysql:8.0` 出厂默认 `max_connections=151` 上。
 * CDS 把同一个项目的 N 个分支预览复用到这一台 MySQL，而每个分支有 5 个 Java 服务、
 * 每个服务连三个库（业务 / Key Vault / 供应商生态）各开一个 Hikari 池——单个分支就要
 * 上百个连接。实测五个分支全起来时 `Max_used_connections=294`，**旧上限连一半都不够**。
 *
 * 撞穿之后的形态很难认：抢到连接的分支活下来，抢输的 Flyway 迁移直接 502/超时、被
 * CDS 标 error 不再重试；死掉反而把连接还回去，于是**事后去查时 MySQL 又是空闲的**，
 * 看起来完全不像连接问题。当时绕了好几轮才从容器日志里挖到
 * `FlywaySqlException: Unable to obtain connection from database: Too many connections`。
 *
 * 为什么兜底该由 CDS 出：**把 N 个分支复用到一台数据库是 CDS 的编排决定**，
 * 项目方的 compose 里通常压根没声明这台 infra，也无从知道自己会被复用几份。
 * 谁制造了扇出，谁负责给出与扇出匹配的默认值。
 *
 * 兜底不是覆盖：项目显式写了 `--max-connections`（或 `--max_connections`、
 * 空格分隔形式）就一律尊重，本模块只在「谁都没说」时补一个。
 */

/** 默认上限。1000 个空闲连接在 MySQL 8 上的常驻开销是几十 MB 量级，代价可接受。 */
export const DEFAULT_MYSQL_MAX_CONNECTIONS = 1000;

/** 系统级逃生阀：设为 0 / off / false 即完全不注入。 */
export function resolveConfiguredMysqlMaxConnections(
  raw = process.env.CDS_MYSQL_MAX_CONNECTIONS,
): number | null {
  const value = String(raw ?? '').trim().toLowerCase();
  if (!value) return DEFAULT_MYSQL_MAX_CONNECTIONS;
  if (value === '0' || value === 'off' || value === 'false' || value === 'no') return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MYSQL_MAX_CONNECTIONS;
  return parsed;
}

/** 是不是 MySQL / MariaDB 家族的镜像（含私有 registry 前缀与自建派生镜像）。 */
export function isMysqlFamilyImage(dockerImage: string): boolean {
  const image = String(dockerImage ?? '').trim().toLowerCase();
  if (!image) return false;
  // 先去 digest，再取最后一段，最后才剥 tag。
  // 顺序不能反：registry 主机名里的端口冒号（registry.internal:5000/team/mysql:8.0）
  // 会让「先按冒号切」把仓库名截成 `registry.internal`，判据直接失效。
  // Docker 引用规范里，只有最后一个斜杠之后的冒号才是 tag 分隔符。
  const withoutDigest = image.split('@')[0];
  const lastPathSegment = withoutDigest.split('/').pop() || withoutDigest;
  const lastSegment = lastPathSegment.split(':')[0];
  return lastSegment === 'mysql'
    || lastSegment === 'mariadb'
    || lastSegment === 'percona'
    || lastSegment.startsWith('mysql-')
    || lastSegment.endsWith('-mysql');
}

/**
 * 命令里是否已经声明过连接上限。
 *
 * 判据必须认全三种等价写法，否则「项目明明配了、CDS 又追加一个」会让后写的那个
 * 静默生效——正是 predicate-and-wiring-discipline 形状 6「判据读的值不是真正生效的值」。
 * MySQL 的选项名中横线与下划线等价（`--max-connections` == `--max_connections`），
 * 且允许 `--opt value` 与 `--opt=value` 两种分隔。
 */
export function declaresMaxConnections(command: string | string[] | undefined): boolean {
  if (command === undefined) return false;
  const parts = Array.isArray(command) ? command.map((c) => String(c)) : [String(command)];
  return parts.some((part) => /--max[-_]connections(\s|=|$)/i.test(part));
}

/**
 * 追加参数是否安全。
 *
 * 只在「这些参数确实会被 mysqld 收到」时才追加：
 *   - 没有 command：镜像入口默认起 mysqld，追加的 flag 会被 entrypoint 接住。
 *   - command 每一项都是 flag（以 `-` 开头）：mysql 官方镜像 entrypoint 见首参为 `-`
 *     会自动补 `mysqld`，追加安全。
 *   - command 首项就是 mysqld：显式起库，追加安全。
 *
 * 其余一律不碰。典型反例：`["sh","-c","..."]`（追加会变成 sh 的参数）、
 * 字符串形态的 command（yaml 里通常是整段 shell 语法，追加等于改写别人的脚本）。
 */
export function canAppendMysqldFlag(
  command: string | string[] | undefined,
  entrypoint: string | string[] | undefined,
): boolean {
  // 自定义 entrypoint 时无从判断参数会交给谁，一律不碰。
  if (entrypoint !== undefined) return false;
  if (command === undefined) return true;
  if (!Array.isArray(command)) return false;
  if (command.length === 0) return true;
  const parts = command.map((c) => String(c).trim()).filter((c) => c.length > 0);
  if (parts.length === 0) return true;
  if (parts.every((p) => p.startsWith('-'))) return true;
  return parts[0] === 'mysqld' || parts[0].endsWith('/mysqld');
}

export interface MysqlConnectionDefaultResult {
  command: string | string[] | undefined;
  /** 实际注入的上限；null 表示这次没注入。 */
  injected: number | null;
  /** 没注入时的原因，便于日志与测试断言。 */
  skippedReason?: 'not-mysql' | 'disabled' | 'already-declared' | 'unsafe-command-shape';
}

/**
 * 给 MySQL 基础设施补一个与 CDS 扇出匹配的连接上限。只兜底，不覆盖。
 */
export function applyMysqlConnectionDefaults(input: {
  dockerImage: string;
  command: string | string[] | undefined;
  entrypoint?: string | string[] | undefined;
  configuredMax?: number | null;
}): MysqlConnectionDefaultResult {
  const { dockerImage, command, entrypoint } = input;
  const configuredMax = input.configuredMax === undefined
    ? resolveConfiguredMysqlMaxConnections()
    : input.configuredMax;

  if (!isMysqlFamilyImage(dockerImage)) {
    return { command, injected: null, skippedReason: 'not-mysql' };
  }
  if (configuredMax === null) {
    return { command, injected: null, skippedReason: 'disabled' };
  }
  if (declaresMaxConnections(command)) {
    return { command, injected: null, skippedReason: 'already-declared' };
  }
  if (!canAppendMysqldFlag(command, entrypoint)) {
    return { command, injected: null, skippedReason: 'unsafe-command-shape' };
  }

  const existing = command === undefined
    ? []
    : (Array.isArray(command) ? command.map((c) => String(c)) : []);
  return {
    command: [...existing, `--max-connections=${configuredMax}`],
    injected: configuredMax,
  };
}
