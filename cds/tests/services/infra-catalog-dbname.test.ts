/**
 * infra-catalog 自定义数据库名 / 初始化SQL 测试 — 2026-06-02 用户反馈:
 *   "数据库得包含初始化语句、库名配置" + 质疑"连接串真能自动推导重建吗?"
 * 锁定:dbName 正确 thread 进容器初始化变量(POSTGRES_DB 等) + 连接串(DATABASE_URL 等),
 * 默认回落 app(向后兼容),非法字符被 sanitize。这就是"自动推导连接串"的确定性证明。
 */
import { describe, it, expect } from 'vitest';
import { getInfraCatalogEntry, sanitizeDbName, instanceConnectionEnv, getInfraCatalogPublic } from '../../src/services/infra-catalog.js';

describe('infra-catalog 自定义数据库名', () => {
  it('postgres: dbName 同时进 env 与连接串', () => {
    const built = getInfraCatalogEntry('postgres')!.build({ password: 'secret' }, { dbName: 'shop_prod' });
    expect(built.env?.POSTGRES_DB).toBe('shop_prod');
    expect(built.envVars?.DATABASE_URL).toBe('postgresql://app:secret@postgres:5432/shop_prod');
    expect(built.envVars?.POSTGRES_URL).toBe('postgresql://app:secret@postgres:5432/shop_prod');
  });

  it('无 dbName 时回落 app(向后兼容)', () => {
    const built = getInfraCatalogEntry('postgres')!.build({ password: 'p' });
    expect(built.env?.POSTGRES_DB).toBe('app');
    expect(built.envVars?.DATABASE_URL).toBe('postgresql://app:p@postgres:5432/app');
  });

  it('mysql / mongodb / clickhouse 同样 honor dbName', () => {
    const mysql = getInfraCatalogEntry('mysql')!.build({ rootPassword: 'r', password: 'p' }, { dbName: 'orders' });
    expect(mysql.env?.MYSQL_DATABASE).toBe('orders');
    expect(mysql.envVars?.DATABASE_URL).toBe('mysql://app:p@mysql:3306/orders');
    expect(getInfraCatalogEntry('mongodb')!.build({ password: 'p' }, { dbName: 'orders' }).envVars?.MONGODB_URL)
      .toBe('mongodb://app:p@mongodb:27017/orders?authSource=admin');
    expect(getInfraCatalogEntry('clickhouse')!.build({ password: 'p' }, { dbName: 'analytics' }).envVars?.CLICKHOUSE_URL)
      .toBe('http://app:p@clickhouse:8123/analytics');
  });

  it('sanitizeDbName: 非法字符替换 + 空回落 app', () => {
    expect(sanitizeDbName('My DB!')).toBe('my_db');
    expect(sanitizeDbName('  shop-prod  ')).toBe('shop_prod');
    expect(sanitizeDbName('')).toBe('app');
    expect(sanitizeDbName(undefined)).toBe('app');
  });

  it('catalog 标记:数据库支持 dbName/initSql，缓存/队列不支持', () => {
    expect(getInfraCatalogEntry('postgres')!.supportsDbName).toBe(true);
    expect(getInfraCatalogEntry('postgres')!.supportsInitSql).toBe(true);
    expect(getInfraCatalogEntry('redis')!.supportsDbName).toBeUndefined();
    expect(getInfraCatalogEntry('kafka')!.supportsDbName).toBeUndefined();
  });

  it('mariadb: 作为一等预设进 catalog SSOT(消除 CLI↔catalog 漂移),honor dbName + mysql 协议串', () => {
    const entry = getInfraCatalogEntry('mariadb')!;
    expect(entry).toBeDefined();
    expect(entry.dockerImage).toBe('mariadb:11');
    expect(entry.supportsDbName).toBe(true);
    expect(entry.supportsInitSql).toBe(true);
    const built = entry.build({ rootPassword: 'r', password: 'p' }, { dbName: 'orders' });
    // mariadb 镜像识别 MYSQL_* 变量 → 数据面板/备份按 mysql 协议零改动复用
    expect(built.env?.MYSQL_DATABASE).toBe('orders');
    expect(built.env?.MYSQL_USER).toBe('app');
    expect(built.envVars?.DATABASE_URL).toBe('mysql://app:p@mariadb:3306/orders');
    expect(built.envVars?.MYSQL_URL).toBe('mysql://app:p@mariadb:3306/orders');
    // 出现在脱敏后的公开 catalog(GET /api/infra/catalog 据此渲染选择器)
    const pub = getInfraCatalogPublic().find((e) => e.id === 'mariadb');
    expect(pub?.category).toBe('database');
    expect(pub?.connectionEnvKeys).toEqual(expect.arrayContaining(['DATABASE_URL', 'MYSQL_URL']));
  });
});

describe('同类型多数据库实例 (instanceConnectionEnv)', () => {
  const pg = { DATABASE_URL: 'postgresql://app:pw@postgres:5432/analytics', POSTGRES_URL: 'postgresql://app:pw@postgres:5432/analytics' };

  it('第 1 个实例(idx 0):变量名 + host 零改动(向后兼容)', () => {
    const r = instanceConnectionEnv(pg, 'postgres', 'postgres', 0);
    expect(r.DATABASE_URL).toBe('postgresql://app:pw@postgres:5432/analytics');
    expect(r.DATABASE_URL_2).toBeUndefined();
  });

  it('第 2 个实例(idx 1):变量名加 _2 后缀 + host 改写到实例别名 postgres-2', () => {
    const r = instanceConnectionEnv(pg, 'postgres', 'postgres-2', 1);
    expect(r.DATABASE_URL_2).toBe('postgresql://app:pw@postgres-2:5432/analytics');
    expect(r.POSTGRES_URL_2).toBe('postgresql://app:pw@postgres-2:5432/analytics');
    expect(r.DATABASE_URL).toBeUndefined(); // 不污染第一个实例的变量名
  });

  it('第 3 个实例(idx 2):_3 后缀 + host=postgres-3', () => {
    const r = instanceConnectionEnv(pg, 'postgres', 'postgres-3', 2);
    expect(r.DATABASE_URL_3).toBe('postgresql://app:pw@postgres-3:5432/analytics');
  });

  it('mongodb 第 2 个实例:host 改写 + ?authSource 查询串保留', () => {
    const mongo = { MONGODB_URL: 'mongodb://app:pw@mongodb:27017/orders?authSource=admin' };
    const r = instanceConnectionEnv(mongo, 'mongodb', 'mongodb-2', 1);
    expect(r.MONGODB_URL_2).toBe('mongodb://app:pw@mongodb-2:27017/orders?authSource=admin');
  });
});
