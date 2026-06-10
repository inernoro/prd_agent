import { describe, expect, it } from 'vitest';
import { buildUnifiedBranchResources } from '../../src/services/resources.js';
import type { BranchEntry, InfraService } from '../../src/types.js';

describe('buildUnifiedBranchResources', () => {
  it('uses branch-scoped database names and users in infra connection strings', () => {
    const branch: BranchEntry = {
      id: 'main-branch',
      projectId: 'prd-agent',
      branch: 'main',
      worktreePath: '/tmp/main',
      status: 'running',
      createdAt: '2026-06-10T00:00:00.000Z',
      lastDeployAt: '2026-06-10T00:00:00.000Z',
      services: {},
    };
    const createdAt = '2026-06-10T00:00:00.000Z';
    const infraServices: InfraService[] = [
      {
        id: 'postgres-main',
        projectId: 'prd-agent',
        name: 'PostgreSQL 16',
        dockerImage: 'postgres:16',
        containerPort: 5432,
        hostPort: 5432,
        containerName: 'cds-postgres-main',
        status: 'running',
        dbName: 'shared_pg',
        env: { POSTGRES_DB: 'shared_pg', POSTGRES_USER: 'postgres' },
        volumes: [],
        createdAt,
      },
      {
        id: 'mongo-main',
        projectId: 'prd-agent',
        name: 'MongoDB 7',
        dockerImage: 'mongo:7',
        containerPort: 27017,
        hostPort: 27017,
        containerName: 'cds-mongo-main',
        status: 'running',
        dbName: 'shared_mongo',
        env: {
          MONGO_INITDB_DATABASE: 'shared_mongo',
          MONGO_INITDB_ROOT_USERNAME: 'root',
        },
        volumes: [],
        createdAt,
      },
    ];

    const resources = buildUnifiedBranchResources({
      branch,
      profiles: [],
      infraServices,
      branchEnv: {
        MYSQL_DATABASE: 'wrong_mysql',
        POSTGRES_DB: 'branch_pg',
        POSTGRES_USER: 'branch_pg_user',
        MONGODB_DATABASE: 'branch_mongo',
        MONGODB_USERNAME: 'branch_mongo_user',
        MONGODB_AUTH_SOURCE: 'branch_mongo',
      },
    });

    expect(resources.find((resource) => resource.id === 'infra:postgres-main')?.connectionString)
      .toBe('postgres://branch_pg_user:******@postgres-main:5432/branch_pg');
    expect(resources.find((resource) => resource.id === 'infra:mongo-main')?.connectionString)
      .toBe('mongodb://branch_mongo_user:******@mongo-main:27017/branch_mongo?authSource=branch_mongo');
  });
});
