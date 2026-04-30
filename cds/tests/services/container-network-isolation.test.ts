import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { ContainerService, type ProjectNetworkResolver } from '../../src/services/container.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import type { CdsConfig, BranchEntry, BuildProfile, ServiceState, InfraService } from '../../src/types.js';

/**
 * Week 4.9 多项目网络隔离测试。
 *
 * 验证目标：
 *   1. 项目 A 的容器 → docker run 用 `cds-proj-A` 网络
 *   2. 项目 B 的容器 → docker run 用 `cds-proj-B` 网络
 *   3. 老项目（dockerNetwork 字段缺失）→ 用 config 兜底
 *   4. 没注入 networkResolver → 全部走 config 兜底（向后兼容）
 *   5. infra 容器走相同的逻辑（按 service.projectId）
 *   6. discover* 不再 filter cds.network=（跨 network 发现）
 */

const makeConfig = (): CdsConfig => ({
  repoRoot: '/repo',
  worktreeBase: '/wt',
  masterPort: 9900,
  workerPort: 5500,
  dockerNetwork: 'cds-network',
  portStart: 10001,
  sharedEnv: {},
  jwt: { secret: 'test-secret', issuer: 'prdagent' },
});

const makeProfile = (): BuildProfile => ({
  id: 'api',
  name: 'API',
  dockerImage: 'mcr.microsoft.com/dotnet/sdk:8.0',
  workDir: 'prd-api',
  command: 'dotnet run',
  containerPort: 8080,
});

const makeService = (overrides?: Partial<ServiceState>): ServiceState => ({
  profileId: 'api',
  containerName: 'cds-feature-a-api',
  hostPort: 10001,
  status: 'building',
  ...overrides,
});

const makeEntry = (projectId: string, overrides?: Partial<BranchEntry>): BranchEntry => ({
  id: 'feature-a',
  projectId,
  branch: 'feature/a',
  worktreePath: '/wt/feature-a',
  services: {},
  status: 'idle',
  createdAt: '2026-04-30T00:00:00Z',
  ...overrides,
});

const makeInfraService = (projectId: string, overrides?: Partial<InfraService>): InfraService => ({
  id: 'mongo',
  projectId,
  name: 'MongoDB',
  dockerImage: 'mongo:7',
  containerPort: 27017,
  hostPort: 37017,
  containerName: 'cds-mongo',
  status: 'stopped',
  volumes: [],
  env: {},
  createdAt: '2026-04-30T00:00:00Z',
  ...overrides,
});

