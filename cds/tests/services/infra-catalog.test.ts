import { describe, it, expect } from 'vitest';
import {
  INFRA_CATALOG,
  getInfraCatalogEntry,
  infraCatalogIds,
  recommendedVolumePathsFromCatalog,
  getInfraCatalogPublic,
} from '../../src/services/infra-catalog.js';
import { detectInfraAuth } from '../../src/services/infra-exposure-audit.js';

/**
 * Infra catalog SSOT tests.
 *
 * Guards two things:
 *   1. Backward compatibility — the historical 5 presets (mongodb/postgres/mysql/
 *      redis/rabbitmq) must produce byte-identical env + connection strings, so
 *      existing projects keep working after the registry refactor.
 *   2. The catalog is the single source of truth — new infra (kafka/nats/...) is
 *      reachable, and the public view never leaks secrets.
 *
 * See doc/spec.cds.compose-contract.md and cds/src/routes/projects.ts createInfraPreset.
 */

describe('infra-catalog SSOT', () => {
  it('has unique ids and includes the historical presets plus the new message queues', () => {
    const ids = infraCatalogIds();
    expect(new Set(ids).size).toBe(ids.length); // no duplicates
    for (const required of ['mongodb', 'postgres', 'mysql', 'redis', 'rabbitmq', 'kafka', 'nats']) {
      expect(ids).toContain(required);
    }
  });

  it('every entry builds at least one app-visible connection env var', () => {
    for (const entry of INFRA_CATALOG) {
      const secrets: Record<string, string> = {};
      for (const k of entry.secretKeys || []) secrets[k] = 'SEKRET';
      const built = entry.build(secrets);
      expect(Object.keys(built.envVars || {}).length).toBeGreaterThan(0);
    }
  });

  it('reproduces the legacy postgres preset exactly', () => {
    const pg = getInfraCatalogEntry('postgres');
    expect(pg).toBeDefined();
    const built = pg!.build({ password: 'pw123' });
    expect(pg!.dockerImage).toBe('postgres:16-alpine');
    expect(pg!.containerPort).toBe(5432);
    expect(built.env).toEqual({ POSTGRES_USER: 'app', POSTGRES_PASSWORD: 'pw123', POSTGRES_DB: 'app' });
    expect(built.envVars).toEqual({
      DATABASE_URL: 'postgresql://app:pw123@postgres:5432/app',
      POSTGRES_URL: 'postgresql://app:pw123@postgres:5432/app',
    });
  });

  it('reproduces the legacy rabbitmq preset (image + url + volume path)', () => {
    const rmq = getInfraCatalogEntry('rabbitmq');
    expect(rmq!.dockerImage).toBe('rabbitmq:3-management-alpine');
    const built = rmq!.build({ password: 'secret9' });
    expect(built.env).toEqual({ RABBITMQ_DEFAULT_USER: 'app', RABBITMQ_DEFAULT_PASS: 'secret9' });
    expect(built.envVars).toEqual({ RABBITMQ_URL: 'amqp://app:secret9@rabbitmq:5672' });
    expect(recommendedVolumePathsFromCatalog('rabbitmq:3-management-alpine')).toEqual(['/var/lib/rabbitmq']);
  });

  /**
   * 这条原来叫「redis preset stays password-free (legacy behaviour)」，逐字要求
   * redis 建出来**没有口令**——它把一个真实漏洞锁成了契约：谁给 redis 补认证，
   * 谁的 CI 先红。而公网暴露一旦发生，一个没有 requirepass 的 redis 就是裸奔。
   *
   * 现在反过来断言：redis 必须带口令，且口令**不许出现在启动命令行里**
   * （那会散进宿主 ps、CDS 记录的 docker run 字符串和容器事件日志）。
   */
  it('redis 预设带口令，且口令只走 env 不进命令行', () => {
    const entry = getInfraCatalogEntry('redis')!;
    expect(entry.secretKeys).toEqual(['password']);

    const built = entry.build({ password: 'p4ssw0rd' });
    expect(built.env).toEqual({ REDIS_PASSWORD: 'p4ssw0rd' });
    expect(built.envVars).toEqual({ REDIS_URL: 'redis://:p4ssw0rd@redis:6379' });

    // 启动命令必须是数组形态（每个 token 单独 shell-quote），且只引用变量名。
    const cmd = entry.command as string[];
    expect(Array.isArray(cmd)).toBe(true);
    expect(cmd.join(' ')).toContain('--requirepass "$REDIS_PASSWORD"');
    expect(cmd.join(' ')).not.toContain('p4ssw0rd');
    // `${VAR}` 会被 CDS 的模板替换吃掉（宿主侧没有这个变量 → 展开成空 →
    // redis 拿到空口令 FATAL 无限重启，2026-05-29 真出过）。必须是不带花括号的 $VAR。
    expect(cmd.join(' ')).not.toContain('${REDIS_PASSWORD}');
  });

  it('kafka uses KRaft (no zookeeper) and advertises itself as kafka:9092', () => {
    const kafka = getInfraCatalogEntry('kafka')!;
    expect(kafka.category).toBe('queue');
    const built = kafka.build({});
    expect(built.env?.KAFKA_PROCESS_ROLES).toContain('controller');
    expect(built.env?.KAFKA_ADVERTISED_LISTENERS).toContain('kafka:9092');
    expect(built.envVars?.KAFKA_BROKERS).toBe('kafka:9092');
  });

  it('sqlserver password satisfies complexity policy (3 of 4 classes)', () => {
    const built = getInfraCatalogEntry('sqlserver')!.build({ saPassword: 'abc123def' });
    expect(built.env?.MSSQL_SA_PASSWORD).toBe('abc123defAa1_');
    expect(built.envVars?.SQLSERVER_URL).toContain('abc123defAa1_');
  });

  it('volume heuristic still covers custom images not in the catalog', () => {
    expect(recommendedVolumePathsFromCatalog('bitnami/postgresql:15')).toEqual(['/var/lib/postgresql/data']);
    expect(recommendedVolumePathsFromCatalog('mariadb:11')).toEqual(['/var/lib/mysql']);
    expect(recommendedVolumePathsFromCatalog('nginx:alpine')).toBeNull();
  });

  it('public catalog view exposes connection key NAMES but never secret values', () => {
    const pub = getInfraCatalogPublic();
    const pg = pub.find((p) => p.id === 'postgres')!;
    expect(pg.connectionEnvKeys).toContain('DATABASE_URL');
    expect(pg.categoryLabel).toBe('数据库');
    expect(pg.hasPersistence).toBe(true);
    // The serialized public view must not contain any built secret value.
    const serialized = JSON.stringify(pub);
    expect(serialized).not.toContain('postgresql://'); // no connection-string values
    expect(serialized.toLowerCase()).not.toContain('password');
  });
});

