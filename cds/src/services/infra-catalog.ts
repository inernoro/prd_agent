/**
 * Infrastructure Catalog — single source of truth (SSOT) for CDS infra presets.
 *
 * Why this file exists
 * --------------------
 * Before this module the infra presets lived in THREE disconnected places:
 *   1. cds/src/routes/projects.ts  -> createInfraPreset() (5 hard-coded if-blocks)
 *   2. .claude/skills/cds/cli/cdscli.py -> _INFRA_TEMPLATES (13 templates)
 *   3. cds/web/src/pages/{BranchTopologyPage,ProjectListPage}.tsx (mirrored picker lists)
 * Adding one infra type meant editing all three, and they drifted (e.g. NATS/Kafka
 * existed in the CLI but the backend could not persist them).
 *
 * This registry is the backend SSOT. The runtime path (projects.ts) reads it to build
 * concrete InfraService env + connection strings, and GET /api/infra/catalog exposes a
 * secret-free view so the frontend renders the picker WITHOUT hard-coding images/ports.
 *
 * Adding a NEW infra type now = ONE entry below. No other backend edits required.
 * (Frontend picks it up automatically via the catalog endpoint.)
 *
 * Follows the Registry Pattern (.claude/rules/frontend-architecture.md) and the
 * compose contract (doc/spec.cds.compose-contract.md). Connection-env var NAMES are
 * intentionally kept identical to the historical backend behaviour (MONGODB_URL /
 * DATABASE_URL / REDIS_URL / RABBITMQ_URL) so existing projects keep working.
 *
 * No emoji anywhere (CLAUDE.md rule 0).
 */

/** Coarse grouping used by the visual picker (Railway-style "add a database / cache / queue"). */
export type InfraCategory = 'database' | 'cache' | 'queue' | 'search' | 'storage' | 'config' | 'other';

/** Result returned to the runtime caller (projects.ts) — same shape it consumed before. */
export interface InfraPresetDefinition {
  id: string;
  name: string;
  dockerImage: string;
  containerPort: number;
  /** Environment variables for the infra container itself. */
  env?: Record<string, string>;
  /** App-visible connection strings to inject into the project's customEnv. */
  envVars?: Record<string, string>;
  /** Optional container start command (minio / kafka need one). */
  command?: string | string[];
  /**
   * Optional `docker --entrypoint` override.
   *
   * 只有一个用途：镜像的 ENTRYPOINT 是**二进制本身**（nats 就是这样）时，没有 shell
   * 可以展开 `$VAR`，口令只能写成明文进 argv——那会摆进宿主 `ps`。覆盖成 `sh`
   * 再 `exec` 回去，口令就只在容器内展开。docker 的 `--entrypoint` 只接一个 token，
   * 余下部分放 command（见 types.ts BuildProfile.entrypoint 的注释）。
   */
  entrypoint?: string | string[];
  /** Optional docker labels (readiness hints for non-HTTP services). */
  labels?: Record<string, string>;
}

/** A single catalog entry. Pure data + one pure builder for secret-bearing fields. */
export interface InfraCatalogEntry {
  id: string;
  name: string;
  category: InfraCategory;
  /** Short Chinese description for the picker card. */
  description: string;
  dockerImage: string;
  containerPort: number;
  /** Container paths that need a persistent named volume. Empty = ephemeral. */
  volumePaths: string[];
  /** Schema-ful store: app usually needs a migration/init step before first use. */
  schemaful?: boolean;
  /** This store has a named database the user may customise (default "app"). */
  supportsDbName?: boolean;
  /** Initialization SQL/commands can be run against this store (via the data panel). */
  supportsInitSql?: boolean;
  /** Optional container start command. */
  command?: string | string[];
  /** Optional `docker --entrypoint` override. See InfraPresetDefinition.entrypoint. */
  entrypoint?: string | string[];
  /** Optional docker labels. */
  labels?: Record<string, string>;
  /** Secret keys to generate (hex) before calling build(). */
  secretKeys?: string[];
  /**
   * Pure builder: given freshly generated secrets (and optional per-instance options
   * like a custom database name), return the container env and the app-visible
   * connection envVars. Must not perform I/O. The infra container is reachable on the
   * project docker network by its `id` as hostname.
   */
  build: (secrets: Record<string, string>, opts?: InfraBuildOptions) => { env?: Record<string, string>; envVars?: Record<string, string> };
}

