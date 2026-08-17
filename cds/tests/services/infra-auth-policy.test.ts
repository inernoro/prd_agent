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

  it('不透明镜像仍按服务元数据与容器端口执行认证门禁', () => {
    expect(() => assertInfraAuthenticationConfigured({
      dockerImage: 'sha256:opaque', id: 'primary-db', containerPort: 27017,
    })).toThrow('拒绝创建无认证的 mongo');
    expect(() => assertInfraAuthenticationConfigured({
      dockerImage: 'private/image@sha256:opaque', name: '业务 MySQL', containerPort: 8080,
    })).toThrow('拒绝创建无认证的 mysql');
    expect(() => assertInfraAuthenticationConfigured({
      dockerImage: 'private/image@sha256:opaque', basePresetId: 'redis', containerPort: 8080,
      command: ['redis-server', '--requirepass', 'secret'],
    })).not.toThrow();
  });

  it('不干预非数据基础设施', () => {
    expect(() => assertInfraAuthenticationConfigured({ dockerImage: 'minio/minio:latest' }))
      .not.toThrow();
  });
});