const okDockerStubs = (mock: MockShellExecutor) => {
  mock.addResponsePattern(/docker network inspect/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
  mock.addResponsePattern(/docker rm -f/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
  mock.addResponsePattern(/docker run/, () => ({ stdout: 'cid', stderr: '', exitCode: 0 }));
  mock.addResponsePattern(/mkdir/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
};

describe('ContainerService 多项目网络隔离', () => {
  let mock: MockShellExecutor;
  let aliveStub: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mock = new MockShellExecutor();
  });
  afterEach(() => { aliveStub?.mockRestore(); });

  describe('runService 用 project.dockerNetwork', () => {
    it('项目 A 的分支用 cds-proj-A 网络', async () => {
      const resolver: ProjectNetworkResolver = {
        getDockerNetwork: (id) => (id === 'proj-a' ? 'cds-proj-a' : undefined),
      };
      const service = new ContainerService(mock, makeConfig(), resolver);
      aliveStub = vi.spyOn(service as any, 'waitForContainerAlive').mockResolvedValue(undefined);
      okDockerStubs(mock);

      await service.runService(makeEntry('proj-a'), makeProfile(), makeService());

      const runCmd = mock.commands.find((c) => c.includes('docker run -d'))!;
      expect(runCmd).toContain('--network cds-proj-a');
      expect(runCmd).not.toContain('--network cds-network');
      // label 也要跟随项目 network
      expect(runCmd).toContain('--label cds.network=cds-proj-a');
    });

    it('项目 B 的分支用 cds-proj-B 网络', async () => {
      const resolver: ProjectNetworkResolver = {
        getDockerNetwork: (id) => (id === 'proj-b' ? 'cds-proj-b' : undefined),
      };
      const service = new ContainerService(mock, makeConfig(), resolver);
      aliveStub = vi.spyOn(service as any, 'waitForContainerAlive').mockResolvedValue(undefined);
      okDockerStubs(mock);

      await service.runService(makeEntry('proj-b'), makeProfile(), makeService());

      const runCmd = mock.commands.find((c) => c.includes('docker run -d'))!;
      expect(runCmd).toContain('--network cds-proj-b');
      expect(runCmd).toContain('--label cds.network=cds-proj-b');
    });

    it('老项目（dockerNetwork 字段缺失）回退到 config.dockerNetwork', async () => {
      const resolver: ProjectNetworkResolver = {
        // legacy 项目返回 undefined → fallback
        getDockerNetwork: () => undefined,
      };
      const service = new ContainerService(mock, makeConfig(), resolver);
      aliveStub = vi.spyOn(service as any, 'waitForContainerAlive').mockResolvedValue(undefined);
      okDockerStubs(mock);

      await service.runService(makeEntry('legacy-default'), makeProfile(), makeService());

      const runCmd = mock.commands.find((c) => c.includes('docker run -d'))!;
      expect(runCmd).toContain('--network cds-network');
    });

    it('无 networkResolver（向后兼容）全部走 config.dockerNetwork', async () => {
      const service = new ContainerService(mock, makeConfig());
      aliveStub = vi.spyOn(service as any, 'waitForContainerAlive').mockResolvedValue(undefined);
      okDockerStubs(mock);

      await service.runService(makeEntry('any-id'), makeProfile(), makeService());

      const runCmd = mock.commands.find((c) => c.includes('docker run -d'))!;
      expect(runCmd).toContain('--network cds-network');
    });

    it('ensureNetwork 用项目级网络 — 项目 A 的 deploy 触发 inspect/create cds-proj-a', async () => {
      const resolver: ProjectNetworkResolver = {
        getDockerNetwork: (id) => (id === 'proj-a' ? 'cds-proj-a' : undefined),
      };
      const service = new ContainerService(mock, makeConfig(), resolver);
      aliveStub = vi.spyOn(service as any, 'waitForContainerAlive').mockResolvedValue(undefined);
      // 初次 inspect 失败 → 触发 create
      let inspectCalls = 0;
      mock.addResponsePattern(/docker network inspect cds-proj-a/, () => {
        inspectCalls++;
        return { stdout: '', stderr: 'No such network', exitCode: 1 };
      });
      mock.addResponsePattern(/docker network create cds-proj-a/, () => ({ stdout: 'ok', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/docker rm -f/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/docker run/, () => ({ stdout: 'cid', stderr: '', exitCode: 0 }));

      await service.runService(makeEntry('proj-a'), makeProfile(), makeService());

      expect(inspectCalls).toBe(1);
      expect(mock.commands.some((c) => c.includes('docker network create cds-proj-a'))).toBe(true);
    });
  });

  describe('startInfraService 用 project.dockerNetwork', () => {
    it('infra 容器跟随 service.projectId 选 network', async () => {
      const resolver: ProjectNetworkResolver = {
        getDockerNetwork: (id) => (id === 'proj-a' ? 'cds-proj-a' : undefined),
      };
      const service = new ContainerService(mock, makeConfig(), resolver);
      okDockerStubs(mock);

      await service.startInfraService(makeInfraService('proj-a'));

      const runCmd = mock.commands.find((c) => c.includes('docker run -d'))!;
      expect(runCmd).toContain('--network cds-proj-a');
      expect(runCmd).toContain('--label cds.network=cds-proj-a');
    });

    it('老 infra（projectId 指向无 dockerNetwork 项目）走 config 兜底', async () => {
      const resolver: ProjectNetworkResolver = {
        getDockerNetwork: () => undefined,
      };
      const service = new ContainerService(mock, makeConfig(), resolver);
      okDockerStubs(mock);

      await service.startInfraService(makeInfraService('legacy-default'));

      const runCmd = mock.commands.find((c) => c.includes('docker run -d'))!;
      expect(runCmd).toContain('--network cds-network');
    });
  });

  describe('discover* 跨 network 工作', () => {
    it('discoverInfraContainers 不再 filter cds.network=', async () => {
      const service = new ContainerService(mock, makeConfig());
      mock.addResponsePattern(/docker ps/, () => ({
        stdout: 'cds-mongo|running|cds.managed=true,cds.type=infra,cds.service.id=mongo,cds.network=cds-proj-a',
        stderr: '',
        exitCode: 0,
      }));

      await service.discoverInfraContainers();

      const psCmd = mock.commands.find((c) => c.includes('docker ps'))!;
      expect(psCmd).toContain('label=cds.managed=true');
      expect(psCmd).toContain('label=cds.type=infra');
      // 关键：不带 cds.network filter,以发现跨项目容器
      expect(psCmd).not.toContain('label=cds.network=');
    });

    it('discoverAppContainers 同样不再 filter cds.network=', async () => {
      const service = new ContainerService(mock, makeConfig());
      mock.addResponsePattern(/docker ps/, () => ({
        stdout: 'cds-feat-a-api|running|cds.managed=true,cds.type=app,cds.branch.id=feat-a,cds.profile.id=api,cds.network=cds-proj-b',
        stderr: '',
        exitCode: 0,
      }));

      const found = await service.discoverAppContainers();

      const psCmd = mock.commands.find((c) => c.includes('docker ps'))!;
      expect(psCmd).not.toContain('label=cds.network=');
      // 仍然能正确解析返回 map
      expect(found.has('feat-a/api')).toBe(true);
    });
  });
});
