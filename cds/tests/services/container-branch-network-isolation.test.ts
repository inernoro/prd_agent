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
  // 隔离路径走 create → connect → start；非隔离/infra 仍走 docker run -d。两个动词都 mock。
  mock.addResponsePattern(/docker create/, () => ({ stdout: 'cid', stderr: '', exitCode: 0 }));
  mock.addResponsePattern(/docker start/, () => ({ stdout: 'cid', stderr: '', exitCode: 0 }));
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

    // 隔离路径用 docker create（进程尚未启动），不是 docker run -d
    const runCmd = mock.commands.find((c) => c.includes('docker create'))!;
    expect(runCmd).toBeDefined();
    expect(mock.commands.some((c) => c.includes('docker run -d'))).toBe(false);
    expect(runCmd).toContain('--network cds-br-feature-a');
    expect(runCmd).not.toContain('--network cds-proj-a');
    // cds.network 标签保持项目网（用于项目归属/孤儿清理），不跟随实际 run 主网（分支网）
    expect(runCmd).toContain('--label cds.network=cds-proj-a');
    expect(runCmd).not.toContain('--label cds.network=cds-br-');
    // app 别名仍在（但现在只挂在分支网上）
    expect(runCmd).toContain('--network-alias apigateway');
    // 连共享 infra 网，且不带别名（杜绝兄弟分支按 app 别名串流到本容器）
    const connect = mock.commands.find((c) => c.includes('docker network connect'))!;
    expect(connect).toBeDefined();
    expect(connect).toContain('cds-proj-a');
    expect(connect).toContain('cds-feature-a-apigateway');
    expect(connect).not.toContain('--alias');
    // 启动时序（Codex P1）：create → connect(infra) → start，infra 网必须在进程启动前就位
    const createIdx = mock.commands.findIndex((c) => c.includes('docker create'));
    const connectIdx = mock.commands.findIndex((c) => c.includes('docker network connect') && c.includes('cds-feature-a-apigateway'));
    const startIdx = mock.commands.findIndex((c) => c.includes('docker start cds-feature-a-apigateway'));
    expect(createIdx).toBeGreaterThanOrEqual(0);
    expect(connectIdx).toBeGreaterThan(createIdx);
    expect(startIdx).toBeGreaterThan(createIdx);
    expect(startIdx).toBeGreaterThan(connectIdx);
    // 陈旧别名清理扫的是别名实际所在的网（隔离=分支网），不是共享项目网（Bugbot Medium）
    expect(mock.commands.some((c) => c.includes('docker ps -aq') && c.includes('network=cds-br-feature-a'))).toBe(true);
    expect(mock.commands.some((c) => c.includes('docker ps -aq') && c.includes('network=cds-proj-a'))).toBe(false);
  });

  it('确保分支网存在（inspect 失败则 create cds-br-feature-a）', async () => {
    const service = new ContainerService(mock, makeConfig(), resolver);
    aliveStub = vi.spyOn(service as any, 'waitForContainerAlive').mockResolvedValue(undefined);
    mock.addResponsePattern(/docker network inspect cds-br-feature-a/, () => ({ stdout: '', stderr: 'No such network', exitCode: 1 }));
    mock.addResponsePattern(/docker network inspect/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker network create/, () => ({ stdout: 'ok', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker network connect/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker rm -f/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker create/, () => ({ stdout: 'cid', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker start/, () => ({ stdout: 'cid', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker run/, () => ({ stdout: 'cid', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/mkdir/, () => ({ stdout: '', stderr: '', exitCode: 0 }));

    await service.runService(makeEntry('proj-a'), makeProfile(), makeService());

    expect(mock.commands.some((c) => c.includes('docker network create cds-br-feature-a'))).toBe(true);
  });

  it('分支网地址池耗尽时清理空闲 cds-br 网络并重试创建', async () => {
    const service = new ContainerService(mock, makeConfig(), resolver);
    aliveStub = vi.spyOn(service as any, 'waitForContainerAlive').mockResolvedValue(undefined);
    let createAttempts = 0;

    mock.addResponsePattern(/docker network inspect cds-br-feature-a$/, () => ({ stdout: '', stderr: 'No such network', exitCode: 1 }));
    mock.addResponsePattern(/docker network create cds-br-feature-a$/, () => {
      createAttempts += 1;
      if (createAttempts === 1) {
        return {
          stdout: '',
          stderr: 'Error response from daemon: all predefined address pools have been fully subnetted',
          exitCode: 1,
        };
      }
      return { stdout: 'ok', stderr: '', exitCode: 0 };
    });
    mock.addResponsePattern(/docker network ls --format '\{\{\.Name\}\}'/, () => ({
      stdout: ['bridge', 'cds-br-old-empty', 'cds-proj-a', 'cds-br-old-busy'].join('\n'),
      stderr: '',
      exitCode: 0,
    }));
    mock.addResponsePattern(/docker network inspect --format='\{\{json \.Containers\}\}' 'cds-br-old-empty'/, () => ({ stdout: '{}\n', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker network inspect --format='\{\{json \.Containers\}\}' 'cds-br-old-busy'/, () => ({
      stdout: JSON.stringify({ runningcid: { Name: 'busy' } }),
      stderr: '',
      exitCode: 0,
    }));
    mock.addResponsePattern(/docker inspect --format='\{\{\.Id\}\} \{\{\.State\.Running\}\}' 'runningcid'/, () => ({ stdout: 'runningcid true\n', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker network rm 'cds-br-old-empty'/, () => ({ stdout: 'cds-br-old-empty\n', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker network inspect/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker network connect/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker rm -f/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker create/, () => ({ stdout: 'cid', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker start/, () => ({ stdout: 'cid', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker run/, () => ({ stdout: 'cid', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/mkdir/, () => ({ stdout: '', stderr: '', exitCode: 0 }));

    await service.runService(makeEntry('proj-a'), makeProfile(), makeService());

    expect(createAttempts).toBe(2);
    expect(mock.commands.some((c) => c.includes("docker network rm 'cds-br-old-empty'"))).toBe(true);
    expect(mock.commands.some((c) => c.includes("docker network rm 'cds-br-old-busy'"))).toBe(false);
    expect(mock.commands.some((c) => c.includes('docker network rm cds-proj-a'))).toBe(false);
  });

  it('地址池清理后重试遇到并发 already exists 也视为成功', async () => {
    const service = new ContainerService(mock, makeConfig(), resolver);
    aliveStub = vi.spyOn(service as any, 'waitForContainerAlive').mockResolvedValue(undefined);
    let createAttempts = 0;

    mock.addResponsePattern(/docker network inspect cds-br-feature-a$/, () => ({ stdout: '', stderr: 'No such network', exitCode: 1 }));
    mock.addResponsePattern(/docker network create cds-br-feature-a$/, () => {
      createAttempts += 1;
      if (createAttempts === 1) {
        return {
          stdout: '',
          stderr: 'Error response from daemon: all predefined address pools have been fully subnetted',
          exitCode: 1,
        };
      }
      return {
        stdout: '',
        stderr: 'Error response from daemon: network with name cds-br-feature-a already exists',
        exitCode: 1,
      };
    });
    mock.addResponsePattern(/docker network ls --format '\{\{\.Name\}\}'/, () => ({ stdout: 'cds-br-old-empty\n', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker network inspect --format='\{\{json \.Containers\}\}' 'cds-br-old-empty'/, () => ({ stdout: '{}\n', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker network rm 'cds-br-old-empty'/, () => ({ stdout: 'cds-br-old-empty\n', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker network inspect/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker network connect/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker rm -f/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker create/, () => ({ stdout: 'cid', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker start/, () => ({ stdout: 'cid', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker run/, () => ({ stdout: 'cid', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/mkdir/, () => ({ stdout: '', stderr: '', exitCode: 0 }));

    await expect(service.runService(makeEntry('proj-a'), makeProfile(), makeService())).resolves.toBeUndefined();
    expect(createAttempts).toBe(2);
  });

  it('分支网地址池耗尽时会释放只挂停止容器的 cds-br 网络', async () => {
    const service = new ContainerService(mock, makeConfig(), resolver);
    aliveStub = vi.spyOn(service as any, 'waitForContainerAlive').mockResolvedValue(undefined);
    let createAttempts = 0;

    mock.addResponsePattern(/docker network inspect cds-br-feature-a$/, () => ({ stdout: '', stderr: 'No such network', exitCode: 1 }));
    mock.addResponsePattern(/docker network create cds-br-feature-a$/, () => {
      createAttempts += 1;
      if (createAttempts === 1) {
        return {
          stdout: '',
          stderr: 'Error response from daemon: all predefined address pools have been fully subnetted',
          exitCode: 1,
        };
      }
      return { stdout: 'ok', stderr: '', exitCode: 0 };
    });
    mock.addResponsePattern(/docker network ls --format '\{\{\.Name\}\}'/, () => ({
      stdout: ['cds-br-stopped-only', 'cds-br-running'].join('\n'),
      stderr: '',
      exitCode: 0,
    }));
    mock.addResponsePattern(/docker network inspect --format='\{\{json \.Containers\}\}' 'cds-br-stopped-only'/, () => ({
      stdout: JSON.stringify({ stoppedcid: { Name: 'stopped' } }),
      stderr: '',
      exitCode: 0,
    }));
    mock.addResponsePattern(/docker network inspect --format='\{\{json \.Containers\}\}' 'cds-br-running'/, () => ({
      stdout: JSON.stringify({ runningcid: { Name: 'running' } }),
      stderr: '',
      exitCode: 0,
    }));
    mock.addResponsePattern(/docker inspect --format='\{\{\.Id\}\} \{\{\.State\.Running\}\}' 'stoppedcid'/, () => ({ stdout: 'stoppedcid false\n', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker inspect --format='\{\{\.Id\}\} \{\{\.State\.Running\}\}' 'runningcid'/, () => ({ stdout: 'runningcid true\n', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker network disconnect -f 'cds-br-stopped-only' 'stoppedcid'/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker network rm 'cds-br-stopped-only'/, () => ({ stdout: 'cds-br-stopped-only\n', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker network inspect/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker network connect/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker rm -f/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker create/, () => ({ stdout: 'cid', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker start/, () => ({ stdout: 'cid', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker run/, () => ({ stdout: 'cid', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/mkdir/, () => ({ stdout: '', stderr: '', exitCode: 0 }));

    await service.runService(makeEntry('proj-a'), makeProfile(), makeService());

    expect(createAttempts).toBe(2);
    expect(mock.commands.some((c) => c.includes("docker network disconnect -f 'cds-br-stopped-only' 'stoppedcid'"))).toBe(true);
    expect(mock.commands.some((c) => c.includes("docker network rm 'cds-br-stopped-only'"))).toBe(true);
    expect(mock.commands.some((c) => c.includes("docker network rm 'cds-br-running'"))).toBe(false);
  });

  it('容忍并发竞态：分支网 create 报 "already exists" 不抛（同分支多服务同时首建）', async () => {
    const service = new ContainerService(mock, makeConfig(), resolver);
    aliveStub = vi.spyOn(service as any, 'waitForContainerAlive').mockResolvedValue(undefined);
    // 分支网 inspect 失败（不存在）→ create 报 already exists（另一个并发服务抢先建好了）
    mock.addResponsePattern(/docker network inspect cds-br-feature-a/, () => ({ stdout: '', stderr: 'No such network', exitCode: 1 }));
    mock.addResponsePattern(/docker network create cds-br-feature-a/, () => ({ stdout: '', stderr: 'Error response from daemon: network with name cds-br-feature-a already exists', exitCode: 1 }));
    mock.addResponsePattern(/docker network inspect/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker network connect/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker rm -f/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker create/, () => ({ stdout: 'cid', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker start/, () => ({ stdout: 'cid', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker run/, () => ({ stdout: 'cid', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/mkdir/, () => ({ stdout: '', stderr: '', exitCode: 0 }));

    // 不抛 = 通过
    await expect(service.runService(makeEntry('proj-a'), makeProfile(), makeService())).resolves.toBeUndefined();
    const runCmd = mock.commands.find((c) => c.includes('docker create'))!;
    expect(runCmd).toContain('--network cds-br-feature-a');
  });

  it('infra 连接失败（no such container）让部署显式失败，绝不 docker start（Bugbot Medium）', async () => {
    const service = new ContainerService(mock, makeConfig(), resolver);
    aliveStub = vi.spyOn(service as any, 'waitForContainerAlive').mockResolvedValue(undefined);
    // 先注册失败的 connect（first-match-wins），再用 okStubs 兜底其它命令。
    mock.addResponsePattern(/docker network connect/, () => ({ stdout: '', stderr: 'Error: No such container: cds-feature-a-apigateway', exitCode: 1 }));
    okStubs(mock);

    // 连不上共享 infra 网 = 硬失败（不再吞 "no such container"），否则会起一个连不到 DB 的容器。
    await expect(service.runService(makeEntry('proj-a'), makeProfile(), makeService())).rejects.toThrow(/共享 infra 网/);
    // create 已发但 connect 失败 → 绝不能 start 一个只挂分支网、连不到共享 infra 的容器。
    expect(mock.commands.some((c) => c.includes('docker create'))).toBe(true);
    expect(mock.commands.some((c) => c.includes('docker start cds-feature-a-apigateway'))).toBe(false);
  });

  it('一次性 job（runProfileCommand）隔离时也跑分支网 + 连共享 infra 网（Bugbot「Job containers miss branch app DNS」）', async () => {
    const service = new ContainerService(mock, makeConfig(), resolver);
    mock.addResponsePattern(/docker network inspect/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker network create/, () => ({ stdout: 'ok', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker network connect/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker rm -f/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker create/, () => ({ stdout: 'cid', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker start/, () => ({ stdout: 'cid', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker wait/, () => ({ stdout: '0\n', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker logs/, () => ({ stdout: 'migration ok', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/mkdir/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/.*/, () => ({ stdout: '', stderr: '', exitCode: 0 }));

    const result = await service.runProfileCommand(makeEntry('proj-a'), makeProfile(), 'dotnet ef database update');

    expect(result.exitCode).toBe(0);
    // 隔离 job 用 create→connect→start→wait→logs→rm，不是一次性 docker run --rm。
    const createCmd = mock.commands.find((c) => c.includes('docker create') && c.includes('cds-job-feature-a-apigateway'))!;
    expect(createCmd).toBeDefined();
    expect(createCmd).toContain('--network cds-br-feature-a'); // 主网=分支网 → 能解析兄弟 app 别名
    expect(mock.commands.some((c) => c.includes('docker run --rm'))).toBe(false);
    // 连共享 infra 网（mysql/redis 可达）。
    expect(mock.commands.some((c) => c.includes('docker network connect') && c.includes('cds-proj-a') && c.includes('cds-job-feature-a-apigateway'))).toBe(true);
    // 时序：create → connect → start → wait → rm。
    const ci = mock.commands.findIndex((c) => c.includes('docker create') && c.includes('cds-job-feature-a-apigateway'));
    const coni = mock.commands.findIndex((c) => c.includes('docker network connect') && c.includes('cds-job-feature-a-apigateway'));
    const si = mock.commands.findIndex((c) => c.includes('docker start') && c.includes('cds-job-feature-a-apigateway'));
    const wi = mock.commands.findIndex((c) => c.includes('docker wait') && c.includes('cds-job-feature-a-apigateway'));
    expect(coni).toBeGreaterThan(ci);
    expect(si).toBeGreaterThan(coni);
    expect(wi).toBeGreaterThan(si);
    // 收尾删除临时 job 容器。
    expect(mock.commands.some((c) => c.includes('docker rm -f') && c.includes('cds-job-feature-a-apigateway'))).toBe(true);
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
