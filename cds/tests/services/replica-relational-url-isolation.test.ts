import { describe, it, expect } from 'vitest';
import { rewriteRelationalUrlDb, engineFromRelationalUrls, isRelationalUrl } from '../../src/services/replica-db-clone.js';

/**
 * 关系型隔离必须重写连接 URL（Codex 第三十二轮 P1）。
 *
 * CDS 的 mysql/postgres 预设注入 `DATABASE_URL: mysql://app:pw@mysql:3306/<db>`
 * ——**库名是 URL 路径里的字面量，而应用读的就是这个 URL**。此前隔离只改
 * MYSQL_DATABASE / POSTGRES_DB（服务端初始化变量），副本照旧写主库，控制面与
 * 隔离审计却双双报告「已隔离」：关系型的隔离一直是假的。
 */
describe('关系型连接 URL 的库名重写', () => {
  it('重写 mysql / postgres 预设 URL 的库名段，其余部分逐字保留', () => {
    expect(rewriteRelationalUrlDb('mysql://app:pw@mysql:3306/shop', 'shop', 'shop_rs_a1b2c3_res_1'))
      .toBe('mysql://app:pw@mysql:3306/shop_rs_a1b2c3_res_1');
    expect(rewriteRelationalUrlDb('postgresql://app:pw@postgres:5432/shop', 'shop', 'shop_rs_x_res_1'))
      .toBe('postgresql://app:pw@postgres:5432/shop_rs_x_res_1');
  });

  it('查询参数与片段原样保留（sslmode 之类不能丢）', () => {
    expect(rewriteRelationalUrlDb('postgresql://u:p@h:5432/shop?sslmode=require', 'shop', 'iso'))
      .toBe('postgresql://u:p@h:5432/iso?sslmode=require');
  });

  it('密码里含特殊字符也不破坏解析（只动最后一个路径段）', () => {
    expect(rewriteRelationalUrlDb('mysql://app:p%40ss%2Fword@mysql:3306/shop', 'shop', 'iso'))
      .toBe('mysql://app:p%40ss%2Fword@mysql:3306/iso');
  });

  it('库名段不等于源库时拒绝改写——指向别的库/别的实例的连接串不许乱动', () => {
    expect(rewriteRelationalUrlDb('mysql://app:pw@mysql:3306/other', 'shop', 'iso')).toBeNull();
  });

  it('不是 URL 形状就返回 null（不认识就不动）', () => {
    expect(rewriteRelationalUrlDb('Server=mysql;Database=shop;', 'shop', 'iso')).toBeNull();
    expect(rewriteRelationalUrlDb('', 'shop', 'iso')).toBeNull();
    expect(rewriteRelationalUrlDb('mysql://app:pw@mysql:3306', 'shop', 'iso')).toBeNull();
  });
});

describe('JDBC 复合 scheme（2026-07-27 真机核对）', () => {
  // 生产 CDS 上的标识中台(IMP)项目：库连接全部走 SPRING_DATASOURCE_URL /
  // *_DATASOURCE_URL / *_DB_URL 这类 jdbc: 形态。RELATIONAL_URL_SCHEME 一直
  // 声称识别 jdbc:mysql / jdbc:postgresql，但解析用的 scheme 段不含冒号，
  // JDBC URL 一律解析失败 → 收集阶段探测失败 → 根本进不了 urlEnvValues →
  // 静默不改写。第三十二轮修好的「关系型隔离是假的」在 Java 项目上原样复活。
  it('jdbc:mysql 连接串的库名段被改写，查询参数原样保留', () => {
    expect(rewriteRelationalUrlDb('jdbc:mysql://mysql:3306/impdb?useSSL=false&serverTimezone=UTC', 'impdb', 'impdb_rs_x'))
      .toBe('jdbc:mysql://mysql:3306/impdb_rs_x?useSSL=false&serverTimezone=UTC');
  });

  it('jdbc:postgresql 同样生效', () => {
    expect(rewriteRelationalUrlDb('jdbc:postgresql://pg:5432/impdb', 'impdb', 'impdb_rs_x'))
      .toBe('jdbc:postgresql://pg:5432/impdb_rs_x');
  });

  it('库名段对不上源库时仍然拒绝改写（不认识就不动的纪律不变）', () => {
    expect(rewriteRelationalUrlDb('jdbc:mysql://mysql:3306/otherdb', 'impdb', 'impdb_rs_x')).toBeNull();
  });
});

