import { resolveEnvTemplates } from './compose-parser.js';

interface MongoBackupService {
  id: string;
  projectId: string;
  scope?: 'project' | 'system';
  containerName: string;
  env?: Record<string, string> | null;
}

const quote = (value: string): string => `'${value.replace(/'/g, `'"'"'`)}'`;

/** Credentials remain in stdin; the CDS connection URI never becomes a dump target. */
export async function buildMongoBackupInvocation(input: {
  service: MongoBackupService;
  variables: Record<string, string>;
  outputPath: string;
  systemMongoUri?: string;
}): Promise<{ command: string; stdin?: string; credentialSource: 'service' | 'cds-state-uri' | 'none' }> {
  const { service } = input;
  const env = resolveEnvTemplates(service.env || {}, input.variables);
  let username = env.MONGO_INITDB_ROOT_USERNAME || env.MONGO_USERNAME || env.MONGODB_USERNAME || '';
  let password = env.MONGO_INITDB_ROOT_PASSWORD || env.MONGO_PASSWORD || env.MONGODB_PASSWORD || '';
  let database = 'admin';
  let mechanism = '';
  let credentialSource: 'service' | 'cds-state-uri' | 'none' = username ? 'service' : 'none';

  // System infra is not created from a project's Mongo env. Its working CDS
  // connection supplies authentication when that legacy service record has none.
  // Never lend the control-plane credential to a project-owned Mongo container.
  if (!username && service.scope === 'system' && service.projectId === '__system__'
      && service.id === 'cds-state-mongo' && service.containerName === 'cds-infra-cds-state-mongo'
      && input.systemMongoUri) {
    const { MongoClient } = await import('mongodb');
    let client: InstanceType<typeof MongoClient> | undefined;
    try {
      client = new MongoClient(input.systemMongoUri);
      const auth = client.options.credentials;
      if (auth?.username) {
        if (!auth.password || !['DEFAULT', 'SCRAM-SHA-1', 'SCRAM-SHA-256'].includes(auth.mechanism)) {
          throw new Error('unsupported authentication');
        }
        username = auth.username;
        password = auth.password;
        database = auth.source;
        mechanism = auth.mechanism === 'DEFAULT' ? '' : auth.mechanism;
        credentialSource = 'cds-state-uri';
      }
    } catch {
      // Driver parse errors can contain the original URI. Keep it out of events.
      throw new Error('CDS 状态库备份认证配置无效或认证机制不受支持；未执行导出。');
    } finally {
      // URI parsing opens no sockets. Cleanup must not replace the safe error
      // above with a driver error that might contain connection details.
      if (client) await client.close().catch(() => undefined);
    }
  }

  if (username && !password) throw new Error('Mongo 权威账号存在但口令为空');
  const authArgs = username
    ? ` --username=${quote(username)} --authenticationDatabase=${quote(database)}`
      + (mechanism ? ` --authenticationMechanism=${quote(mechanism)}` : '') + ' --config=/dev/stdin'
    : '';
  return {
    command: `docker exec${username ? ' -i' : ''} ${quote(service.containerName)} mongodump --archive --gzip${authArgs} > ${quote(input.outputPath)}`,
    ...(username ? { stdin: `password: ${JSON.stringify(password)}\n` } : {}),
    credentialSource,
  };
}
