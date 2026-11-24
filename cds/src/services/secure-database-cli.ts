import type { SealedSecret } from '../infra/secret-seal.js';
import { isSealedSecret, isSealingEnabled, sealToken, unsealToken } from '../infra/secret-seal.js';
import type { DataMigration, MongoConnectionConfig } from '../types.js';

/**
 * MongoDB Database Tools only accept the password through argv or a config file.
 * This wrapper receives a base64 encoded JSON config on stdin, writes it under a
 * 0600 umask, and removes it for success, failure and signals. The remaining
 * stdin bytes are left untouched for mongorestore archives or mongosh scripts.
 */
export const SECURE_MONGO_CONFIG_WRAPPER = [
  'set -eu',
  'auth_file="$(mktemp /tmp/cds-mongo-auth.XXXXXX)"',
  'cleanup() { rm -f "$auth_file"; }',
  "trap cleanup EXIT HUP INT TERM",
  'chmod 600 "$auth_file"',
  'IFS= read -r auth_line',
  'printf %s "$auth_line" | base64 -d > "$auth_file"',
  '"$@" --config "$auth_file"',
].join('\n');

/** Redis officially supports REDISCLI_AUTH. Decode it inside the child shell so
 * neither the host docker/ssh argv nor the persisted command log contains it. */
export const SECURE_REDIS_AUTH_WRAPPER = [
  'set -eu',
  'IFS= read -r auth_line',
  'REDISCLI_AUTH="$(printf %s "$auth_line" | base64 -d)"',
  'export REDISCLI_AUTH',
  'exec "$@"',
].join('\n');

export interface SecureCliInvocation {
  command: string;
  argv: string[];
  /** Write this prefix before any application payload sent to stdin. */
  stdinPrefix: string;
}

function encodedLine(value: string): string {
  return `${Buffer.from(value, 'utf8').toString('base64')}\n`;
}

function mongoConfigLine(password: string): string {
  return encodedLine(JSON.stringify({ password }));
}

export function buildSecureMongoHostInvocation(
  tool: 'mongosh' | 'mongodump' | 'mongorestore',
  args: readonly string[],
  password: string,
): SecureCliInvocation {
  if (!password) return { command: tool, argv: [...args], stdinPrefix: '' };
  if (tool === 'mongosh') {
    return {
      command: tool,
      // mongosh does not support the Database Tools --config option. Passing
      // --password without a value uses its documented password prompt, which
      // reads the value from stdin without exposing it through process argv.
      argv: [...args, '--password'],
      stdinPrefix: `${password}\n`,
    };
  }
  return {
    command: 'sh',
    argv: ['-c', SECURE_MONGO_CONFIG_WRAPPER, 'cds-secure-mongo', tool, ...args],
    stdinPrefix: mongoConfigLine(password),
  };
}

export function buildSecureMongoDockerInvocation(
  containerName: string,
  tool: 'mongosh' | 'mongodump' | 'mongorestore',
  args: readonly string[],
  password: string,
): SecureCliInvocation {
  if (!password) {
    return { command: 'docker', argv: ['exec', '-i', containerName, tool, ...args], stdinPrefix: '' };
  }
  if (tool === 'mongosh') {
    return {
      command: 'docker',
      argv: ['exec', '-i', containerName, tool, ...args, '--password'],
      stdinPrefix: `${password}\n`,
    };
  }
  return {
    command: 'docker',
    argv: [
      'exec', '-i', containerName, 'sh', '-c', SECURE_MONGO_CONFIG_WRAPPER,
      'cds-secure-mongo', tool, ...args,
    ],
    stdinPrefix: mongoConfigLine(password),
  };
}

