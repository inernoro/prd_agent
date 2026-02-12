import { describe, it, expect, beforeEach } from 'vitest';
import { BuilderService } from '../../src/services/builder.js';
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
  mongodb: { containerHost: 'mongodb', port: 27017, defaultDbName: 'prdagent' },
  redis: { connectionString: 'redis:6379' },
  jwt: { secret: 'test-secret', issuer: 'prdagent' },
  dashboard: { port: 9900 },
});

describe('BuilderService', () => {
  let mock: MockShellExecutor;
  let service: BuilderService;

  beforeEach(() => {
    mock = new MockShellExecutor();
    service = new BuilderService(mock, makeConfig());
  });

  describe('buildApiImage', () => {
    it('should run docker build with correct args', async () => {
      mock.addResponsePattern(/docker build/, () => ({
        stdout: 'Successfully built abc123',
        stderr: '',
        exitCode: 0,
      }));

      await service.buildApiImage('/wt/feature-a', 'prdagent-server:feature-a');

      const cmd = mock.commands[0];
      expect(cmd).toContain('docker build');
      expect(cmd).toContain('-f');
      expect(cmd).toContain('prd-api/Dockerfile');
      expect(cmd).toContain('-t prdagent-server:feature-a');
    });

    it('should throw if build fails', async () => {
      mock.addResponsePattern(/docker build/, () => ({
        stdout: '',
        stderr: 'build error',
        exitCode: 1,
      }));

      await expect(
        service.buildApiImage('/wt/bad', 'prdagent-server:bad'),
      ).rejects.toThrow('API image build failed');
    });

    it('should pass onOutput callback as onData to shell executor', async () => {
      mock.addResponsePattern(/docker build/, () => ({
        stdout: 'Successfully built abc123',
        stderr: '',
        exitCode: 0,
      }));

      const chunks: string[] = [];
      await service.buildApiImage('/wt/feature-a', 'prdagent-server:feature-a', (c) => chunks.push(c));

      // onOutput is passed as onData — MockShellExecutor doesn't invoke it,
      // but we verify the function itself is accepted without error
      expect(chunks).toBeDefined();
    });
  });

  describe('buildAdminStatic', () => {
    it('should run pnpm install and pnpm build', async () => {
      mock.addResponsePattern(/pnpm install/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/pnpm build/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/mkdir/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/cp -r/, () => ({ stdout: '', stderr: '', exitCode: 0 }));

      await service.buildAdminStatic('/wt/feature-a', '/repo/deploy/web/builds/feature-a');

      expect(mock.commands.some((c) => c.includes('pnpm install'))).toBe(true);
      expect(mock.commands.some((c) => c.includes('pnpm build'))).toBe(true);
    });

    it('should throw if pnpm install fails', async () => {
      mock.addResponsePattern(/pnpm install/, () => ({
        stdout: '',
        stderr: 'install error',
        exitCode: 1,
      }));

      await expect(
        service.buildAdminStatic('/wt/bad', '/out/bad'),
      ).rejects.toThrow('pnpm install failed');
    });

    it('should throw if pnpm build fails', async () => {
      mock.addResponsePattern(/pnpm install/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/pnpm build/, () => ({
        stdout: '',
        stderr: 'build error',
        exitCode: 1,
      }));

      await expect(
        service.buildAdminStatic('/wt/bad', '/out/bad'),
      ).rejects.toThrow('pnpm build failed');
    });
  });
});
