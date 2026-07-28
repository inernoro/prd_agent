import { describe, it, expect } from 'vitest';
import { rewriteRelationalUrlDb } from '../../src/services/replica-db-clone.js';

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
