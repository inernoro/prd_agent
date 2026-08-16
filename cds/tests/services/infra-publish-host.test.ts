import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ContainerService, type ProjectNetworkResolver } from '../../src/services/container.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import {
  DEFAULT_DOCKER_BRIDGE_HOST,
  INFRA_PUBLISH_HOST_ENV,
  buildInfraPublishFlags,
  infraPublishBindHint,
  isPubliclyPublished,
  resolveDockerBridgeHost,
  resolveInfraPublishHosts,
} from '../../src/services/infra-publish.js';
import type { CdsConfig, InfraService } from '../../src/types.js';

/**
 * 基础设施端口的发布地址。
 *
 * 守住的不变量只有一句：**infra 的宿主端口不许绑到全部网卡**。
 * `docker run -p <hostPort>:<containerPort>` 省略地址就是绑 0.0.0.0，等于把
 * Mongo / Redis / MySQL 的数据面挂到宿主每一张网卡上；而且这一层宿主防火墙
 * 挡不住——DNAT 之后走 FORWARD，不经 INPUT 链，`ufw default deny` 之类看着生效
 * 实际一个库都没挡住。
 *
 * 断言的是**行为**（拼出来的 docker 参数长什么样），不是某段实现的字面文本：
 * 实现怎么写随便，只要产出的命令不裸绑全网卡就行。
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

const makeInfraService = (overrides?: Partial<InfraService>): InfraService => ({
  id: 'mongodb',
  projectId: 'proj-a',
  name: 'MongoDB',
  dockerImage: 'mongo:8.0',
  containerPort: 27017,
  hostPort: 10001,
  containerName: 'cds-infra-mongodb',
  status: 'stopped',
  volumes: [],
  env: { MONGO_INITDB_ROOT_USERNAME: 'app', MONGO_INITDB_ROOT_PASSWORD: 'secret' },
  createdAt: '2026-08-16T00:00:00Z',
  ...overrides,
});

const okDockerStubs = (mock: MockShellExecutor): void => {
  mock.addResponsePattern(/docker network inspect/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
  mock.addResponsePattern(/docker (ps|inspect)/, () => ({ stdout: '', stderr: '', exitCode: 1 }));
  mock.addResponsePattern(/docker rm -f/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
  mock.addResponsePattern(/docker run/, () => ({ stdout: 'cid', stderr: '', exitCode: 0 }));
  mock.addResponsePattern(/mkdir/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
};

/** `-p` 参数里裸绑全部网卡的形状：`-p <数字>:<数字>`，中间没有地址段。 */
const BARE_PUBLISH = /-p\s+\d+:\d+(?:\s|$)/;

describe('发布地址解析', () => {
  const cleanEnv = (): Record<string, string | undefined> => ({});

  it('默认绑 docker 网桥 + 回环，两者都不是对外地址', () => {
    const hosts = resolveInfraPublishHosts({ processEnv: cleanEnv() });
    expect(hosts).toEqual([DEFAULT_DOCKER_BRIDGE_HOST, '127.0.0.1']);
    expect(isPubliclyPublished(hosts)).toBe(false);
  });

  /**
   * 不能只绑回环：应用容器拿到的连接串是 `mongodb://${CDS_HOST}:<port>`，
   * CDS_HOST 是网桥地址，容器访问不到宿主 loopback。只绑回环 = 全线断库。
   */
  it('默认一定包含网桥地址（只绑回环会让所有容器连不上库）', () => {
    expect(resolveInfraPublishHosts({ processEnv: cleanEnv() })).toContain(DEFAULT_DOCKER_BRIDGE_HOST);
  });

  it('网桥地址跟随 CDS_DOCKER_HOST，全局 customEnv 优先于进程环境', () => {
    expect(resolveDockerBridgeHost({ processEnv: { CDS_DOCKER_HOST: '10.8.0.1' } })).toBe('10.8.0.1');
    expect(resolveDockerBridgeHost({
      globalEnv: { CDS_DOCKER_HOST: '10.9.0.1' },
      processEnv: { CDS_DOCKER_HOST: '10.8.0.1' },
    })).toBe('10.9.0.1');
    expect(resolveDockerBridgeHost({ processEnv: cleanEnv() })).toBe(DEFAULT_DOCKER_BRIDGE_HOST);
  });

  it('网桥地址本身就是回环时去重（同地址绑两次 docker 会报端口占用）', () => {
    const hosts = resolveInfraPublishHosts({ bridgeHost: '127.0.0.1', processEnv: cleanEnv() });
    expect(hosts).toEqual(['127.0.0.1']);
  });

  it('旧全网卡覆盖值会被硬拒绝，不能退回不安全绑定', () => {
    expect(() => resolveInfraPublishHosts({
      processEnv: { [INFRA_PUBLISH_HOST_ENV]: '0.0.0.0' },
    })).toThrow('禁止绑定全部网卡');
    expect(() => resolveInfraPublishHosts({
      processEnv: { [INFRA_PUBLISH_HOST_ENV]: '::' },
    })).toThrow('禁止绑定全部网卡');
    // 任何其它取值都不该判成对外
    for (const v of ['', '   ', '172.17.0.1', '10.0.0.1,127.0.0.1']) {
      expect(isPubliclyPublished(resolveInfraPublishHosts({ processEnv: { [INFRA_PUBLISH_HOST_ENV]: v } })))
        .toBe(false);
    }
  });

  /** 「算不出地址」必须判成危险。把未知当安全是最容易漏的那种默认。 */
  it('空地址列表判为对外发布，不当作安全', () => {
    expect(isPubliclyPublished([])).toBe(true);
  });
});

