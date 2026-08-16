import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  ALL_INTERFACES_HOST,
  BIND_HOST_ENV,
  DEFAULT_BIND_HOST,
  describeListenDecision,
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
  /** 去掉注释再断言，避免判据读到自己写的说明文字。 */
  const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

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