/** Per-instance build options threaded from the create/add-infra request. */
export interface InfraBuildOptions {
  /** Custom database name (defaults to "app"). Only honoured by schemaful stores. */
  dbName?: string;
}

/** Normalise a user-supplied database name to a safe identifier; fall back to "app". */
export function sanitizeDbName(raw: string | undefined): string {
  const cleaned = (raw || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^_+|_+$/g, '').slice(0, 48);
  return cleaned || 'app';
}

/**
 * Derive the customEnv connection entries for one same-type instance.
 * - idx 0 (first instance): byte-identical to the catalog build (var names + host unchanged) → full backward compat.
 * - idx > 0 (2nd+ instance): var name gets a `_${idx+1}` suffix, AND the connection host (the base preset
 *   alias, e.g. `@postgres:`) is rewritten to the instance alias (`@postgres-2:`) so the app reaches THIS
 *   instance's own container. This is what lets a project hold two databases of the same type with
 *   independent connection strings.
 */
export function instanceConnectionEnv(
  envVars: Record<string, string>,
  basePresetId: string,
  instanceId: string,
  idx: number,
): Record<string, string> {
  const out: Record<string, string> = {};
  const suffix = idx === 0 ? '' : `_${idx + 1}`;
  for (const [key, value] of Object.entries(envVars)) {
    out[`${key}${suffix}`] = idx === 0 ? value : value.split(`@${basePresetId}:`).join(`@${instanceId}:`);
  }
  return out;
}

/**
 * SQL Server's default password policy requires 3 of 4 character classes. Hex secrets
 * only cover lower+digit, so we append a fixed complexity suffix.
 */
function sqlServerComplexPassword(raw: string): string {
  return `${raw}Aa1_`;
}

