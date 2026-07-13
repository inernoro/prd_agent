import { describe, expect, it } from 'vitest';
import type { BuildProfile, InfraService } from '../../src/types.js';
import { selectSqlInitInfra } from '../../src/services/database-init-selection.js';

function infra(id: string, status: InfraService['status'] = 'running', name = id): InfraService {
  return {
    id,
    projectId: 'prd-agent',
    name,
    dockerImage: 'postgres:16',
    containerPort: 5432,
    hostPort: 15432,
    containerName: `prd-agent-${id}`,
    status,
    volumes: [],
    env: {},
    createdAt: '2026-07-14T00:00:00.000Z',
  };
}

function profile(dependsOn?: string[]): Pick<BuildProfile, 'id' | 'name' | 'dependsOn'> {
  return { id: 'api', name: 'API', dependsOn };
}

describe('SQL initialization target selection', () => {
  it('selects the unique running SQL service declared by id', () => {
    const primary = infra('postgres-primary');
    const audit = infra('postgres-audit');
    expect(selectSqlInitInfra([primary, audit], profile(['postgres-audit']))).toBe(audit);
  });

  it('selects the unique running SQL service declared by compose service name', () => {
    const primary = infra('postgres-1', 'running', 'primary-db');
    const audit = infra('postgres-2', 'running', 'audit-db');
    expect(selectSqlInitInfra([primary, audit], profile(['audit-db']))).toBe(audit);
  });

  it('rejects a profile that declares multiple SQL services', () => {
    expect(() => selectSqlInitInfra(
      [infra('postgres-primary'), infra('postgres-audit')],
      profile(['postgres-primary', 'postgres-audit']),
    )).toThrow('同时依赖多个 SQL 服务');
  });

  it('uses the only running SQL service when no dependency is declared', () => {
    const running = infra('postgres-primary');
    expect(selectSqlInitInfra(
      [running, infra('postgres-audit', 'stopped')],
      profile(),
    )).toBe(running);
  });

  it('rejects multiple running SQL services when no dependency is declared', () => {
    expect(() => selectSqlInitInfra(
      [infra('postgres-primary'), infra('postgres-audit')],
      profile(),
    )).toThrow('未通过 dependsOn 唯一声明初始化目标');
  });

  it('rejects a declared stopped SQL service instead of falling back to another database', () => {
    expect(() => selectSqlInitInfra(
      [infra('postgres-primary'), infra('postgres-audit', 'stopped')],
      profile(['postgres-audit']),
    )).toThrow('声明的 SQL 服务“postgres-audit”未运行');
  });

  it('rejects projects without a SQL service', () => {
    expect(() => selectSqlInitInfra([], profile())).toThrow('项目没有 PostgreSQL/MySQL/MariaDB 服务');
  });
});
