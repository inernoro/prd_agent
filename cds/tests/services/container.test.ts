import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import { ContainerService } from '../../src/services/container.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import type { CdsConfig, BranchEntry, BuildProfile, ServiceState } from '../../src/types.js';

const makeConfig = (): CdsConfig => ({
  repoRoot: '/repo',
  worktreeBase: '/wt',
  masterPort: 9900,
  workerPort: 5500,
  dockerNetwork: 'cds-network',
  portStart: 10001,
  sharedEnv: {
    MONGODB_HOST: 'db:27017',
    REDIS_HOST: 'redis:6379',
  },
  jwt: { secret: 'test-secret', issuer: 'prdagent' },
});

const makeEntry = (): BranchEntry => ({
  id: 'feature-a',
  branch: 'feature/a',
  worktreePath: '/wt/feature-a',
  services: {},
  status: 'idle',
  createdAt: '2026-02-12T00:00:00Z',
});

const makeProfile = (overrides?: Partial<BuildProfile>): BuildProfile => ({
  id: 'api',
  name: 'API',
  dockerImage: 'mcr.microsoft.com/dotnet/sdk:8.0',
  workDir: 'prd-api',
  command: 'dotnet restore && dotnet watch run',
  containerPort: 8080,
  ...overrides,
});

const makeService = (): ServiceState => ({
  profileId: 'api',
  containerName: 'cds-feature-a-api',
  hostPort: 10001,
  status: 'building',
});

describe('ContainerService', () => {
  let mock: MockShellExecutor;
  let service: ContainerService;

  beforeEach(() => {
    mock = new MockShellExecutor();
    service = new ContainerService(mock, makeConfig());
  });

  describe('runService', () => {
    it('should run docker container with correct mounts and env', async () => {
      mock.addResponsePattern(/docker network inspect/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/docker rm -f/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/docker run/, () => ({ stdout: 'cid123', stderr: '', exitCode: 0 }));

      // Spy on writeFileSync to capture the env file content
      const writeSpy = vi.spyOn(fs, 'writeFileSync');

      await service.runService(makeEntry(), makeProfile(), makeService());

      const runCmd = mock.commands.find(c => c.includes('docker run -d'));
      expect(runCmd).toBeDefined();
      expect(runCmd).toContain('--name cds-feature-a-api');
      expect(runCmd).toContain('--network cds-network');
      expect(runCmd).toContain('-p 10001:8080');
      expect(runCmd).toContain('-v "/wt/feature-a/prd-api":"/app"');
      expect(runCmd).toContain('--env-file');
      expect(runCmd).toContain('dotnet restore && dotnet watch run');

      // Should have CDS labels
      expect(runCmd).toContain('--label cds.managed=true');
      expect(runCmd).toContain('--label cds.type=app');
      expect(runCmd).toContain('--label cds.branch.id=feature-a');
      expect(runCmd).toContain('--label cds.profile.id=api');

      // Verify env file contents
      const envFileContent = writeSpy.mock.calls[0][1] as string;
      expect(envFileContent).toContain('Jwt__Secret=test-secret');
      expect(envFileContent).toContain('Jwt__Issuer=prdagent');

      writeSpy.mockRestore();
    });

    it('should run a single docker command (no 3-step)', async () => {
      mock.addResponsePattern(/docker network inspect/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/docker rm -f/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/docker run/, () => ({ stdout: 'ok', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/mkdir/, () => ({ stdout: '', stderr: '', exitCode: 0 }));

      const profile = makeProfile({
        command: 'pnpm install && pnpm build && pnpm start',
        cacheMounts: [{ hostPath: '/cache/node_modules', containerPath: '/app/node_modules' }],
      });

      await service.runService(makeEntry(), profile, makeService());

      // Should have exactly 1 docker run call (persistent container)
      const dockerRuns = mock.commands.filter(c => c.includes('docker run'));
      expect(dockerRuns).toHaveLength(1);
      expect(dockerRuns[0]).toContain('docker run -d');
      expect(dockerRuns[0]).toContain('pnpm install && pnpm build && pnpm start');
    });

    it('should mount shared caches', async () => {
      mock.addResponsePattern(/docker network inspect/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/docker rm -f/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/docker run/, () => ({ stdout: 'ok', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/mkdir/, () => ({ stdout: '', stderr: '', exitCode: 0 }));

      const profile = makeProfile({
        cacheMounts: [
          { hostPath: '/cache/nuget', containerPath: '/root/.nuget' },
        ],
      });

      await service.runService(makeEntry(), profile, makeService());

      const runCmd = mock.commands.find(c => c.includes('docker run -d'));
      expect(runCmd).toContain('-v "/cache/nuget":"/root/.nuget"');
    });

    it('should throw if docker run fails', async () => {
      mock.addResponsePattern(/docker network inspect/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/docker rm -f/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/docker run/, () => ({ stdout: '', stderr: 'port in use', exitCode: 125 }));

      await expect(service.runService(makeEntry(), makeProfile(), makeService())).rejects.toThrow('启动服务');
    });

    it('should throw if command is missing', async () => {
      mock.addResponsePattern(/docker network inspect/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/docker rm -f/, () => ({ stdout: '', stderr: '', exitCode: 0 }));

      const profile = makeProfile({ command: undefined });
      await expect(service.runService(makeEntry(), profile, makeService())).rejects.toThrow('缺少 command 字段');
    });
  });

  describe('stop', () => {
    it('should stop and remove container', async () => {
      mock.addResponsePattern(/docker stop/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/docker rm/, () => ({ stdout: '', stderr: '', exitCode: 0 }));

      await service.stop('cds-feature-a-api');
      expect(mock.commands[0]).toContain('docker stop cds-feature-a-api');
      expect(mock.commands[1]).toContain('docker rm cds-feature-a-api');
    });
  });

  describe('isRunning', () => {
    it('should return true if container is running', async () => {
      mock.addResponsePattern(/docker inspect/, () => ({ stdout: 'true', stderr: '', exitCode: 0 }));
      expect(await service.isRunning('c')).toBe(true);
    });

    it('should return false if container is not running', async () => {
      mock.addResponsePattern(/docker inspect/, () => ({ stdout: 'false', stderr: '', exitCode: 0 }));
      expect(await service.isRunning('c')).toBe(false);
    });

    it('should return false if container does not exist', async () => {
      mock.addResponsePattern(/docker inspect/, () => ({ stdout: '', stderr: 'No such object', exitCode: 1 }));
      expect(await service.isRunning('c')).toBe(false);
    });
  });

  describe('getLogs', () => {
    it('should return container logs', async () => {
      mock.addResponsePattern(/docker logs/, () => ({ stdout: 'log output', stderr: '', exitCode: 0 }));
      const logs = await service.getLogs('c');
      expect(logs).toContain('log output');
    });
  });
});