export const INFRA_CATALOG: InfraCatalogEntry[] = [
  // ---- databases ----
  {
    id: 'mongodb',
    name: 'MongoDB',
    category: 'database',
    description: '文档型数据库，自动注入 MONGODB_URL 连接串。',
    dockerImage: 'mongo:7',
    containerPort: 27017,
    volumePaths: ['/data/db'],
    supportsDbName: true,
    supportsInitSql: true,
    secretKeys: ['password'],
    build: (s, o) => {
      const db = sanitizeDbName(o?.dbName);
      return {
        env: {
          MONGO_INITDB_ROOT_USERNAME: 'app',
          MONGO_INITDB_ROOT_PASSWORD: s.password,
          MONGO_INITDB_DATABASE: db,
        },
        envVars: {
          MONGODB_URL: `mongodb://app:${s.password}@mongodb:27017/${db}?authSource=admin`,
        },
      };
    },
  },
  {
    id: 'postgres',
    name: 'PostgreSQL',
    category: 'database',
    description: '关系型数据库，自动注入 DATABASE_URL / POSTGRES_URL。',
    dockerImage: 'postgres:16-alpine',
    containerPort: 5432,
    volumePaths: ['/var/lib/postgresql/data'],
    schemaful: true,
    supportsDbName: true,
    supportsInitSql: true,
    secretKeys: ['password'],
    build: (s, o) => {
      const db = sanitizeDbName(o?.dbName);
      const url = `postgresql://app:${s.password}@postgres:5432/${db}`;
      return {
        env: {
          POSTGRES_USER: 'app',
          POSTGRES_PASSWORD: s.password,
          POSTGRES_DB: db,
        },
        envVars: {
          DATABASE_URL: url,
          POSTGRES_URL: url,
        },
      };
    },
  },
  {
    id: 'mysql',
    name: 'MySQL',
    category: 'database',
    description: '关系型数据库，自动注入 DATABASE_URL / MYSQL_URL。',
    dockerImage: 'mysql:8',
    containerPort: 3306,
    volumePaths: ['/var/lib/mysql'],
    schemaful: true,
    supportsDbName: true,
    supportsInitSql: true,
    secretKeys: ['rootPassword', 'password'],
    build: (s, o) => {
      const db = sanitizeDbName(o?.dbName);
      const url = `mysql://app:${s.password}@mysql:3306/${db}`;
      return {
        env: {
          MYSQL_ROOT_PASSWORD: s.rootPassword,
          MYSQL_DATABASE: db,
          MYSQL_USER: 'app',
          MYSQL_PASSWORD: s.password,
        },
        envVars: {
          DATABASE_URL: url,
          MYSQL_URL: url,
        },
      };
    },
  },
  {
    id: 'mariadb',
    name: 'MariaDB',
    category: 'database',
    description: 'MySQL 协议兼容的关系型数据库，自动注入 DATABASE_URL / MYSQL_URL。',
    dockerImage: 'mariadb:11',
    containerPort: 3306,
    volumePaths: ['/var/lib/mysql'],
    schemaful: true,
    supportsDbName: true,
    supportsInitSql: true,
    secretKeys: ['rootPassword', 'password'],
    // mariadb 官方镜像同时识别 MYSQL_* 与 MARIADB_* 变量;沿用 MYSQL_* 让数据面板/备份
    // (按 mysql 协议识别)与 mysql 预设走同一套读取逻辑,零下游改动。连接串走 mysql:// 协议。
    build: (s, o) => {
      const db = sanitizeDbName(o?.dbName);
      const url = `mysql://app:${s.password}@mariadb:3306/${db}`;
      return {
        env: {
          MYSQL_ROOT_PASSWORD: s.rootPassword,
          MYSQL_DATABASE: db,
          MYSQL_USER: 'app',
          MYSQL_PASSWORD: s.password,
        },
        envVars: {
          DATABASE_URL: url,
          MYSQL_URL: url,
        },
      };
    },
  },
  {
    id: 'sqlserver',
    name: 'SQL Server',
    category: 'database',
    description: 'Microsoft SQL Server，自动注入 SQLSERVER_URL（ADO.NET 连接串）。',
    dockerImage: 'mcr.microsoft.com/mssql/server:2022-latest',
    containerPort: 1433,
    volumePaths: ['/var/opt/mssql'],
    schemaful: true,
    secretKeys: ['saPassword'],
    build: (s) => {
      const pw = sqlServerComplexPassword(s.saPassword);
      return {
        env: {
          ACCEPT_EULA: 'Y',
          MSSQL_SA_PASSWORD: pw,
          MSSQL_PID: 'Developer',
        },
        envVars: {
          SQLSERVER_URL: `Server=sqlserver,1433;Database=master;User Id=sa;Password=${pw};TrustServerCertificate=True;`,
        },
      };
    },
  },
  {
    id: 'clickhouse',
    name: 'ClickHouse',
    category: 'database',
    description: '列式分析数据库，自动注入 CLICKHOUSE_URL（HTTP 接口）。',
    dockerImage: 'clickhouse/clickhouse-server:24-alpine',
    containerPort: 8123,
    volumePaths: ['/var/lib/clickhouse'],
    supportsDbName: true,
    supportsInitSql: true,
    secretKeys: ['password'],
    build: (s, o) => {
      const db = sanitizeDbName(o?.dbName);
      return {
        env: {
          CLICKHOUSE_USER: 'app',
          CLICKHOUSE_PASSWORD: s.password,
          CLICKHOUSE_DB: db,
          CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT: '1',
        },
        envVars: {
          CLICKHOUSE_URL: `http://app:${s.password}@clickhouse:8123/${db}`,
        },
      };
    },
  },
  // ---- caches ----
  {
    id: 'redis',
    name: 'Redis',
    category: 'cache',
    description: '内存键值缓存，自动注入带口令的 REDIS_URL。',
    dockerImage: 'redis:7-alpine',
    containerPort: 6379,
    volumePaths: ['/data'],
    secretKeys: ['password'],
    /**
     * 口令经 **env** 交给容器内的 sh 展开，不写进 `docker run` 的命令行；
     * 展开之后**必须再经过镜像自己的 entrypoint**。
     *
     * 两件事缺一不可：
     *
     * 1. 值不进命令行。写成 `--requirepass <明文>` 的话，这串密钥会进宿主的 `ps`、
     *    进 CDS 记录的 docker run 字符串、进容器事件日志。用 `$REDIS_PASSWORD`
     *    （**不带花括号**）能原样活到容器里再展开——CDS 的模板替换只认 `${VAR}`
     *    形态。数组形态保证每个 token 单独 shell-quote，值里有特殊字符也不破坏结构
     *    （2026-05-29 栽过：command 没过模板替换，`--requirepass` 拿到空值让 redis
     *    FATAL 无限重启）。
     * 2. **不能把 entrypoint 顶掉**。官方镜像的 `docker-entrypoint.sh` 只在第一个
     *    参数是 `redis-server` 时才走那条分支：把 `/data` 的属主修成 `redis`、
     *    然后降权到 `redis` 用户再启动。直接 `sh -c 'exec redis-server …'` 会让
     *    entrypoint 看到 `$1 = sh`，走兜底的 `exec "$@"`——**redis 以 root 运行**，
     *    持久化文件也变成 root 属主。所以这里在 sh 里显式再调一次 entrypoint，
     *    让它拿到 `redis-server` 这个第一参数，降权逻辑照常生效。
     *
     * 这一条的判据只能靠真容器（见 `redis-preset-privilege.docker.test.ts`）：
     * 扫命令字符串证明不了进程最终以谁的身份在跑。
     */
    command: ['sh', '-c', 'exec docker-entrypoint.sh redis-server --requirepass "$REDIS_PASSWORD"'],
    build: (s) => ({
      env: {
        // 键名跟着既有消费方走：数据面板、备份探测、连接串脱敏都已经在读这三个
        // 名字里的 REDIS_PASSWORD，另起一个新名字等于让它们全部漏认。
        REDIS_PASSWORD: s.password,
      },
      envVars: {
        REDIS_URL: `redis://:${s.password}@redis:6379`,
      },
    }),
  },
  {
    id: 'memcached',
    name: 'Memcached',
    category: 'cache',
    description: '高速内存缓存（已开启 ASCII 协议认证），自动注入 MEMCACHED_URL 与账号口令。',
    dockerImage: 'memcached:1-alpine',
    containerPort: 11211,
    volumePaths: [],
    secretKeys: ['password'],
    /**
     * memcached 默认**完全没有认证**：连上端口就能读写全部缓存。
     *
     * 用 `-Y <file>`（ASCII 协议认证）而不是 SASL：SASL 要在容器里装 cyrus-sasl
     * 并用 `saslpasswd2` 建库，alpine 镜像里两样都没有，等于要换镜像；`-Y` 是标准
     * 构建自带的，只要一个 `user:pass` 文本文件。
     *
     * 口令**不进命令行**：文件由容器内的 sh 从 env 里现写（`$MEMCACHED_PASSWORD`
     * 不带花括号，才能躲过 CDS 只认 `${VAR}` 的模板替换、原样活到容器里）。
     * 写完之后必须**再经过镜像自己的 entrypoint**：它只在 `$1 = memcached` 时才
     * `su-exec memcache` 降权，直接 `exec memcached` 会让进程以 root 跑
     * （redis 预设踩过同一个坑，见上面那段注释）。
     *
     * 权限用 644 不用 600：文件由 root 写、由降权后的 memcache 读，600 会读不到。
     * 它只存在于容器内的 tmpfs 路径上。
     *
     * **已知边界**：ASCII 认证要求客户端会走这套握手，很多 memcached 客户端只实现了
     * SASL 二进制认证。所以账号口令一并注入到项目环境变量里（MEMCACHED_USER /
     * MEMCACHED_PASSWORD），让客户端配得上；接不上的客户端只能换库或换镜像——
     * 这比「谁都能连」好，但不是零成本，记在 debt.cds.md E16。
     */
    entrypoint: 'sh',
    command: ['-c',
      'set -e; printf "%s:%s\\n" "$MEMCACHED_USER" "$MEMCACHED_PASSWORD" > /tmp/cds-memcached.auth;'
      + ' chmod 644 /tmp/cds-memcached.auth;'
      + ' exec docker-entrypoint.sh memcached -Y /tmp/cds-memcached.auth'],
    build: (s) => ({
      env: {
        MEMCACHED_USER: 'app',
        MEMCACHED_PASSWORD: s.password,
      },
      envVars: {
        MEMCACHED_URL: 'memcached:11211',
        MEMCACHED_USER: 'app',
        MEMCACHED_PASSWORD: s.password,
      },
    }),
  },
  // ---- message queues ----
  {
    id: 'rabbitmq',
    name: 'RabbitMQ',
    category: 'queue',
    description: 'AMQP 消息队列（含管理界面），自动注入 RABBITMQ_URL。',
    dockerImage: 'rabbitmq:3-management-alpine',
    containerPort: 5672,
    volumePaths: ['/var/lib/rabbitmq'],
    secretKeys: ['password'],
    build: (s) => ({
      env: {
        RABBITMQ_DEFAULT_USER: 'app',
        RABBITMQ_DEFAULT_PASS: s.password,
      },
      envVars: {
        RABBITMQ_URL: `amqp://app:${s.password}@rabbitmq:5672`,
      },
    }),
  },
  {
    id: 'kafka',
    name: 'Apache Kafka',
    category: 'queue',
    description: '分布式流处理（KRaft 单节点，SASL/PLAIN 认证），自动注入 KAFKA_BROKERS 与 SASL 凭据。',
    dockerImage: 'apache/kafka:3.7.0',
    containerPort: 9092,
    volumePaths: ['/var/lib/kafka/data'],
    secretKeys: ['password'],
    /**
     * KRaft 单节点，客户端监听器叫 **CLIENT**，协议是 SASL_PLAINTEXT + PLAIN。
     *
     * 原来客户端监听器是裸 PLAINTEXT：连上 9092 就能建 topic、读全部消息。
     *
     * ## 监听器为什么叫 CLIENT，不叫 SASL_PLAINTEXT
     *
     * 2026-08-21 真容器实测抓到的：上一版把监听器**名字**也写成 `SASL_PLAINTEXT`，
     * 于是 JAAS 那条 env 只能叫 `KAFKA_LISTENER_NAME_SASL_PLAINTEXT_PLAIN_SASL_JAAS_CONFIG`。
     * 镜像把 env 转成配置项的规则是「去掉 KAFKA_ 前缀、剩下的下划线**全部**变成点」，
     * 所以它得到的是 `listener.name.sasl.plaintext.plain...`，而正确的属性名是
     * `listener.name.sasl_plaintext.plain...`（监听器名里那个下划线要保留）。
     * 名字对不上，镜像的 configure 脚本在 SASL 分支里查不到该有的变量，
     * 直接 `!1: unbound variable` 退出——**容器根本起不来**。
     *
     * 监听器名字是我们自己取的，那就取一个不带下划线的：`CLIENT`。
     * 名字与协议解耦之后，env→属性的转换不再有歧义。
     *
     * ## 三处必须同时改，少一处就是「配了但没生效」（形状 8）
     *
     * 监听器（LISTENERS）、协议映射（SECURITY_PROTOCOL_MAP）、**自我广播地址**
     * （ADVERTISED_LISTENERS）。广播地址是客户端真正拿去连的那一个，它指向的监听器
     * 若在映射里是 PLAINTEXT，SASL 就等于没开。暴露面自检的判据现在是**顺着映射解析**
     * 出广播监听器的真实协议，而不是看广播地址的字面前缀——名字可以随便取，
     * 只看字面就又是一次「读到的不是生效的那个值」。
     *
     * CONTROLLER 监听器保持 PLAINTEXT：它只在 9093 上、只被本节点自己用，
     * 从不发布到宿主；给它套 SASL 只会在单节点自举时增加失败面。
     *
     * JAAS 里的值**一律不加双引号**。CDS 拼 `docker run` 时 env 走 `-e "K=V"`，
     * 值里出现 `"` 会当场把那段 shell 引用截断，容器根本起不来。账号是 `app`、
     * 口令是 hex，都不含 JAAS 需要转义的字符，不带引号可以正常解析。
     * 有守卫盯着这一条，免得日后有人「顺手」按文档补上引号。
     */
    build: (s) => {
      // 同一个口令两处用途：broker 端声明账号（user_app=）、客户端登录（password=）。
      const jaas = 'org.apache.kafka.common.security.plain.PlainLoginModule required'
        + ` username=app password=${s.password} user_app=${s.password};`;
      return {
        env: {
          KAFKA_NODE_ID: '1',
          KAFKA_PROCESS_ROLES: 'broker,controller',
          KAFKA_LISTENERS: 'CLIENT://0.0.0.0:9092,CONTROLLER://0.0.0.0:9093',
          KAFKA_ADVERTISED_LISTENERS: 'CLIENT://kafka:9092',
          KAFKA_CONTROLLER_LISTENER_NAMES: 'CONTROLLER',
          KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: 'CONTROLLER:PLAINTEXT,CLIENT:SASL_PLAINTEXT',
          KAFKA_INTER_BROKER_LISTENER_NAME: 'CLIENT',
          KAFKA_SASL_ENABLED_MECHANISMS: 'PLAIN',
          KAFKA_SASL_MECHANISM_INTER_BROKER_PROTOCOL: 'PLAIN',
          KAFKA_LISTENER_NAME_CLIENT_PLAIN_SASL_JAAS_CONFIG: jaas,
          KAFKA_CONTROLLER_QUORUM_VOTERS: '1@kafka:9093',
          KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: '1',
          KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: '1',
          KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: '1',
          KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS: '0',
          KAFKA_NUM_PARTITIONS: '1',
          KAFKA_LOG_DIRS: '/var/lib/kafka/data',
          CLUSTER_ID: 'MkU3OEVBNTcwNTJENDM2Qk',
        },
        envVars: {
          KAFKA_BROKERS: 'kafka:9092',
          KAFKA_URL: 'kafka:9092',
          KAFKA_SECURITY_PROTOCOL: 'SASL_PLAINTEXT',
          KAFKA_SASL_MECHANISM: 'PLAIN',
          KAFKA_SASL_USERNAME: 'app',
          KAFKA_SASL_PASSWORD: s.password,
        },
      };
    },
  },
  {
    id: 'nats',
    name: 'NATS',
    category: 'queue',
    description: '轻量级发布订阅消息系统（已开启账号口令认证），自动注入带口令的 NATS_URL。',
    dockerImage: 'nats:2-alpine',
    containerPort: 4222,
    volumePaths: [],
    labels: { 'cds.no-http-readiness': 'true' },
    secretKeys: ['password'],
    /**
     * NATS 默认**任何人都能连、能订阅任何主题**。开认证只要一个 authorization 块。
     *
     * ## 口令为什么不能走 `--pass`
     *
     * 2026-08-21 真容器实测抓到的：上一版写的是
     * `sh -c 'exec /nats-server --user "$NATS_USER" --pass "$NATS_PASSWORD"'`。
     * 那个 `sh -c` 只挡住了**宿主**这一侧（docker run 的命令行、docker inspect 的
     * Config.Cmd 里只有变量名）——可它 `exec` 出去的那一刻，展开后的明文就成了
     * nats-server 自己的 argv，容器里 `/proc/1/cmdline` 一读就是
     * `nats-server --user app --pass <明文>`，宿主 `ps` 同样看得见（runc 下容器进程
     * 就在宿主进程表里）。
     *
     * redis 那边同样写法之所以没事，是因为 **redis-server 会改写自己的 argv**
     * （`set-proc-title yes`，见 debt.cds.md E34）。那是 redis 的特性，不是这套写法的
     * 保证——我把一个特例当成了通则。nats-server 不做这件事。
     *
     * ## 现在怎么做
     *
     * 在容器里先写一份只有本进程读得到的配置（`chmod 600`），再 `-c` 加载它。
     * argv 里只剩配置文件路径，口令留在容器内的文件里——和 memcached 的 `-Y`
     * 同一套做法，那一条真容器实测是过的。
     *
     * 二进制路径两种都试：官方镜像放在 `/nats-server`，别的 tag / 派生镜像可能只在
     * PATH 里。写死一个路径，换个 tag 就是「容器起不来」而不是「认证没生效」。
     *
     * **代价**：覆盖 entrypoint 之后镜像默认的 `nats-server.conf` 不再加载。那份配置
     * 只设了默认值（4222 端口、无认证），对 CDS 的用法没有影响；真要自定义配置的项目
     * 应该自己建服务而不是用预设。
     */
    entrypoint: 'sh',
    command: ['-c',
      'set -e;'
      + ' printf "authorization { user: \\"%s\\", password: \\"%s\\" }\\n"'
      + ' "$NATS_USER" "$NATS_PASSWORD" > /tmp/cds-nats.conf;'
      + ' chmod 600 /tmp/cds-nats.conf;'
      + ' if [ -x /nats-server ]; then exec /nats-server -c /tmp/cds-nats.conf;'
      + ' else exec nats-server -c /tmp/cds-nats.conf; fi'],
    build: (s) => ({
      env: {
        NATS_USER: 'app',
        NATS_PASSWORD: s.password,
      },
      envVars: {
        NATS_URL: `nats://app:${s.password}@nats:4222`,
      },
    }),
  },
  // ---- search ----
  {
    id: 'elasticsearch',
    name: 'Elasticsearch',
    category: 'search',
    description: '全文搜索与分析引擎（单节点），自动注入 ELASTICSEARCH_URL。',
    dockerImage: 'docker.elastic.co/elasticsearch/elasticsearch:8.11.0',
    containerPort: 9200,
    volumePaths: ['/usr/share/elasticsearch/data'],
    labels: { 'cds.readiness-timeout': '240' },
    secretKeys: ['password'],
    build: (s) => ({
      env: {
        'discovery.type': 'single-node',
        'xpack.security.enabled': 'true',
        ELASTIC_PASSWORD: s.password,
        ES_JAVA_OPTS: '-Xms512m -Xmx512m',
      },
      envVars: {
        ELASTICSEARCH_URL: `http://elastic:${s.password}@elasticsearch:9200`,
      },
    }),
  },
  // ---- object storage ----
  {
    id: 'minio',
    name: 'MinIO',
    category: 'storage',
    description: 'S3 兼容对象存储，自动注入 S3_ENDPOINT / S3_ACCESS_KEY / S3_SECRET_KEY。',
    dockerImage: 'minio/minio:latest',
    containerPort: 9000,
    volumePaths: ['/data'],
    command: 'server /data --console-address :9001',
    secretKeys: ['password'],
    build: (s) => ({
      env: {
        MINIO_ROOT_USER: 'app',
        MINIO_ROOT_PASSWORD: s.password,
      },
      envVars: {
        S3_ENDPOINT: 'http://minio:9000',
        S3_ACCESS_KEY: 'app',
        S3_SECRET_KEY: s.password,
        MINIO_URL: 'http://minio:9000',
      },
    }),
  },
];

