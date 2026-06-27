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
    description: '内存键值缓存，自动注入 REDIS_URL。',
    dockerImage: 'redis:7-alpine',
    containerPort: 6379,
    volumePaths: ['/data'],
    build: () => ({
      envVars: {
        REDIS_URL: 'redis://redis:6379',
      },
    }),
  },
  {
    id: 'memcached',
    name: 'Memcached',
    category: 'cache',
    description: '高速内存缓存，自动注入 MEMCACHED_URL。',
    dockerImage: 'memcached:1-alpine',
    containerPort: 11211,
    volumePaths: [],
    build: () => ({
      envVars: {
        MEMCACHED_URL: 'memcached:11211',
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
    description: '分布式流处理（KRaft 单节点，无需 Zookeeper），自动注入 KAFKA_BROKERS。',
    dockerImage: 'apache/kafka:3.7.0',
    containerPort: 9092,
    volumePaths: ['/var/lib/kafka/data'],
    // KRaft single-node: the broker advertises itself on the project network as "kafka:9092".
    build: () => ({
      env: {
        KAFKA_NODE_ID: '1',
        KAFKA_PROCESS_ROLES: 'broker,controller',
        KAFKA_LISTENERS: 'PLAINTEXT://0.0.0.0:9092,CONTROLLER://0.0.0.0:9093',
        KAFKA_ADVERTISED_LISTENERS: 'PLAINTEXT://kafka:9092',
        KAFKA_CONTROLLER_LISTENER_NAMES: 'CONTROLLER',
        KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: 'CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT',
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
      },
    }),
  },
  {
    id: 'nats',
    name: 'NATS',
    category: 'queue',
    description: '轻量级发布订阅消息系统，自动注入 NATS_URL。',
    dockerImage: 'nats:2-alpine',
    containerPort: 4222,
    volumePaths: [],
    labels: { 'cds.no-http-readiness': 'true' },
    build: () => ({
      envVars: {
        NATS_URL: 'nats://nats:4222',
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
