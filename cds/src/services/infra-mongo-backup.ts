import { resolveEnvTemplates } from './compose-parser.js';
import { buildSecureMongoDockerInvocation, invocationShellCommand } from './secure-database-cli.js';

interface MongoBackupService {
  id: string;
  projectId: string;
  scope?: 'project' | 'system';
  containerName: string;
  env?: Record<string, string> | null;
}

const quote = (value: string): string => `'${value.replace(/'/g, `'"'"'`)}'`;

/** Passwords remain in stdin; the CDS connection URI never becomes a dump target. */
export async function buildMongoBackupInvocation(input: {
  service: MongoBackupService;
  variables: Record<string, string>;
  outputPath: string;
  systemMongoUri?: string;
  systemMongoBackupUri?: string;
}): Promise<{ command: string; stdin?: string; credentialSource: 'service' | 'cds-state-uri' | 'cds-state-backup-uri' | 'none';
  accessCheck?: { command: string; stdin: string } }> {
  const { service } = input;
  const env = resolveEnvTemplates(service.env || {}, input.variables);
  let username = env.MONGO_INITDB_ROOT_USERNAME || env.MONGO_USERNAME || env.MONGODB_USERNAME || '';
  let password = env.MONGO_INITDB_ROOT_PASSWORD || env.MONGO_PASSWORD || env.MONGODB_PASSWORD || '';
  let database = 'admin';
  let mechanism = '';
  let credentialSource: 'service' | 'cds-state-uri' | 'cds-state-backup-uri' | 'none' = username ? 'service' : 'none';
  const isSystemState = service.scope === 'system' && service.projectId === '__system__'
    && service.id === 'cds-state-mongo' && service.containerName === 'cds-infra-cds-state-mongo';

  // System infra is not created from a project's Mongo env. Its working CDS
  // connection supplies authentication when that legacy service record has none.
  // Never lend the control-plane credential to a project-owned Mongo container.
  const systemUri = input.systemMongoBackupUri || input.systemMongoUri;
  if (!username && isSystemState && systemUri) {
    const { MongoClient } = await import('mongodb');
    let client: InstanceType<typeof MongoClient> | undefined;
    try {
      client = new MongoClient(systemUri);
      const auth = client.options.credentials;
      if (auth?.username) {
        if (!auth.password || !['DEFAULT', 'SCRAM-SHA-1', 'SCRAM-SHA-256'].includes(auth.mechanism)) {
          throw new Error('unsupported authentication');
        }
        username = auth.username;
        password = auth.password;
        database = auth.source;
        mechanism = auth.mechanism === 'DEFAULT' ? '' : auth.mechanism;
        credentialSource = input.systemMongoBackupUri ? 'cds-state-backup-uri' : 'cds-state-uri';
      } else if (input.systemMongoBackupUri) {
        throw new Error('dedicated backup URI requires authentication');
      }
    } catch {
      // Driver parse errors can contain the original URI. Keep it out of events.
      throw new Error('系统数据库备份认证配置无效或不受支持，本轮未导出；请联系管理员检查备份账号后重试。');
    } finally {
      // URI parsing opens no sockets. Cleanup must not replace the safe error
      // above with a driver error that might contain connection details.
      if (client) await client.close().catch(() => undefined);
    }
  }

  if (username && !password) throw new Error('数据库备份账号缺少密码；请联系管理员补全后重试。');
  let accessCheck: { command: string; stdin: string } | undefined;
  if (isSystemState && username) {
    // mongodump can succeed while silently exporting only the databases a
    // limited application user can list. Confirm the built-in full-backup role
    // on the actual container, using the existing stdin-only Mongo CLI channel.
    if (/[\r\n]/.test(password)) throw new Error('系统数据库备份密码格式不受支持，本轮未导出；请联系管理员更新备份密码后重试。');
    const script = 'let allowed=false; try {'
      + 'const r=db.getSiblingDB("admin").runCommand({connectionStatus:1});'
      + 'allowed=r.ok===1 && (r.authInfo?.authenticatedUserRoles||[]).some('
      + 'x=>x.db==="admin" && (x.role==="backup"||x.role==="root"));'
      + '} catch {} if(!allowed){print("CDS_SYSTEM_BACKUP_ROLE_UNCONFIRMED");quit(43);}'
      + 'print("CDS_SYSTEM_BACKUP_ROLE_CONFIRMED");';
    const probe = buildSecureMongoDockerInvocation(service.containerName, 'mongosh', [
      '--norc', '--quiet', '--username', username, '--authenticationDatabase', database,
      ...(mechanism ? ['--authenticationMechanism', mechanism] : []), '--eval', script,
    ], password);
    accessCheck = { command: invocationShellCommand(probe), stdin: probe.stdinPrefix };
  }
  const authArgs = username
    ? ` --username=${quote(username)} --authenticationDatabase=${quote(database)}`
      + (mechanism ? ` --authenticationMechanism=${quote(mechanism)}` : '') + ' --config=/dev/stdin'
    : '';
  return {
    command: `docker exec${username ? ' -i' : ''} ${quote(service.containerName)} mongodump --archive --gzip${authArgs} > ${quote(input.outputPath)}`,
    ...(username ? { stdin: `password: ${JSON.stringify(password)}\n` } : {}),
    credentialSource,
    ...(accessCheck ? { accessCheck } : {}),
  };
}