/** Display order + Chinese label for category grouping in the picker. */
export const INFRA_CATEGORY_ORDER: InfraCategory[] = ['database', 'cache', 'queue', 'search', 'storage', 'config', 'other'];
export const INFRA_CATEGORY_LABELS: Record<InfraCategory, string> = {
  database: '数据库',
  cache: '缓存',
  queue: '消息队列',
  search: '搜索',
  storage: '对象存储',
  config: '配置中心',
  other: '其他',
};

const CATALOG_BY_ID = new Map<string, InfraCatalogEntry>(INFRA_CATALOG.map((e) => [e.id, e]));

export function getInfraCatalogEntry(id: string): InfraCatalogEntry | undefined {
  return CATALOG_BY_ID.get(id);
}

export function infraCatalogIds(): string[] {
  return INFRA_CATALOG.map((e) => e.id);
}

function imageBase(image: string): string {
  const lower = (image || '').toLowerCase();
  const lastSegment = lower.split('/').pop() || lower;
  return lastSegment.split(':')[0];
}

/**
 * Volume paths for a given image. Tries the catalog first (exact image/id match), then
 * falls back to a heuristic so user-supplied custom images (e.g. bitnami/postgresql)
 * still get sensible persistence. Returns null when nothing matches.
 */
export function recommendedVolumePathsFromCatalog(image: string): string[] | null {
  const base = imageBase(image);
  for (const entry of INFRA_CATALOG) {
    if ((imageBase(entry.dockerImage) === base || entry.id === base) && entry.volumePaths.length > 0) {
      return [...entry.volumePaths];
    }
  }
  // Heuristic fallback for custom images not in the catalog.
  if (base.startsWith('mysql') || base.startsWith('mariadb')) return ['/var/lib/mysql'];
  if (base.startsWith('postgres') || base.startsWith('timescale')) return ['/var/lib/postgresql/data'];
  if (base.startsWith('redis')) return ['/data'];
  if (base.startsWith('mongo')) return ['/data/db'];
  if (base.startsWith('rabbitmq')) return ['/var/lib/rabbitmq'];
  return null;
}