/**
 * 接线守卫：catalog 补的认证，必须真的被**暴露审计**认出来。
 *
 * 这两个模块各自看着都对，却可能对不上：catalog 生成 `REDIS_PASSWORD`，而审计
 * 若只认 `REDIS_PASS`，公网上的库照样被报成「无认证 critical」——补了认证的库
 * 继续刷红，真裸奔的那些反而淹没在里面。反过来更糟：审计认了、catalog 其实没给，
 * 一个裸奔库被标成「已配置认证」。所以判据只能是「拿 catalog 真的建出来的东西
 * 去喂审计」，不能两边各自断言自己那一半。
 */
describe('catalog 的认证能被暴露审计认出来', () => {
  it('redis：建出来的 env + 启动命令都判为已认证', () => {
    const entry = getInfraCatalogEntry('redis')!;
    const built = entry.build({ password: 'hex0123456789' });
    const cmd = entry.command as string[];

    // env 这一路（数据面板、备份探测走的也是它）
    expect(detectInfraAuth('redis', built.env, [])).toBe(true);
    // 容器的真实形状：env 有值 + Cmd 里引用它。`sh -c` 把整条语句塞进一个 Cmd
    // 元素，审计必须自己再拆一层才比得中 --requirepass。
    expect(detectInfraAuth('redis', built.env, cmd)).toBe(true);
    // 引用了一个没有值的变量 = redis 拿到空口令（会 FATAL），不许判成已认证
    expect(detectInfraAuth('redis', {}, cmd)).toBe(false);
    // 直接写明文的 compose 配法照样认
    expect(detectInfraAuth('redis', {}, ['sh', '-c', 'redis-server --requirepass hunter2'])).toBe(true);
    // 空口令不算认证
    expect(detectInfraAuth('redis', {}, ['sh', '-c', 'redis-server --requirepass ""'])).toBe(false);
    // 两路都没有才该判裸奔——对照组，防止判据恒真
    expect(detectInfraAuth('redis', {}, [])).toBe(false);
  });

  it('仍然没有认证的预设要如实暴露，不许假装已修', () => {
    // memcached / kafka / nats 这一轮没补（SASL / token 是各自独立的一摊配置）。
    // 台账 E16 记着它们；这里钉住现状，等哪天补了，这条会红，提醒同步台账与 runbook。
    for (const id of ['memcached', 'kafka', 'nats']) {
      const built = getInfraCatalogEntry(id)!.build({});
      const hasSecret = !!getInfraCatalogEntry(id)!.secretKeys?.length;
      expect(hasSecret, `${id} 已补密钥，请同步更新 doc/debt.cds.md E16 与轮换 runbook §4`).toBe(false);
      expect(built.env?.REDIS_PASSWORD).toBeUndefined();
    }
  });
});
