import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ContainerService, type ProjectNetworkResolver } from '../../src/services/container.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import type { CdsConfig, BranchEntry, BuildProfile, ServiceState, InfraService } from '../../src/types.js';

/**
 * 分支级网络隔离（默认开）的容器层接线测试。
 *
 * 验证：
 *   1. app 容器主网 = 分支网 cds-br-<branchId>（app 别名仅本分支可见）
 *   2. 运行后 `docker network connect <共享 infra 网> <容器名>`（无别名，仅为可达共享 mysql/redis）
 *   3. cds.network 标签跟随分支网
 *   4. infra 容器仍在项目共享网（不受分支隔离影响）
 *   5. 全局逃生开关 CDS_BRANCH_NETWORK_ISOLATION=0 → 退回共享网行为（app 主网 = 项目网，无 connect）
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
  id: 'apigateway',
  name: 'API Gateway',
  dockerImage: 'mcr.microsoft.com/dotnet/sdk:8.0',
  workDir: 'gateway',
  command: 'dotnet run',
  containerPort: 8080,
});

const makeService = (overrides?: Partial<ServiceState>): ServiceState => ({
  profileId: 'apigateway',
  containerName: 'cds-feature-a-apigateway',
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
  createdAt: '2026-06-29T00:00:00Z',
  ...overrides,
});

const makeInfra = (projectId: string, overrides?: Partial<InfraService>): InfraService => ({
  id: 'mysql',
  projectId,
  name: 'MySQL',
  dockerImage: 'mysql:8',
  containerPort: 3306,
  hostPort: 33306,
  containerName: 'cds-mysql',
  status: 'stopped',
  volumes: [],
  env: {},
  createdAt: '2026-06-29T00:00:00Z',
});

const okStubs = (mock: MockShellExecutor) => {
  mock.addResponsePattern(/docker network inspect/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
  mock.addResponsePattern(/docker network create/, () => ({ stdout: 'ok', stderr: '', exitCode: 0 }));
  mock.addResponsePattern(/docker network connect/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
  mock.addResponsePattern(/docker rm -f/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
  mock.addResponsePattern(/docker run/, () => ({ stdout: 'cid', stderr: '', exitCode: 0 }));
  mock.addResponsePattern(/mkdir/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
};

const resolver: ProjectNetworkResolver = {
  getDockerNetwork: (id) => (id === 'proj-a' ? 'cds-proj-a' : undefined),
};

describe('ContainerService 分支级网络隔离', () => {
  let mock: MockShellExecutor;
  let aliveStub: ReturnType<typeof vi.spyOn>;
  let prevIsolation: string | undefined;

  beforeEach(() => {
    mock = new MockShellExecutor();
    prevIsolation = process.env.CDS_BRANCH_NETWORK_ISOLATION;
    delete process.env.CDS_BRANCH_NETWORK_ISOLATION; // 默认开
  });
  afterEach(() => {
    aliveStub?.mockRestore();
    if (prevIsolation === undefined) delete process.env.CDS_BRANCH_NETWORK_ISOLATION;
    else process.env.CDS_BRANCH_NETWORK_ISOLATION = prevIsolation;
  });

  it('app 容器主网 = 分支网，并连到共享 infra 网（无别名）', async () => {
    const service = new ContainerService(mock, makeConfig(), resolver);
    aliveStub = vi.spyOn(service as any, 'waitForContainerAlive').mockResolvedValue(undefined);
    okStubs(mock);

    await service.runService(makeEntry('proj-a'), makeProfile(), makeService());

    const runCmd = mock.commands.find((c) => c.includes('docker run -d'))!;
    expect(runCmd).toContain('--network cds-br-feature-a');
    expect(runCmd).not.toContain('--network cds-proj-a');
    expect(runCmd).toContain('--label cds.network=cds-br-feature-a');
    // app 别名仍在（但现在只挂在分支网上）
    expect(runCmd).toContain('--network-alias apigateway');
    // 运行后连共享 infra 网，且不带别名（杜绝兄弟分支按 app 别名串流到本容器）
    const connect = mock.commands.find((c) => c.includes('docker network connect'))!;
    expect(connect).toBeDefined();
    expect(connect).toContain('cds-proj-a');
    expect(connect).toContain('cds-feature-a-apigateway');
    expect(connect).not.toContain('--alias');
  });

  it('确保分支网存在（inspect 失败则 create cds-br-feature-a）', async () => {
    const service = new ContainerService(mock, makeConfig(), resolver);
    aliveStub = vi.spyOn(service as any, 'waitForContainerAlive').mockResolvedValue(undefined);
    mock.addResponsePattern(/docker network inspect cds-br-feature-a/, () => ({ stdout: '', stderr: 'No such network', exitCode: 1 }));
    mock.addResponsePattern(/docker network inspect/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker network create/, () => ({ stdout: 'ok', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker network connect/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker rm -f/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker run/, () => ({ stdout: 'cid', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/mkdir/, () => ({ stdout: '', stderr: '', exitCode: 0 }));

    await service.runService(makeEntry('proj-a'), makeProfile(), makeService());

    expect(mock.commands.some((c) => c.includes('docker network create cds-br-feature-a'))).toBe(true);
  });

  it('infra 容器不受分支隔离影响，仍在项目共享网', async () => {
    const service = new ContainerService(mock, makeConfig(), resolver);
    okStubs(mock);

    await service.startInfraService(makeInfra('proj-a'));

    const runCmd = mock.commands.find((c) => c.includes('docker run -d'))!;
    expect(runCmd).toContain('--network cds-proj-a');
    expect(runCmd).not.toContain('--network cds-br-');
  });

  it('逃生开关关闭隔离：app 主网退回项目共享网，无 network connect', async () => {
    process.env.CDS_BRANCH_NETWORK_ISOLATION = '0';
    const service = new ContainerService(mock, makeConfig(), resolver);
    aliveStub = vi.spyOn(service as any, 'waitForContainerAlive').mockResolvedValue(undefined);
    okStubs(mock);

    await service.runService(makeEntry('proj-a'), makeProfile(), makeService());

    const runCmd = mock.commands.find((c) => c.includes('docker run -d'))!;
    expect(runCmd).toContain('--network cds-proj-a');
    expect(runCmd).not.toContain('cds-br-');
    expect(mock.commands.some((c) => c.includes('docker network connect'))).toBe(false);
  });
});
