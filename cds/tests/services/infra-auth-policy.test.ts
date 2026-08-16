import { describe, expect, it } from 'vitest';
import { assertInfraAuthenticationConfigured } from '../../src/services/infra-auth-policy.js';

describe('基础设施认证硬门禁', () => {
  it('接受 CDS 生成的四类认证配置', () => {
    expect(() => assertInfraAuthenticationConfigured({
      dockerImage: 'mongo:7',
      env: { MONGO_INITDB_ROOT_USERNAME: 'app', MONGO_INITDB_ROOT_PASSWORD: 'secret' },
    })).not.toThrow();
    expect(() => assertInfraAuthenticationConfigured({
      dockerImage: 'postgres:16', env: { POSTGRES_PASSWORD: 'secret' },
    })).not.toThrow();
    expect(() => assertInfraAuthenticationConfigured({
      dockerImage: 'mysql:8', env: { MYSQL_ROOT_PASSWORD: 'secret' },
    })).not.toThrow();
    expect(() => assertInfraAuthenticationConfigured({
      dockerImage: 'redis:7',
      env: { REDIS_PASSWORD: 'secret' },
      command: ['sh', '-c', 'exec redis-server --requirepass "$REDIS_PASSWORD"'],
    })).not.toThrow();
  });

  it('拒绝只声明密码变量但启动命令没有启用认证的 Redis', () => {
    expect(() => assertInfraAuthenticationConfigured({
      dockerImage: 'redis:7', env: { REDIS_PASSWORD: 'secret' },
    })).toThrow('拒绝创建无认证');
  });

  it('拒绝四类无认证数据服务', () => {
    for (const dockerImage of ['mongo:7', 'postgres:16', 'mysql:8', 'redis:7']) {
      expect(() => assertInfraAuthenticationConfigured({ dockerImage }))
        .toThrow('拒绝创建无认证');
    }
  });

  it('不干预非数据基础设施', () => {
    expect(() => assertInfraAuthenticationConfigured({ dockerImage: 'minio/minio:latest' }))
      .not.toThrow();
  });
});
