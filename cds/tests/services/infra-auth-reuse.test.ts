import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { ContainerService } from '../../src/services/container.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import type { CdsConfig, InfraService } from '../../src/types.js';

/**
 * 认证门禁的**位置**回归。
 *
 * 2026-08-18 事故：门禁被放在 startInfraService 的最前面，于是它不只拦住「创建新的
 * 无认证数据库」，连「复用一个已经在跑的存量共享容器」也一并拒掉。后果是所有分支预览
 * 连同 main 的部署全部失败——而拒绝复用并不会让那个存量容器变得更安全，只是把整条
 * 交付链堵死。策略自己的注释写的也是「只阻止继续创建新的无认证实例」。
 *
 * 门禁本体有 8 条纯函数用例，但没有一条覆盖**它挂在哪个分支上**，所以这个位置错误
 * 一路绿灯上了线。本文件补的就是这一层：判据对不对是一回事，挂对地方是另一回事。
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

/** 存量共享 mongo：env 里没有任何凭据（#1381 之前建的那一批就是这个形状）。 */
const unauthenticatedMongo = (overrides?: Partial<InfraService>): InfraService => ({
  id: 'mongo',
  projectId: 'proj-a',
  name: 'MongoDB',
  dockerImage: 'mongo:8',
  containerPort: 27017,
  hostPort: 37017,
  containerName: 'cds-mongo',
  status: 'stopped',
  volumes: [],
  env: {},
  createdAt: '2026-04-30T00:00:00Z',
  ...overrides,
});

describe('基础设施认证门禁挂在创建路径上，而不是复用路径上', () => {
  let mock: MockShellExecutor;
  let aliveStub: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mock = new MockShellExecutor();
    mock.addResponsePattern(/docker network inspect/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker network connect/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker inspect --format='\{\{\.State\.Status\}\}'/, () => ({ stdout: 'running\n', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker inspect/, () => ({ stdout: '[]', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker logs/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker start/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker rm -f/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker run/, () => ({ stdout: 'cid', stderr: '', exitCode: 0 }));
    aliveStub = vi.spyOn(ContainerService.prototype as never, 'waitForContainerAlive' as never)
      .mockResolvedValue(true as never);
  });

  afterEach(() => {
    aliveStub.mockRestore();
    vi.restoreAllMocks();
  });

  it('已经在跑的存量容器：复用放行，不拒绝部署', async () => {
    const service = new ContainerService(mock, makeConfig());
    await expect(service.startInfraService(unauthenticatedMongo())).resolves.toBeUndefined();
    // 复用就是复用：不许顺手把人家的数据容器删了重建。
    expect(mock.commands.some((c) => /docker rm -f/.test(c))).toBe(false);
    expect(mock.commands.some((c) => /docker run/.test(c))).toBe(false);
  });

  it('停着的存量容器：唤醒放行', async () => {
    mock.addResponsePatternFirst(/docker inspect --format='\{\{\.State\.Status\}\}'/, () => ({ stdout: 'exited\n', stderr: '', exitCode: 0 }));
    const service = new ContainerService(mock, makeConfig());
    await expect(service.startInfraService(unauthenticatedMongo())).resolves.toBeUndefined();
    expect(mock.commands.some((c) => /docker start/.test(c))).toBe(true);
  });

  it('容器不存在：首次创建仍被硬拦', async () => {
    mock.addResponsePatternFirst(/docker inspect --format='\{\{\.State\.Status\}\}'/, () => ({ stdout: '', stderr: 'No such object', exitCode: 1 }));
    const service = new ContainerService(mock, makeConfig());
    await expect(service.startInfraService(unauthenticatedMongo())).rejects.toThrow(/拒绝创建无认证的 mongo/);
    expect(mock.commands.some((c) => /docker run/.test(c))).toBe(false);
  });

  it('唤醒失败要删除重建：同样被硬拦，不给绕过策略的后门', async () => {
    mock.addResponsePatternFirst(/docker inspect --format='\{\{\.State\.Status\}\}'/, () => ({ stdout: 'exited\n', stderr: '', exitCode: 0 }));
    mock.addResponsePatternFirst(/docker start/, () => ({ stdout: '', stderr: 'boom', exitCode: 1 }));
    const service = new ContainerService(mock, makeConfig());
    await expect(service.startInfraService(unauthenticatedMongo())).rejects.toThrow(/拒绝创建无认证的 mongo/);
    // 关键：拦下之后不能已经把原容器删掉了，否则「拦住」等于毁数据。
    expect(mock.commands.some((c) => /docker rm -f/.test(c))).toBe(false);
  });

  it('配了凭据的容器：创建路径正常放行', async () => {
    mock.addResponsePatternFirst(/docker inspect --format='\{\{\.State\.Status\}\}'/, () => ({ stdout: '', stderr: 'No such object', exitCode: 1 }));
    const service = new ContainerService(mock, makeConfig());
    const authed = unauthenticatedMongo({ env: { MONGO_INITDB_ROOT_USERNAME: 'root', MONGO_INITDB_ROOT_PASSWORD: 'secret' } });
    await expect(service.startInfraService(authed)).resolves.toBeUndefined();
    expect(mock.commands.some((c) => /docker run/.test(c))).toBe(true);
  });
});