describe('引擎中立库名 key 的引擎判定（2026-07-28 真机验收补）', () => {
  // 生产 CDS 上标识中台(IMP)六个服务全部 dbIsolatable.ok=false，原因是库名写在
  // DB_NAME 里——名字不含引擎，三条框架模式都归类不了，隔离在入口就不可用，
  // JDBC 改写修好了也永远走不到。引擎只能从同 env 的连接 URL scheme 读。
  it('jdbc:mysql 连接串 → mysql', () => {
    expect(engineFromRelationalUrls({
      DB_NAME: 'impdb',
      SPRING_DATASOURCE_URL: 'jdbc:mysql://mysql:3306/impdb?useSSL=false',
    })).toBe('mysql');
  });

  it('postgres 系各种写法都归到 postgres', () => {
    expect(engineFromRelationalUrls({ X: 'jdbc:postgresql://pg:5432/d' })).toBe('postgres');
    expect(engineFromRelationalUrls({ X: 'postgres://u:p@pg:5432/d' })).toBe('postgres');
  });

  it('mariadb 归到 mysql（同协议族）', () => {
    expect(engineFromRelationalUrls({ X: 'mariadb://h:3306/d' })).toBe('mysql');
  });

  it('同时出现两种引擎 → null，绝不臆断（克隆错引擎比不能隔离危险得多）', () => {
    expect(engineFromRelationalUrls({
      A: 'jdbc:mysql://mysql:3306/d',
      B: 'jdbc:postgresql://pg:5432/d',
    })).toBeNull();
  });

  it('没有关系型 URL → null（mongo 项目不受影响，走它自己的 key 家族）', () => {
    expect(engineFromRelationalUrls({ MONGO_URI: 'mongodb://m:27017/d' })).toBeNull();
    expect(engineFromRelationalUrls({})).toBeNull();
  });
});

/**
 * 「能据此判引擎」与「要跟着改库名」必须是同一个答案（Codex PR #1275 二轮 P1）。
 *
 * 曾经是两条各写各的正则：探测认 jdbc:mariadb，改写集合却只列 jdbc:mysql /
 * jdbc:postgresql。于是 DB_NAME + SPRING_DATASOURCE_URL=jdbc:mariadb://... 的
 * Java 服务被判为可隔离，克隆照跑、库名 key 照改，但应用真正读的那条 JDBC URL
 * 不在改写集合里 —— 副本流量继续打源库，控制面还报「隔离成功」。
 */
describe('引擎探测与 URL 改写必须同口径', () => {
  const SCHEMES = [
    'mysql://h:3306/d', 'mariadb://h:3306/d',
    'postgres://h:5432/d', 'postgresql://h:5432/d',
    'jdbc:mysql://h:3306/d', 'jdbc:mariadb://h:3306/d',
    'jdbc:postgres://h:5432/d', 'jdbc:postgresql://h:5432/d',
  ];

  it('凡是能判出引擎的连接串，都必须被认成「要改写的 URL」', () => {
    for (const url of SCHEMES) {
      expect(engineFromRelationalUrls({ X: url })).not.toBeNull();
      expect(isRelationalUrl(url)).toBe(true);
    }
  });

  it('jdbc:mariadb 的库名段真的能改写（此前整条被漏掉）', () => {
    expect(rewriteRelationalUrlDb('jdbc:mariadb://mysql:3306/impdb?useSSL=false', 'impdb', 'impdb_rs_x'))
      .toBe('jdbc:mariadb://mysql:3306/impdb_rs_x?useSSL=false');
  });

  it('jdbc:postgres（不带 ql）同样不能漏', () => {
    expect(rewriteRelationalUrlDb('jdbc:postgres://pg:5432/impdb', 'impdb', 'impdb_rs_x'))
      .toBe('jdbc:postgres://pg:5432/impdb_rs_x');
  });

  it('非关系型的值一律不认（mongo 走自己的通道，别的字符串更不能碰）', () => {
    expect(isRelationalUrl('mongodb://m:27017/d')).toBe(false);
    expect(isRelationalUrl('redis://r:6379')).toBe(false);
    expect(isRelationalUrl('')).toBe(false);
    expect(isRelationalUrl(undefined)).toBe(false);
  });
});