describe('docker 参数拼装', () => {
  it('每个地址一条 -p，且都带地址段', () => {
    const flags = buildInfraPublishFlags(10001, 27017, ['172.17.0.1', '127.0.0.1']);
    expect(flags).toEqual(['-p 172.17.0.1:10001:27017', '-p 127.0.0.1:10001:27017']);
    for (const f of flags) expect(f).not.toMatch(BARE_PUBLISH);
  });

  it('调用方直接传全网卡也会被拒绝', () => {
    expect(() => buildInfraPublishFlags(10001, 27017, ['0.0.0.0']))
      .toThrow('禁止绑定全部网卡');
    expect(() => buildInfraPublishFlags(10001, 27017, []))
      .toThrow('禁止绑定全部网卡');
  });
});

describe('绑定失败的归因提示', () => {
  it('docker 报地址分配不出来时给出可照做的排查路径', () => {
    const hint = infraPublishBindHint(
      'docker: Error response from daemon: cannot assign requested address',
      ['172.17.0.1', '127.0.0.1'],
    );
    expect(hint).toContain('CDS_DOCKER_HOST');
    expect(hint).toContain('不会退回全网卡绑定');
  });

  it('与绑定无关的失败不加噪音', () => {
    expect(infraPublishBindHint('no such image: mongo:8.0', ['172.17.0.1'])).toBe('');
  });

  it('本来就绑全网卡时不提示（那不是绑定地址引起的）', () => {
    expect(infraPublishBindHint('cannot assign requested address', ['0.0.0.0'])).toBe('');
  });
});

/**
 * 接线守卫。
 *
 * 上面那些纯函数全绿，也不能证明 ContainerService 真的用上了它们——
 * 「判据写好却没接到调用点」是本仓库反复栽的形状。所以这一组跑真实的
 * `startInfraService`，从 MockShellExecutor 录下来的命令里读实际拼出的 `-p`。
 * 把 container.ts 的那行改回裸绑，这一组必红。
 */
describe('ContainerService 真的用上了收窄后的发布地址', () => {
  let mock: MockShellExecutor;
  let aliveStub: ReturnType<typeof vi.spyOn> | undefined;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    mock = new MockShellExecutor();
    okDockerStubs(mock);
    for (const k of [INFRA_PUBLISH_HOST_ENV, 'CDS_DOCKER_HOST']) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    aliveStub?.mockRestore();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const runInfra = async (resolver?: ProjectNetworkResolver): Promise<string> => {
    const service = new ContainerService(mock, makeConfig(), resolver);
    aliveStub = vi.spyOn(service as unknown as { waitForContainerAlive: () => Promise<void> }, 'waitForContainerAlive')
      .mockResolvedValue(undefined);
    await service.startInfraService(makeInfraService());
    const cmd = mock.commands.find((c) => c.includes('docker run -d'));
    expect(cmd, '没有录到 docker run 命令').toBeTruthy();
    return cmd as string;
  };

  it('默认拼出带地址的 -p，没有裸绑全网卡', async () => {
    const cmd = await runInfra();
    expect(cmd).toMatch(/-p 172\.17\.0\.1:10001:27017/);
    expect(cmd).toMatch(/-p 127\.0\.0\.1:10001:27017/);
    expect(cmd).not.toMatch(BARE_PUBLISH);
  });

  /**
   * 没注入适配器（老调用方、测试）时也不许退回裸绑——退化的默认必须仍然安全，
   * 否则「忘了接线」这件事本身就成了一个静默的公网暴露。
   */
  it('没有 networkResolver 时退化默认仍然是安全的', async () => {
    const cmd = await runInfra(undefined);
    expect(cmd).not.toMatch(BARE_PUBLISH);
  });

  it('适配器给的地址优先于进程环境（连接串与绑定地址同源）', async () => {
    const cmd = await runInfra({
      getDockerNetwork: () => undefined,
      getInfraPublishHosts: () => ['10.42.0.1'],
    });
    expect(cmd).toContain('-p 10.42.0.1:10001:27017');
    expect(cmd).not.toContain('172.17.0.1');
    expect(cmd).not.toMatch(BARE_PUBLISH);
  });

  it('旧全网卡环境变量不能绕过容器启动门禁', async () => {
    process.env[INFRA_PUBLISH_HOST_ENV] = '0.0.0.0';
    await expect(runInfra()).rejects.toThrow('禁止绑定全部网卡');
    expect(mock.commands.some((cmd) => cmd.includes('docker run -d'))).toBe(false);
  });
});
