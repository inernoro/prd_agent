import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import { ContainerService, applyProfileOverride, resolveEffectiveProfile } from '../../src/services/container.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import type { CdsConfig, BranchEntry, BuildProfile, BuildProfileOverride, ServiceState } from '../../src/types.js';

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
    // waitForContainerAlive polls with real setTimeout delays (5×3s).
    // Stub it out for tests that don't specifically test health-check behavior.
    let aliveStub: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      aliveStub = vi.spyOn(service as any, 'waitForContainerAlive').mockResolvedValue(undefined);
    });
    afterEach(() => { aliveStub?.mockRestore(); });

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

    // ── Phase 2 cgroup resource limits ──

    // 2026-05-06 用户授权"每个容器都不限制内存,尽情释放" — 不再下发
    // --memory / --memory-swap docker 运行时硬限。memoryMB 字段保留作
    // capacity 调度规划提示(capacityMessage 用),但不进 docker run。
    it('should NOT apply --memory / --memory-swap even when memoryMB is set (no-mem-limit policy)', async () => {
      mock.addResponsePattern(/docker network inspect/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/docker rm -f/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/docker run/, () => ({ stdout: 'ok', stderr: '', exitCode: 0 }));

      const profile = makeProfile({
        resources: { memoryMB: 512 },
      });

      await service.runService(makeEntry(), profile, makeService());

      const runCmd = mock.commands.find(c => c.includes('docker run -d'))!;
      expect(runCmd).not.toContain('--memory');
      expect(runCmd).not.toContain('--memory-swap');
    });

    it('should apply --cpus when cpus is set', async () => {
      mock.addResponsePattern(/docker network inspect/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/docker rm -f/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/docker run/, () => ({ stdout: 'ok', stderr: '', exitCode: 0 }));

      const profile = makeProfile({
        resources: { cpus: 1.5 },
      });

      await service.runService(makeEntry(), profile, makeService());

      const runCmd = mock.commands.find(c => c.includes('docker run -d'))!;
      expect(runCmd).toContain('--cpus 1.5');
    });

    it('should keep --cpus but drop --memory when both are set (no-mem-limit policy)', async () => {
      mock.addResponsePattern(/docker network inspect/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/docker rm -f/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/docker run/, () => ({ stdout: 'ok', stderr: '', exitCode: 0 }));

      const profile = makeProfile({
        resources: { memoryMB: 1024, cpus: 2 },
      });

      await service.runService(makeEntry(), profile, makeService());

      const runCmd = mock.commands.find(c => c.includes('docker run -d'))!;
      expect(runCmd).not.toContain('--memory');
      expect(runCmd).toContain('--cpus 2');
    });

    it('should emit NO resource flags when resources is unset (backward compat)', async () => {
      mock.addResponsePattern(/docker network inspect/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/docker rm -f/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/docker run/, () => ({ stdout: 'ok', stderr: '', exitCode: 0 }));

      await service.runService(makeEntry(), makeProfile(), makeService());

      const runCmd = mock.commands.find(c => c.includes('docker run -d'))!;
      expect(runCmd).not.toContain('--memory');
      expect(runCmd).not.toContain('--cpus');
    });

    it('should ignore zero/negative resource values', async () => {
      mock.addResponsePattern(/docker network inspect/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/docker rm -f/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/docker run/, () => ({ stdout: 'ok', stderr: '', exitCode: 0 }));

      const profile = makeProfile({
        resources: { memoryMB: 0, cpus: -1 },
      });

      await service.runService(makeEntry(), profile, makeService());

      const runCmd = mock.commands.find(c => c.includes('docker run -d'))!;
      expect(runCmd).not.toContain('--memory');
      expect(runCmd).not.toContain('--cpus');
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

describe('Branch profile overrides — inheritance merge', () => {
  const baseline: BuildProfile = {
    id: 'api',
    name: 'API',
    dockerImage: 'mcr.microsoft.com/dotnet/sdk:8.0',
    workDir: 'prd-api',
    command: 'dotnet run',
    containerPort: 8080,
    env: { BASE_A: '1', BASE_B: '2' },
    resources: { memoryMB: 1024 },
    deployModes: {
      dev: { label: '开发', command: 'dotnet watch run' },
      static: { label: '静态', command: 'nginx' },
    },
  };

  const branchWithOverride = (override: BuildProfileOverride): BranchEntry => ({
    id: 'feature-x',
    branch: 'feature/x',
    worktreePath: '/wt/feature-x',
    services: {},
    status: 'idle',
    createdAt: '2026-02-12T00:00:00Z',
    profileOverrides: { api: override },
  });

  it('applyProfileOverride returns baseline unchanged when override is undefined', () => {
    const merged = applyProfileOverride(baseline, undefined);
    expect(merged).toEqual(baseline);
    // Fast path: no override → same reference (no allocation)
    expect(merged).toBe(baseline);
  });

  it('applyProfileOverride does NOT mutate the baseline', () => {
    const snapshot = JSON.parse(JSON.stringify(baseline));
    applyProfileOverride(baseline, {
      dockerImage: 'node:20',
      env: { BASE_A: '99', NEW_KEY: 'x' },
    });
    expect(baseline).toEqual(snapshot);
  });

  it('override replaces scalar fields when set', () => {
    const merged = applyProfileOverride(baseline, {
      dockerImage: 'node:20-alpine',
      command: 'pnpm dev',
      containerPort: 3000,
    });
    expect(merged.dockerImage).toBe('node:20-alpine');
    expect(merged.command).toBe('pnpm dev');
    expect(merged.containerPort).toBe(3000);
    // Unset fields inherit
    expect(merged.workDir).toBe('prd-api');
  });

  it('env merges key-wise with override winning per key', () => {
    const merged = applyProfileOverride(baseline, {
      env: { BASE_A: 'overridden', NEW_KEY: 'fresh' },
    });
    expect(merged.env).toEqual({
      BASE_A: 'overridden', // override wins
      BASE_B: '2',          // inherited
      NEW_KEY: 'fresh',     // added
    });
  });

  it('empty env in override leaves baseline env intact', () => {
    const merged = applyProfileOverride(baseline, { dockerImage: 'node:20' });
    expect(merged.env).toEqual(baseline.env);
  });

  it('resources replaces whole object when set', () => {
    const merged = applyProfileOverride(baseline, {
      resources: { memoryMB: 2048, cpus: 2 },
    });
    expect(merged.resources).toEqual({ memoryMB: 2048, cpus: 2 });
  });

  it('resolveEffectiveProfile: baseline → override → deployMode order', () => {
    // Branch overrides command AND activates a deploy mode that also changes command.
    // Deploy mode runs LAST so its command wins.
    const branch = branchWithOverride({
      command: 'branch-cmd',
      activeDeployMode: 'dev', // dev.command = 'dotnet watch run'
    });
    const effective = resolveEffectiveProfile(baseline, branch);
    expect(effective.command).toBe('dotnet watch run'); // deploy mode wins
    expect(effective.activeDeployMode).toBe('dev');
  });

  it('resolveEffectiveProfile: branch override takes effect when no deploy mode is active', () => {
    const branch = branchWithOverride({
      dockerImage: 'custom:latest',
      env: { BASE_A: 'customized' },
    });
    const effective = resolveEffectiveProfile(baseline, branch);
    expect(effective.dockerImage).toBe('custom:latest');
    expect(effective.env).toEqual({ BASE_A: 'customized', BASE_B: '2' });
  });

  it('resolveEffectiveProfile: undefined branch returns plain profile', () => {
    const effective = resolveEffectiveProfile(baseline, undefined);
    expect(effective).toEqual(baseline);
  });

  it('resolveEffectiveProfile: empty profileOverrides map = pure inheritance', () => {
    const branch: BranchEntry = {
      id: 'feature-y',
      branch: 'feature/y',
      worktreePath: '/wt/feature-y',
      services: {},
      status: 'idle',
      createdAt: '2026-02-12T00:00:00Z',
      profileOverrides: {},
    };
    const effective = resolveEffectiveProfile(baseline, branch);
    expect(effective).toEqual(baseline);
  });

  it('resolveEffectiveProfile: override can switch active deploy mode', () => {
    // Baseline has no active mode; branch activates 'static'.
    const branch = branchWithOverride({ activeDeployMode: 'static' });
    const effective = resolveEffectiveProfile(baseline, branch);
    expect(effective.command).toBe('nginx');
  });
});
