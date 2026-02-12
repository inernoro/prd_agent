import { describe, it, expect, beforeEach } from 'vitest';
import { ContainerService } from '../../src/services/container.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import type { BranchEntry, BtConfig } from '../../src/types.js';

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
  mongodb: { containerHost: 'mongodb', port: 27017, defaultDbName: 'prdagent' },
  redis: { connectionString: 'redis:6379' },
  jwt: { secret: 'test-secret', issuer: 'prdagent' },
  dashboard: { port: 9900 },
});

const makeEntry = (overrides?: Partial<BranchEntry>): BranchEntry => ({
  id: 'feature-a',
  branch: 'feature/a',
  worktreePath: '/wt/feature-a',
  containerName: 'prdagent-api-feature-a',
  imageName: 'prdagent-server:feature-a',
  dbName: 'prdagent_1',
  status: 'idle',
  createdAt: '2026-02-12T00:00:00Z',
  ...overrides,
});

describe('ContainerService', () => {
  let mock: MockShellExecutor;
  let service: ContainerService;
  const config = makeConfig();

  beforeEach(() => {
    mock = new MockShellExecutor();
    service = new ContainerService(mock, config);
  });

  describe('start', () => {
    it('should run docker container with correct env vars', async () => {
      mock.addResponsePattern(/docker run/, () => ({ stdout: 'abc123', stderr: '', exitCode: 0 }));

      const entry = makeEntry();
      await service.start(entry);

      const cmd = mock.commands[0];
      expect(cmd).toContain('docker run -d');
      expect(cmd).toContain('--name prdagent-api-feature-a');
      expect(cmd).toContain('--network prdagent-network');
      expect(cmd).toContain('MongoDB__DatabaseName=prdagent_1');
      expect(cmd).toContain('MongoDB__ConnectionString=mongodb://mongodb:27017');
      expect(cmd).toContain('Redis__ConnectionString=redis:6379');
      expect(cmd).toContain('Jwt__Secret=test-secret');
      expect(cmd).toContain('prdagent-server:feature-a');
    });

    it('should throw if docker run fails', async () => {
      mock.addResponsePattern(/docker run/, () => ({
        stdout: '',
        stderr: 'name already in use',
        exitCode: 125,
      }));

      await expect(service.start(makeEntry())).rejects.toThrow('start');
    });
  });

  describe('stop', () => {
    it('should stop and remove container', async () => {
      mock.addResponsePattern(/docker stop/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/docker rm/, () => ({ stdout: '', stderr: '', exitCode: 0 }));

      await service.stop('prdagent-api-feature-a');
      expect(mock.commands[0]).toContain('docker stop prdagent-api-feature-a');
      expect(mock.commands[1]).toContain('docker rm prdagent-api-feature-a');
    });

    it('should not throw if container does not exist on rm', async () => {
      mock.addResponsePattern(/docker stop/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/docker rm/, () => ({
        stdout: '',
        stderr: 'No such container',
        exitCode: 1,
      }));

      await expect(service.stop('gone')).resolves.not.toThrow();
    });
  });

  describe('isRunning', () => {
    it('should return true if container is running', async () => {
      mock.addResponsePattern(/docker inspect/, () => ({
        stdout: 'true',
        stderr: '',
        exitCode: 0,
      }));

      const running = await service.isRunning('prdagent-api-feature-a');
      expect(running).toBe(true);
    });

    it('should return false if container is not running', async () => {
      mock.addResponsePattern(/docker inspect/, () => ({
        stdout: 'false',
        stderr: '',
        exitCode: 0,
      }));

      const running = await service.isRunning('c-stopped');
      expect(running).toBe(false);
    });

    it('should return false if container does not exist', async () => {
      mock.addResponsePattern(/docker inspect/, () => ({
        stdout: '',
        stderr: 'No such object',
        exitCode: 1,
      }));

      const running = await service.isRunning('c-missing');
      expect(running).toBe(false);
    });
  });

  describe('removeImage', () => {
    it('should remove docker image', async () => {
      mock.addResponsePattern(/docker rmi/, () => ({ stdout: '', stderr: '', exitCode: 0 }));

      await service.removeImage('prdagent-server:feature-a');
      expect(mock.commands[0]).toContain('docker rmi prdagent-server:feature-a');
    });
  });
});