/** Secret-free catalog item for the UI picker. */
export interface InfraCatalogPublicItem {
  id: string;
  name: string;
  category: InfraCategory;
  categoryLabel: string;
  description: string;
  dockerImage: string;
  containerPort: number;
  hasPersistence: boolean;
  schemaful: boolean;
  /** User may customise the database name (default "app"). */
  supportsDbName: boolean;
  /** Initialization SQL can be configured + run against this store. */
  supportsInitSql: boolean;
  /** App-visible connection env var names this preset injects (e.g. ['DATABASE_URL']). */
  connectionEnvKeys: string[];
}

/**
 * Build the public catalog view. We call build() with placeholder secrets purely to
 * discover the connection env var NAMES; the placeholder values are never returned.
 */
export function getInfraCatalogPublic(): InfraCatalogPublicItem[] {
  return INFRA_CATALOG.map((entry) => {
    const placeholders: Record<string, string> = {};
    for (const k of entry.secretKeys || []) placeholders[k] = 'x';
    const built = entry.build(placeholders);
    return {
      id: entry.id,
      name: entry.name,
      category: entry.category,
      categoryLabel: INFRA_CATEGORY_LABELS[entry.category],
      description: entry.description,
      dockerImage: entry.dockerImage,
      containerPort: entry.containerPort,
      hasPersistence: entry.volumePaths.length > 0,
      schemaful: Boolean(entry.schemaful),
      supportsDbName: Boolean(entry.supportsDbName),
      supportsInitSql: Boolean(entry.supportsInitSql),
      connectionEnvKeys: Object.keys(built.envVars || {}),
    };
  });
}
