import { describe, it, expect } from 'vitest';
import { detectInfraDataKind, buildInfraDataExec, maskSecretValues } from '../../src/routes/infra-data.js';
import type { InfraService } from '../../src/types.js';

/**
 * infra-data 命令构造单测。docker exec 的真实执行需有 CDS/Docker 环境,但「构造哪条
 * 命令、密码怎么传、stdin 喂什么」是最易错的部分,这里全覆盖,无需 Docker。
 */
function svc(image: string, env: Record<string, string> = {}, extra: Partial<InfraService> = {}): InfraService {
  return {
    id: 'db', projectId: 'p', name: 'db', dockerImage: image, containerPort: 5432,
    hostPort: 10000, containerName: 'cds-infra-p-db', status: 'running', volumes: [],
    env, createdAt: '2026-06-01T00:00:00Z', ...extra,
  } as InfraService;
}

describe('infra-data buildInfraDataExec', () => {
  it('detects db kind by image', () => {
    expect(detectInfraDataKind('postgres:16-alpine')).toBe('postgres');
    expect(detectInfraDataKind('mysql:8')).toBe('mysql');
    expect(detectInfraDataKind('mongo:7')).toBe('mongo');
    expect(detectInfraDataKind('redis:7-alpine')).toBe('redis');
    expect(detectInfraDataKind('clickhouse/clickhouse-server:24-alpine')).toBe('clickhouse');
    expect(detectInfraDataKind('nginx:alpine')).toBeNull();
  });

  it('postgres: password via -e PGPASSWORD, sql via stdin, secret tracked', () => {
    const ex = buildInfraDataExec(svc('postgres:16-alpine', { POSTGRES_USER: 'app', POSTGRES_PASSWORD: 'pw1', POSTGRES_DB: 'app' }), 'query', 'SELECT 1;');
    expect(ex.kind).toBe('postgres');
    expect(ex.argv).toContain('psql');
    expect(ex.argv).toContain('-e');
    expect(ex.argv).toContain('PGPASSWORD=pw1');
    expect(ex.argv).toEqual(expect.arrayContaining(['-U', 'app', '-d', 'app']));
    expect(ex.stdin).toBe('SELECT 1;');
    expect(ex.secretValues).toEqual(['pw1']);
  });

  it('postgres schema uses the canned information_schema query', () => {
    const ex = buildInfraDataExec(svc('postgres:16-alpine', { POSTGRES_USER: 'app', POSTGRES_PASSWORD: 'pw', POSTGRES_DB: 'app' }), 'schema', '');
    expect(ex.stdin).toContain('information_schema.tables');
  });

  it('mysql: -u/-p flags + trailing db arg', () => {
    const ex = buildInfraDataExec(svc('mysql:8', { MYSQL_USER: 'app', MYSQL_PASSWORD: 'mp', MYSQL_DATABASE: 'app' }), 'query', 'SHOW TABLES;');
    expect(ex.argv).toContain('-uapp');
    expect(ex.argv).toContain('-pmp');
    expect(ex.argv[ex.argv.length - 1]).toBe('app');
    expect(ex.secretValues).toEqual(['mp']);
  });

  it('mongo: builds auth uri against the app db (default app, not admin), secret tracked', () => {
    const ex = buildInfraDataExec(svc('mongo:7', { MONGO_INITDB_ROOT_USERNAME: 'app', MONGO_INITDB_ROOT_PASSWORD: 'mpw' }), 'schema', '');
    expect(ex.argv.some((a) => a.includes('mongodb://app:mpw@localhost:27017/app?authSource=admin'))).toBe(true);
    // must NOT target the admin database (would hide the user's own collections)
    expect(ex.argv.some((a) => a.includes('/admin?'))).toBe(false);
    expect(ex.stdin).toBe('db.getCollectionNames();');
    expect(ex.secretValues).toEqual(['mpw']);
  });

  it('mongo: connects to MONGO_INITDB_DATABASE / svc.dbName when configured', () => {
    const byEnv = buildInfraDataExec(svc('mongo:7', { MONGO_INITDB_ROOT_USERNAME: 'app', MONGO_INITDB_ROOT_PASSWORD: 'mpw', MONGO_INITDB_DATABASE: 'shop' }), 'schema', '');
    expect(byEnv.argv.some((a) => a.includes('/shop?authSource=admin'))).toBe(true);
    // svc.dbName (the SSOT field) wins over the env mirror
    const byField = buildInfraDataExec(svc('mongo:7', { MONGO_INITDB_ROOT_USERNAME: 'app', MONGO_INITDB_ROOT_PASSWORD: 'mpw', MONGO_INITDB_DATABASE: 'shop' }, { dbName: 'orders' }), 'schema', '');
    expect(byField.argv.some((a) => a.includes('/orders?authSource=admin'))).toBe(true);
  });

  it('redis schema => SCAN, no secret', () => {
    const ex = buildInfraDataExec(svc('redis:7-alpine'), 'schema', '');
    expect(ex.stdin).toBe('SCAN 0 COUNT 100');
    expect(ex.argv).toContain('redis-cli');
    expect(ex.secretValues).toEqual([]);
  });

  it('redis: honours requirepass via -a + --no-auth-warning, tracks secret', () => {
    const ex = buildInfraDataExec(svc('redis:7-alpine', { REDIS_PASSWORD: 'rpw' }), 'query', 'PING');
    expect(ex.argv).toEqual(expect.arrayContaining(['redis-cli', '-a', 'rpw', '--no-auth-warning']));
    expect(ex.secretValues).toEqual(['rpw']);
  });

  it('redis: no password stays bare (backward compat — catalog redis has no auth)', () => {
    const ex = buildInfraDataExec(svc('redis:7-alpine'), 'query', 'PING');
    expect(ex.argv).toEqual(['exec', '-i', 'cds-infra-p-db', 'redis-cli']);
    expect(ex.secretValues).toEqual([]);
  });

  it('clickhouse uses --multiquery + credentials', () => {
    const ex = buildInfraDataExec(svc('clickhouse/clickhouse-server:24-alpine', { CLICKHOUSE_USER: 'app', CLICKHOUSE_PASSWORD: 'cpw', CLICKHOUSE_DB: 'app' }), 'init-sql', 'CREATE TABLE t (a Int32) ENGINE=Memory;');
    expect(ex.argv).toContain('clickhouse-client');
    expect(ex.argv).toContain('--multiquery');
    expect(ex.secretValues).toEqual(['cpw']);
  });

  it('unsupported image throws', () => {
    expect(() => buildInfraDataExec(svc('nginx:alpine'), 'query', 'x')).toThrow(/不支持/);
  });

  it('empty query throws', () => {
    expect(() => buildInfraDataExec(svc('postgres:16-alpine'), 'query', '   ')).toThrow(/不能为空/);
  });
});

describe('maskSecretValues', () => {
  it('masks secret occurrences (>=3 chars)', () => {
    expect(maskSecretValues('url=postgresql://app:supersecret@host', ['supersecret'])).toBe('url=postgresql://app:***@host');
  });
  it('leaves short/empty secrets alone', () => {
    expect(maskSecretValues('abc', ['xy'])).toBe('abc');
    expect(maskSecretValues('abc', [''])).toBe('abc');
  });
});