export function buildSecureRedisDockerInvocation(
  containerName: string,
  args: readonly string[],
  password: string,
): SecureCliInvocation {
  if (!password) {
    return { command: 'docker', argv: ['exec', '-i', containerName, 'redis-cli', ...args], stdinPrefix: '' };
  }
  return {
    command: 'docker',
    argv: [
      'exec', '-i', containerName, 'sh', '-c', SECURE_REDIS_AUTH_WRAPPER,
      'cds-secure-redis', 'redis-cli', ...args,
    ],
    stdinPrefix: encodedLine(password),
  };
}

export function shellQuoteArg(value: string): string {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

export function invocationShellCommand(invocation: Pick<SecureCliInvocation, 'command' | 'argv'>): string {
  return [invocation.command, ...invocation.argv].map(shellQuoteArg).join(' ');
}

/** A command description safe for user-visible progress and persisted logs. */
export function describeSecureInvocation(invocation: Pick<SecureCliInvocation, 'command' | 'argv'>): string {
  const toolIndex = invocation.argv.findIndex((arg) => /^(mongosh|mongodump|mongorestore|redis-cli)$/.test(arg));
  if (toolIndex < 0) return invocation.command;
  return `${invocation.argv[toolIndex]} ${invocation.argv.slice(toolIndex + 1).join(' ')}`.trim();
}

export function redactSecretValues(text: string, secrets: readonly string[]): string {
  return secrets.reduce((masked, secret) => (
    secret && secret.length >= 3 ? masked.split(secret).join('******') : masked
  ), String(text || ''));
}

/** 旧管线把密码写成参数时用过的三种旗标，外加连接串里的 user:pass@host。 */
const PASSWORD_ARGUMENT_FLAGS = ['--password', '-p', '-a'] as const;

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 掩掉「紧跟在密码旗标后面」的那一个值，不看长度。
 *
 * redactSecretValues 的 `length >= 3` 不是可以随手放宽的阈值：单字母口令整串替换会把
 * 一整份日志抹成星号，脱敏反而毁掉了日志。但同一个短口令出现在 `--password ab` 这种
 * 位置时含义是确定的，必须掩掉——而创建接口对口令长度没有下限，这种任务是合法存量。
 * 旧管线写进日志的形态有三种（mongodump/mongorestore 的 --password、mongosh 的 -p、
 * redis-cli 的 -a），另加连接串里的 user:pass@host。
 */
function redactPasswordArguments(text: string, secrets: readonly string[]): string {
  const flags = PASSWORD_ARGUMENT_FLAGS.map(escapeForRegExp).join('|');
  return secrets.reduce((masked, secret) => {
    if (!secret) return masked;
    const quoted = escapeForRegExp(secret);
    return masked
      // 旗标前必须是行首或空白/引号，避免 `-a` 命中某个单词的尾巴。
      .replace(
        new RegExp(`(^|[\\s'"])(${flags})([ =]+)('${quoted}'|"${quoted}"|${quoted})`, 'g'),
        '$1$2$3******',
      )
      .replace(new RegExp(`:${quoted}@`, 'g'), ':******@');
  }, String(text || ''));
}

/**
 * 旧版迁移遗留文本（log / progressMessage / errorMessage）的唯一脱敏口径。
 * 升级与对外投影两处共用它——两处各写一套正是判据分裂的起点。
 */
export function redactLegacyMigrationText(text: string, secrets: readonly string[]): string {
  return redactPasswordArguments(redactSecretValues(text, secrets), secrets);
}

interface MigrationCredentialPayload {
  sourcePassword?: string;
  targetPassword?: string;
  sourceSshPassword?: string;
  targetSshPassword?: string;
}

function withoutConnectionSecrets(connection: MongoConnectionConfig): MongoConnectionConfig {
  const { password: _password, sshTunnel, ...rest } = connection;
  return {
    ...rest,
    ...(sshTunnel ? { sshTunnel: { ...sshTunnel, password: undefined } } : {}),
  };
}

function migrationCredentialPayload(source: MongoConnectionConfig, target: MongoConnectionConfig): MigrationCredentialPayload {
  return {
    ...(source.password ? { sourcePassword: source.password } : {}),
    ...(target.password ? { targetPassword: target.password } : {}),
    ...(source.sshTunnel?.password ? { sourceSshPassword: source.sshTunnel.password } : {}),
    ...(target.sshTunnel?.password ? { targetSshPassword: target.sshTunnel.password } : {}),
  };
}

function hasCredentialPayload(payload: MigrationCredentialPayload): boolean {
  return Object.values(payload).some(Boolean);
}

export function sealMigrationConnections(
  source: MongoConnectionConfig,
  target: MongoConnectionConfig,
): { source: MongoConnectionConfig; target: MongoConnectionConfig; credentialsEncrypted?: SealedSecret } {
  const payload = migrationCredentialPayload(source, target);
  if (!hasCredentialPayload(payload)) {
    return { source: withoutConnectionSecrets(source), target: withoutConnectionSecrets(target) };
  }
  if (!isSealingEnabled()) {
    throw new Error('CDS_SECRET_KEY 未配置，拒绝把数据迁移凭据写入状态；请先启用 CDS 密封存储');
  }
  const sealed = sealToken(JSON.stringify(payload));
  if (!isSealedSecret(sealed)) throw new Error('数据迁移凭据密封失败');
  return {
    source: withoutConnectionSecrets(source),
    target: withoutConnectionSecrets(target),
    credentialsEncrypted: sealed,
  };
}

export function unsealMigrationConnections(migration: DataMigration): {
  source: MongoConnectionConfig;
  target: MongoConnectionConfig;
  secretValues: string[];
} {
  const legacySecrets = migrationCredentialPayload(migration.source, migration.target);
  if (migration.credentialsEncrypted === undefined && hasCredentialPayload(legacySecrets)) {
    throw new Error('检测到旧版明文数据迁移凭据，必须先完成密封迁移后才能执行');
  }
  let payload: MigrationCredentialPayload = {};
  if (migration.credentialsEncrypted !== undefined) {
    if (!isSealedSecret(migration.credentialsEncrypted)) {
      throw new Error('数据迁移凭据不是受支持的密封格式，拒绝执行');
    }
    payload = JSON.parse(unsealToken(migration.credentialsEncrypted)) as MigrationCredentialPayload;
  }
  const source = {
    ...migration.source,
    ...(payload.sourcePassword ? { password: payload.sourcePassword } : {}),
    ...(migration.source.sshTunnel ? {
      sshTunnel: {
        ...migration.source.sshTunnel,
        ...(payload.sourceSshPassword ? { password: payload.sourceSshPassword } : {}),
      },
    } : {}),
  };
  const target = {
    ...migration.target,
    ...(payload.targetPassword ? { password: payload.targetPassword } : {}),
    ...(migration.target.sshTunnel ? {
      sshTunnel: {
        ...migration.target.sshTunnel,
        ...(payload.targetSshPassword ? { password: payload.targetSshPassword } : {}),
      },
    } : {}),
  };
  return {
    source,
    target,
    secretValues: Object.values(payload).filter((value): value is string => Boolean(value)),
  };
}

export interface LegacyMigrationUpgrade {
  /** 有条目被升级；调用方必须立刻落盘。 */
  changed: boolean;
  /** 因为还没有密封密钥而被推迟的任务 id。状态原样不动，等有钥匙再升。 */
  deferred: string[];
}

/** Upgrade persisted pre-sealing migrations in place. Callers must save the
 * state immediately when `changed` is true.
 *
 * 没有密封密钥时**推迟**而不是抛错。抛错的后果是死锁：这个迁移跑在
 * `initStateService` 里、HTTP 服务起来之前，而唯一能装上密钥的入口
 * （`POST /cds-system/sealed-storage/initialize`）正是那个起不来的 HTTP 服务——
 * 一台存着旧明文凭据、又没配密钥的实例会永远开不了机，连来装钥匙都做不到
 *（判据与接线纪律 形状 5：用变更前的状态去 gate 那个会修好它的变更）。
 *
 * 推迟不写入任何东西：明文留在它本来就在的地方，不多不少。等密钥装上、进程重启，
 * 这个函数会照原顺序（先脱敏、再密封）把它升上去。推迟的条目由调用方喊出来，
 * 不许无声无息（degradation-must-alarm）。
 *
 * 「同时存在明文与密封凭据」仍然抛错：那是状态损坏，不是缺钥匙，装钥匙也修不好。 */
export function migrateLegacyDataMigrationCredentials(migrations: DataMigration[]): LegacyMigrationUpgrade {
  let changed = false;
  const deferred: string[] = [];
  for (const migration of migrations) {
    const legacy = migrationCredentialPayload(migration.source, migration.target);
    if (!hasCredentialPayload(legacy)) continue;
    if (migration.credentialsEncrypted !== undefined) {
      throw new Error(`数据迁移任务 ${migration.id} 同时包含明文与密封凭据，拒绝启动`);
    }
    if (!isSealingEnabled()) {
      deferred.push(migration.id);
      continue;
    }
    // 先脱敏，再密封：publicDataMigration 是拿 source/target 上的明文密码去比对着
    // 抹掉 log / progressMessage / errorMessage 里的密码的。密封会把明文拿走，
    // 之后那份「可比对的串」就再也没有了——升级前跑过的迁移，日志里存着旧管线写进去的
    // `--password <secret>`，会原样从 GET /data-migrations/:id/log 吐出去，而且是永久的。
    // 顺序反了就等于用一次安全加固制造一次凭据泄漏（判据与接线纪律 形状 5：
    // 用变更前的状态去 gate 那个会改变该状态的变更，这里是它的镜像——变更销毁了判据的输入）。
    const legacySecrets = [
      migration.source.password,
      migration.target.password,
      migration.source.sshTunnel?.password,
      migration.target.sshTunnel?.password,
    ].filter((value): value is string => Boolean(value));
    if (legacySecrets.length > 0) {
      if (migration.log) migration.log = redactLegacyMigrationText(migration.log, legacySecrets);
      if (migration.progressMessage) {
        migration.progressMessage = redactLegacyMigrationText(migration.progressMessage, legacySecrets);
      }
      if (migration.errorMessage) {
        migration.errorMessage = redactLegacyMigrationText(migration.errorMessage, legacySecrets);
      }
    }

    const sealed = sealMigrationConnections(migration.source, migration.target);
    migration.source = sealed.source;
    migration.target = sealed.target;
    migration.credentialsEncrypted = sealed.credentialsEncrypted;
    changed = true;
  }
  return { changed, deferred };
}

export function publicDataMigration(migration: DataMigration): DataMigration {
  const { credentialsEncrypted: _credentialsEncrypted, ...rest } = migration;
  const legacySecrets = [
    migration.source.password,
    migration.target.password,
    migration.source.sshTunnel?.password,
    migration.target.sshTunnel?.password,
  ].filter((value): value is string => Boolean(value));
  return {
    ...rest,
    source: withoutConnectionSecrets(rest.source),
    target: withoutConnectionSecrets(rest.target),
    progressMessage: rest.progressMessage ? redactLegacyMigrationText(rest.progressMessage, legacySecrets) : undefined,
    errorMessage: rest.errorMessage ? redactLegacyMigrationText(rest.errorMessage, legacySecrets) : undefined,
    log: rest.log ? redactLegacyMigrationText(rest.log, legacySecrets) : undefined,
  };
}

export function clearMigrationCredentials(migration: DataMigration): void {
  delete migration.credentialsEncrypted;
  delete migration.source.password;
  delete migration.target.password;
  if (migration.source.sshTunnel) delete migration.source.sshTunnel.password;
  if (migration.target.sshTunnel) delete migration.target.sshTunnel.password;
}
