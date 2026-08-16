import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  ALL_INTERFACES_HOST,
  BIND_HOST_ENV,
  DEFAULT_BIND_HOST,
  describeListenDecision,
  detectContainerRuntime,
  isExposedHost,
  resolveListenHost,
} from '../../src/services/listen-host.js';

/**
 * CDS 自身的监听地址。
 *
 * 守的不变量：**单机部署不许把控制面裸端口挂在全部网卡上**。
 * `server.listen(port, cb)` 不给 host，Node 就绑全网卡，等于绕过前置 nginx
 * 把 API 直接暴露在公网裸端口上。
 *
 * 反向的不变量同样要守：**集群部署必须放开**。绑死回环会让 executor 连不上
 * master、master 派不了活——那是把安全做成了故障。
 */

describe('单机部署', () => {
  it('默认只绑回环', () => {
    const d = resolveListenHost({ mode: 'standalone', processEnv: {} });
    expect(d.host).toBe(DEFAULT_BIND_HOST);
    expect(d.exposed).toBe(false);
  });

  /** 本机自己那条 executor 记录不构成「别的机器要连过来」的理由。 */
  it('只有本机 executor 时仍然绑回环', () => {
    for (const n of [0]) {
      expect(resolveListenHost({ mode: 'standalone', remoteExecutorCount: n, peerCount: 0, processEnv: {} }).exposed)
        .toBe(false);
    }
  });

  it('原因里写清了怎么改回去，不让人对着 connection refused 猜', () => {
    const d = resolveListenHost({ mode: 'standalone', processEnv: {} });
    expect(d.reason).toContain(BIND_HOST_ENV);
    expect(describeListenDecision(d)).toContain(DEFAULT_BIND_HOST);
  });
});

describe('集群部署必须放开（安全不能做成故障）', () => {
  it('executor 模式绑全部网卡', () => {
    const d = resolveListenHost({ mode: 'executor', processEnv: {} });
    expect(d.host).toBe(ALL_INTERFACES_HOST);
    expect(d.exposed).toBe(true);
    expect(d.reason).toContain('master');
  });

  it('已注册远端 executor 时绑全部网卡', () => {
    const d = resolveListenHost({ mode: 'standalone', remoteExecutorCount: 2, processEnv: {} });
    expect(d.exposed).toBe(true);
    expect(d.reason).toContain('2');
  });

  it('已配置对等节点时绑全部网卡', () => {
    expect(resolveListenHost({ mode: 'scheduler', peerCount: 1, processEnv: {} }).exposed).toBe(true);
  });
});

describe('逃生阀', () => {
  it('显式指定优先于一切推断', () => {
    expect(resolveListenHost({ mode: 'standalone', processEnv: { [BIND_HOST_ENV]: '0.0.0.0' } }).host).toBe('0.0.0.0');
    // 反向：集群角色下也能被显式收窄（运维明确知道自己在做什么）
    const narrowed = resolveListenHost({ mode: 'executor', processEnv: { [BIND_HOST_ENV]: '10.0.0.5' } });
    expect(narrowed.host).toBe('10.0.0.5');
    expect(narrowed.exposed).toBe(false);
  });

  it('空白值不算指定，走推断', () => {
    expect(resolveListenHost({ mode: 'standalone', processEnv: { [BIND_HOST_ENV]: '   ' } }).host)
      .toBe(DEFAULT_BIND_HOST);
  });
});

describe('暴露判据', () => {
  it('三种全网卡写法都算对外，空值也算', () => {
    for (const h of ['0.0.0.0', '::', '*', '', undefined, null]) {
      expect(isExposedHost(h as string), `${String(h)} 应判为对外`).toBe(true);
    }
  });

  it('具体地址不算对外', () => {
    for (const h of ['127.0.0.1', '172.17.0.1', '10.0.0.5']) {
      expect(isExposedHost(h)).toBe(false);
    }
  });
});

