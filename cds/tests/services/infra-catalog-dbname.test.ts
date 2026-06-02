/**
 * infra-catalog 自定义数据库名 / 初始化SQL 测试 — 2026-06-02 用户反馈:
 *   "数据库得包含初始化语句、库名配置" + 质疑"连接串真能自动推导重建吗?"
 * 锁定:dbName 正确 thread 进容器初始化变量(POSTGRES_DB 等) + 连接串(DATABASE_URL 等),
 * 默认回落 app(向后兼容),非法字符被 sanitize。这就是"自动推导连接串"的确定性证明。
 */
import { describe, it, expect } from 'vitest';
import { getInfraCatalogEntry, sanitizeDbName } from '../../src/services/infra-catalog.js';

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
});
