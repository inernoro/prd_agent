import { describe, it, expect } from 'vitest';
import {
  INFRA_CATALOG,
  getInfraCatalogEntry,
  infraCatalogIds,
  recommendedVolumePathsFromCatalog,
  getInfraCatalogPublic,
} from '../../src/services/infra-catalog.js';

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

  it('redis preset stays password-free (legacy behaviour)', () => {
    const redis = getInfraCatalogEntry('redis')!.build({});
    expect(redis.envVars).toEqual({ REDIS_URL: 'redis://redis:6379' });
    expect(redis.env).toBeUndefined();
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