/**
 * 接线守卫。纯函数全绿也不能证明 index.ts 真的把地址传给了 `listen()`——
 * 少传一个参数，Node 就默默绑回全部网卡，而所有单测照样绿。
 */
describe('index.ts 真的把地址传给了 listen', () => {
  const SRC = fs.readFileSync(path.resolve(process.cwd(), 'src/index.ts'), 'utf8');
  /**
   * 去掉注释再断言，避免判据读到自己写的说明文字。
   *
   * 按**行**剥，不用跨行正则：后者会被源码里带 `/*` 的字符串与正则字面量带偏，
   * 错位之后会连真代码一起吞掉，判据于是对着一份残缺源码做断言。
   */
  const CODE = SRC.split('\n')
    .filter((l) => {
      const t = l.trim();
      return !(t.startsWith('//') || t.startsWith('/*') || t.startsWith('*'));
    })
    .join('\n');

  it('listen 调用带 host 参数', () => {
    expect(CODE).toMatch(/server\.listen\(\s*port\s*,\s*bind\.host\s*,/);
    // 不许残留「只给 port 和回调」的旧形状
    expect(CODE).not.toMatch(/server\.listen\(\s*port\s*,\s*\(\)/);
  });

  it('地址来自共享判定，不是就地又算一遍', () => {
    expect(CODE).toContain('resolveListenHost(');
    expect(CODE).not.toMatch(/listen\(\s*port\s*,\s*['"]127\.0\.0\.1['"]/);
  });

  it('启动日志打出了实际监听地址', () => {
    expect(CODE).toContain('describeListenDecision(');
  });
});

/**
 * 容器里的回环是**容器自己的**回环。`docker -p 9900:9900` 转发到容器的网络接口，
 * 不是它的 lo——绑回环等于把发布出去的端口全打死，而容器内的 healthcheck
 * （curl localhost:9900/healthz）照样通过：健康与可达彻底脱钩。
 */
describe('容器内必须绑全网卡', () => {
  it('检测到容器就放开，并说清原因', () => {
    const d = resolveListenHost({ mode: 'standalone', containerized: true, processEnv: {} });
    expect(d.host).toBe(ALL_INTERFACES_HOST);
    expect(d.exposed).toBe(true);
    expect(d.reason).toContain('容器');
  });

  it('容器判定排在集群角色之前——它是必然坏，集群只是可能需要', () => {
    // standalone + 零集群成员，唯一能救它的就是容器判定。
    const d = resolveListenHost({
      mode: 'standalone', remoteExecutorCount: 0, peerCount: 0,
      containerized: true, processEnv: {},
    });
    expect(d.host).toBe(ALL_INTERFACES_HOST);
  });

  it('显式 CDS_BIND_HOST 仍然压过容器判定', () => {
    const d = resolveListenHost({ containerized: true, processEnv: { CDS_BIND_HOST: '127.0.0.1' } });
    expect(d.host).toBe('127.0.0.1');
    expect(d.exposed).toBe(false);
  });

  it('不在容器里时维持回环默认', () => {
    expect(resolveListenHost({ mode: 'standalone', containerized: false, processEnv: {} }).host)
      .toBe(DEFAULT_BIND_HOST);
  });

  it('探测失败按「不在容器里」处理——宁可本机连不上，也不要端口意外敞开', () => {
    const boom = {
      existsSync: () => { throw new Error('EACCES'); },
      readFileSync: () => { throw new Error('EACCES'); },
    };
    expect(detectContainerRuntime(boom)).toBe(false);
  });

  it('/.dockerenv 与 cgroup 两条判据各自都算数', () => {
    expect(detectContainerRuntime({
      existsSync: (p) => p === '/.dockerenv',
      readFileSync: () => '',
    })).toBe(true);
    expect(detectContainerRuntime({
      existsSync: () => false,
      readFileSync: () => '0::/kubepods/burstable/podabc/xyz',
    })).toBe(true);
    expect(detectContainerRuntime({
      existsSync: () => false,
      readFileSync: () => '0::/init.scope',
    })).toBe(false);
  });
});
