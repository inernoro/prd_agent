import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { assertInfraAuthenticationConfigured } from '../../src/services/infra-auth-policy.js';
import { INFRA_CATALOG } from '../../src/services/infra-catalog.js';

describe('基础设施认证硬门禁', () => {
  it('接受 CDS 生成的认证配置', () => {
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
    expect(() => assertInfraAuthenticationConfigured({
      dockerImage: 'mcr.microsoft.com/mssql/server:2022-latest',
      env: { MSSQL_SA_PASSWORD: 'Secret123!' },
    })).not.toThrow();
    expect(() => assertInfraAuthenticationConfigured({
      dockerImage: 'clickhouse/clickhouse-server:24', env: { CLICKHOUSE_PASSWORD: 'secret' },
    })).not.toThrow();
    expect(() => assertInfraAuthenticationConfigured({
      dockerImage: 'rabbitmq:3-management',
      env: { RABBITMQ_DEFAULT_USER: 'app', RABBITMQ_DEFAULT_PASS: 'secret' },
    })).not.toThrow();
    expect(() => assertInfraAuthenticationConfigured({
      dockerImage: 'elasticsearch:8',
      env: { 'xpack.security.enabled': 'true', ELASTIC_PASSWORD: 'secret' },
    })).not.toThrow();
    expect(() => assertInfraAuthenticationConfigured({
      dockerImage: 'minio/minio:latest',
      env: { MINIO_ROOT_USER: 'app', MINIO_ROOT_PASSWORD: 'secret' },
    })).not.toThrow();
  });

  it('拒绝只声明密码变量但启动命令没有启用认证的 Redis', () => {
    expect(() => assertInfraAuthenticationConfigured({
      dockerImage: 'redis:7', env: { REDIS_PASSWORD: 'secret' },
    })).toThrow('拒绝创建无认证');
  });

  it('拒绝所有支持认证但未配置凭据的数据服务', () => {
    for (const dockerImage of [
      'mongo:7',
      'postgres:16',
      'redis:7',
      'mcr.microsoft.com/mssql/server:2022-latest',
      'clickhouse/clickhouse-server:24',
      'rabbitmq:3-management',
      'elasticsearch:8',
      'minio/minio:latest',
    ]) {
      expect(() => assertInfraAuthenticationConfigured({ dockerImage }))
        .toThrow('拒绝创建无认证');
    }
    expect(() => assertInfraAuthenticationConfigured({ dockerImage: 'mysql:8' }))
      .toThrow('缺少可复用备份凭据');
  });

  it('拒绝只有随机 root 开关或孤立应用密码的 MySQL', () => {
    expect(() => assertInfraAuthenticationConfigured({
      dockerImage: 'mysql:8', env: { MYSQL_RANDOM_ROOT_PASSWORD: 'yes' },
    })).toThrow('缺少可复用备份凭据');
    expect(() => assertInfraAuthenticationConfigured({
      dockerImage: 'mysql:8',
      env: { MYSQL_RANDOM_ROOT_PASSWORD: 'yes', MYSQL_USER: 'app', MYSQL_PASSWORD: 'secret' },
    })).toThrow('缺少可复用备份凭据');
    expect(() => assertInfraAuthenticationConfigured({
      dockerImage: 'mysql:8', env: { MYSQL_PASSWORD: 'secret' },
    })).toThrow('缺少可复用备份凭据');
    expect(() => assertInfraAuthenticationConfigured({
      dockerImage: 'mysql:8', env: { MYSQL_USER: 'app', MYSQL_PASSWORD: 'secret' },
    })).toThrow('缺少可复用备份凭据');
    expect(() => assertInfraAuthenticationConfigured({
      dockerImage: 'mariadb:11', env: { MARIADB_USER: 'app', MARIADB_PASSWORD: 'secret' },
    })).toThrow('缺少可复用备份凭据');
  });

  it('不透明镜像仍按服务元数据与容器端口执行认证门禁', () => {
    expect(() => assertInfraAuthenticationConfigured({
      dockerImage: 'sha256:opaque', id: 'primary-db', containerPort: 27017,
    })).toThrow('拒绝创建无认证的 mongo');
    expect(() => assertInfraAuthenticationConfigured({
      dockerImage: 'private/image@sha256:opaque', name: '业务 MySQL', containerPort: 8080,
    })).toThrow('缺少可复用备份凭据');
    expect(() => assertInfraAuthenticationConfigured({
      dockerImage: 'private/image@sha256:opaque', basePresetId: 'redis', containerPort: 8080,
      command: ['redis-server', '--requirepass', 'secret'],
    })).not.toThrow();
  });

  it('不干预当前只依赖私网隔离的基础设施', () => {
    expect(() => assertInfraAuthenticationConfigured({ dockerImage: 'memcached:1-alpine' }))
      .not.toThrow();
    expect(() => assertInfraAuthenticationConfigured({ dockerImage: 'apache/kafka:3.7' }))
      .not.toThrow();
    expect(() => assertInfraAuthenticationConfigured({ dockerImage: 'nats:2-alpine' }))
      .not.toThrow();
  });

  it('目录中每个声明凭据的服务都能通过同一启动门禁', () => {
    for (const entry of INFRA_CATALOG.filter((candidate) => candidate.secretKeys?.length)) {
      const secrets = Object.fromEntries(entry.secretKeys!.map((key) => [key, 'Secret123']));
      const built = entry.build(secrets);
      expect(() => assertInfraAuthenticationConfigured({
        dockerImage: entry.dockerImage,
        id: entry.id,
        name: entry.name,
        basePresetId: entry.id,
        containerPort: entry.containerPort,
        env: built.env,
        command: entry.command,
      }), `目录服务 ${entry.id} 的认证配置没有通过启动门禁`).not.toThrow();
    }
  });

  it('legacy 数据库入口走凭据目录且不会吞掉启动失败', () => {
    const legacy = fs.readFileSync(path.resolve(process.cwd(), 'web-legacy/app.js'), 'utf8');
    const presetFlow = legacy.slice(
      legacy.indexOf('const INFRA_PRESET_LABELS'),
      legacy.indexOf('window._topologyShowDatabaseSubmenu'),
    );
    const customFlow = legacy.slice(
      legacy.indexOf('async function saveCustomInfra'),
      legacy.indexOf('// ── Routing modal'),
    );
    expect(presetFlow).toContain("'/infra-presets'");
    expect(presetFlow).toContain("await api('POST', '/infra/' + encodeURIComponent(service.id) + '/start?project=' + encodeURIComponent(CURRENT_PROJECT_ID))");
    expect(presetFlow).not.toContain('INFRA_TEMPLATES');
    expect(presetFlow).not.toContain('change-me-please');
    expect(customFlow).toContain("`/infra?project=${encodeURIComponent(CURRENT_PROJECT_ID)}`");
    expect(customFlow).not.toContain("catch { /* ok */ }");
  });
});
