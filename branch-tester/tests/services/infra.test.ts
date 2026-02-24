import { describe, it, expect, beforeEach } from 'vitest';
import { InfraService } from '../../src/services/infra.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import type { BtConfig } from '../../src/types.js';

const makeConfig = (): BtConfig => ({
  repoRoot: '/repo',
  worktreeBase: '/wt',
  deployDir: 'deploy',
  gateway: { containerName: 'prdagent-gateway', port: 5500 },
  docker: {
    network: 'prdagent-network',
    apiDockerfile: 'prd-api/Dockerfile',
    apiImagePrefix: 'prdagent-server',
    containerPrefix: 'prdagent-api',
  },
  mongodb: { containerHost: 'prdagent-mongodb', port: 27017, defaultDbName: 'prdagent' },
  redis: { connectionString: 'prdagent-redis:6379' },
  jwt: { secret: 'test-secret', issuer: 'prdagent' },
  dashboard: { port: 9900 },
});

describe('InfraService', () => {
  let mock: MockShellExecutor;
  let service: InfraService;

  beforeEach(() => {
    mock = new MockShellExecutor();
    service = new InfraService(mock, makeConfig());
    // Network already exists by default
    mock.addResponsePattern(/docker network inspect prdagent-network/, () => ({
      stdout: '[]', stderr: '', exitCode: 0,
    }));
  });

  it('should report all containers running when they are', async () => {
    // All infra containers running
    mock.addResponsePattern(/docker inspect.*"prdagent-mongodb"/, () => ({
      stdout: 'true', stderr: '', exitCode: 0,
    }));
    mock.addResponsePattern(/docker inspect.*"prdagent-redis"/, () => ({
      stdout: 'true', stderr: '', exitCode: 0,
    }));
    mock.addResponsePattern(/docker inspect.*"prdagent-gateway"/, () => ({
      stdout: 'true', stderr: '', exitCode: 0,
    }));
    // Production API not running
    mock.addResponsePattern(/docker inspect.*"prdagent-api"/, () => ({
      stdout: 'false', stderr: '', exitCode: 0,
    }));

    const log = await service.ensure();
    const text = log.join('\n');
    expect(text).toContain('MongoDB');
    expect(text).toContain('running');
    // Should NOT call docker compose since everything is up
    expect(mock.commands.some((c) => c.includes('docker compose'))).toBe(false);
  });

  it('should start missing containers via docker compose', async () => {
    // MongoDB running, Redis + Gateway not
    mock.addResponsePattern(/docker inspect.*"prdagent-mongodb"/, () => ({
      stdout: 'true', stderr: '', exitCode: 0,
    }));

    let redisChecks = 0;
    mock.addResponsePattern(/docker inspect.*"prdagent-redis"/, () => {
      redisChecks++;
      return redisChecks === 1
        ? { stdout: '', stderr: 'No such object', exitCode: 1 }
        : { stdout: 'true', stderr: '', exitCode: 0 };
    });

    let gwChecks = 0;
    mock.addResponsePattern(/docker inspect.*"prdagent-gateway"/, () => {
      gwChecks++;
      return gwChecks === 1
        ? { stdout: '', stderr: 'No such object', exitCode: 1 }
        : { stdout: 'true', stderr: '', exitCode: 0 };
    });

    mock.addResponsePattern(/docker compose up/, () => ({
      stdout: 'done', stderr: '', exitCode: 0,
    }));

    // Production API not running
    mock.addResponsePattern(/docker inspect.*"prdagent-api"/, () => ({
      stdout: 'false', stderr: '', exitCode: 0,
    }));

    const log = await service.ensure();

    const composeCmd = mock.commands.find((c) => c.includes('docker compose up'));
    expect(composeCmd).toBeDefined();
    expect(composeCmd).toContain('redis');
    expect(composeCmd).toContain('gateway');
    expect(composeCmd).not.toContain('mongodb');
  });

  it('should stop production prdagent-api if running', async () => {
    // All infra running
    mock.addResponsePattern(/docker inspect.*"prdagent-mongodb"/, () => ({
      stdout: 'true', stderr: '', exitCode: 0,
    }));
    mock.addResponsePattern(/docker inspect.*"prdagent-redis"/, () => ({
      stdout: 'true', stderr: '', exitCode: 0,
    }));
    mock.addResponsePattern(/docker inspect.*"prdagent-gateway"/, () => ({
      stdout: 'true', stderr: '', exitCode: 0,
    }));
    // Production API IS running
    mock.addResponsePattern(/docker inspect.*"prdagent-api"/, () => ({
      stdout: 'true', stderr: '', exitCode: 0,
    }));
    mock.addResponsePattern(/docker stop/, () => ({
      stdout: '', stderr: '', exitCode: 0,
    }));

    const log = await service.ensure();
    const text = log.join('\n');

    expect(text).toContain('Stopping production API');
    expect(mock.commands.some((c) => c.includes('docker stop prdagent-api'))).toBe(true);
  });

  it('should create Docker network if it does not exist', async () => {
    // Override: network does NOT exist
    mock.clearPatterns();
    mock.addResponsePattern(/docker network inspect prdagent-network/, () => ({
      stdout: '', stderr: 'No such network', exitCode: 1,
    }));
    mock.addResponsePattern(/docker network create prdagent-network/, () => ({
      stdout: 'abc123', stderr: '', exitCode: 0,
    }));
    // All infra running
    mock.addResponsePattern(/docker inspect.*"prdagent-mongodb"/, () => ({
      stdout: 'true', stderr: '', exitCode: 0,
    }));
    mock.addResponsePattern(/docker inspect.*"prdagent-redis"/, () => ({
      stdout: 'true', stderr: '', exitCode: 0,
    }));
    mock.addResponsePattern(/docker inspect.*"prdagent-gateway"/, () => ({
      stdout: 'true', stderr: '', exitCode: 0,
    }));
    mock.addResponsePattern(/docker inspect.*"prdagent-api"/, () => ({
      stdout: 'false', stderr: '', exitCode: 0,
    }));

    const log = await service.ensure();
    const text = log.join('\n');
    expect(text).toContain('created');
    expect(mock.commands.some((c) => c.includes('docker network create'))).toBe(true);
  });

  it('should fall back to docker-compose v1 if v2 fails', async () => {
    // All infra running except gateway
    mock.addResponsePattern(/docker inspect.*"prdagent-mongodb"/, () => ({
      stdout: 'true', stderr: '', exitCode: 0,
    }));
    mock.addResponsePattern(/docker inspect.*"prdagent-redis"/, () => ({
      stdout: 'true', stderr: '', exitCode: 0,
    }));

    let gwChecks = 0;
    mock.addResponsePattern(/docker inspect.*"prdagent-gateway"/, () => {
      gwChecks++;
      return gwChecks === 1
        ? { stdout: '', stderr: '', exitCode: 1 }
        : { stdout: 'true', stderr: '', exitCode: 0 };
    });

    // docker compose v2 fails
    mock.addResponsePattern(/^docker compose/, () => ({
      stdout: '', stderr: 'not found', exitCode: 127,
    }));
    // docker-compose v1 succeeds
    mock.addResponsePattern(/^docker-compose/, () => ({
      stdout: 'done', stderr: '', exitCode: 0,
    }));

    mock.addResponsePattern(/docker inspect.*"prdagent-api"/, () => ({
      stdout: 'false', stderr: '', exitCode: 0,
    }));

    const log = await service.ensure();
    const text = log.join('\n');
    expect(text).toContain('docker-compose');
    expect(text).toContain('OK');
  });
});
