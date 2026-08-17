import { detectInfraKind } from './infra-exposure-audit.js';

export interface InfraAuthInput {
  dockerImage: string;
  id?: string;
  name?: string;
  basePresetId?: string;
  containerName?: string;
  containerPort?: number;
  env?: Record<string, string> | null;
  command?: string | string[];
  entrypoint?: string | string[];
}

function hasValue(env: Record<string, string>, ...keys: string[]): boolean {
  return keys.some((key) => Boolean(String(env[key] || '').trim()));
}

function commandText(input: InfraAuthInput): string {
  return [input.command, input.entrypoint]
    .flatMap((value) => Array.isArray(value) ? value : value == null ? [] : [value])
    .map(String)
    .join(' ');
}

/**
 * 新建数据服务的认证硬门禁。
 *
 * 这里检查的是容器真正会使用的 env/command，而不是 CDS 台账里的“预期配置”。
 * 存量容器由运行态暴露审计发现并安排有备份的迁移；本函数只阻止继续创建新的
 * 无认证实例，避免在没有恢复副本时擅自重建现有数据容器。
 */
export function assertInfraAuthenticationConfigured(input: InfraAuthInput): void {
  const kind = detectInfraKind(input.dockerImage, input);
  const env = input.env || {};
  const command = commandText(input);
  let configured = true;

  if (kind === 'mongo') {
    configured = hasValue(env, 'MONGO_INITDB_ROOT_USERNAME', 'MONGO_USERNAME', 'MONGODB_USERNAME')
      && hasValue(env, 'MONGO_INITDB_ROOT_PASSWORD', 'MONGO_PASSWORD', 'MONGODB_PASSWORD');
  } else if (kind === 'postgres') {
    configured = hasValue(env, 'POSTGRES_PASSWORD', 'PGPASSWORD');
  } else if (kind === 'mysql') {
    configured = hasValue(env, 'MYSQL_ROOT_PASSWORD', 'MARIADB_ROOT_PASSWORD');
  } else if (kind === 'redis') {
    const effective = `${command} ${env.REDIS_ARGS || ''} ${env.REDIS_EXTRA_FLAGS || ''}`;
    configured = /(?:^|\s)--requirepass(?:=|\s+)\S+/.test(effective)
      || /(?:^|\s)--aclfile(?:=|\s+)\S+/.test(effective);
  }

  if (!configured) {
    throw new Error(`拒绝创建无认证的 ${kind} 基础设施；请配置 CDS 生成的凭据后重试`);
  }
}
