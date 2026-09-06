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

/** Upgrade persisted pre-sealing migrations in place. Callers must save the
 * state immediately when this returns true. Without a sealing key it throws,
 * so a legacy plaintext credential can never be silently loaded and re-saved. */
export function migrateLegacyDataMigrationCredentials(migrations: DataMigration[]): boolean {
  let changed = false;
  for (const migration of migrations) {
    const legacy = migrationCredentialPayload(migration.source, migration.target);
    if (!hasCredentialPayload(legacy)) continue;
    if (migration.credentialsEncrypted !== undefined) {
      throw new Error(`数据迁移任务 ${migration.id} 同时包含明文与密封凭据，拒绝启动`);
    }
    const sealed = sealMigrationConnections(migration.source, migration.target);
    migration.source = sealed.source;
    migration.target = sealed.target;
    migration.credentialsEncrypted = sealed.credentialsEncrypted;
    changed = true;
  }
  return changed;
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
    progressMessage: rest.progressMessage ? redactSecretValues(rest.progressMessage, legacySecrets) : undefined,
    errorMessage: rest.errorMessage ? redactSecretValues(rest.errorMessage, legacySecrets) : undefined,
    log: rest.log ? redactSecretValues(rest.log, legacySecrets) : undefined,
  };
}

export function clearMigrationCredentials(migration: DataMigration): void {
  delete migration.credentialsEncrypted;
  delete migration.source.password;
  delete migration.target.password;
  if (migration.source.sshTunnel) delete migration.source.sshTunnel.password;
  if (migration.target.sshTunnel) delete migration.target.sshTunnel.password;
}
