/**
 * release-credential-safety.test.ts —— 凭据不得以任何形式外泄。
 *
 * 两条都来自 Codex review（2026-07-29）：
 *  - 密码认证主机的「指纹」由明文口令算出，还经公开接口返回 → 离线撞库；
 *  - SSH 失败摘要新纳入 stdout 后，Authorization 头 / JSON 口令 / URL userinfo
 *    这些格式一条都没盖住，而这段文本会落进 run.errorMessage 并在发布中心展示。
 */

import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { maskSshExecSecrets } from '../../src/services/ssh-exec-failure.js';
import {
  RemoteHostService,
  fingerprintPrivateKey,
  opaqueCredentialRef,
} from '../../src/services/sidecar/remote-host-service.js';

/** 只实现 create/update 用到的两个方法，够断言公开视图即可。 */
function stubState() {
  const hosts: Record<string, unknown>[] = [];
  return {
    hosts,
    service: new RemoteHostService({
      addRemoteHost: (h: Record<string, unknown>) => { hosts.push(h); },
      getRemoteHost: (id: string) => hosts.find((h) => h.id === id),
      getRemoteHosts: () => hosts,
      updateRemoteHost: (id: string, fields: Record<string, unknown>) => {
        const idx = hosts.findIndex((h) => h.id === id);
        hosts[idx] = { ...hosts[idx], ...fields };
        return hosts[idx];
      },
    } as never),
  };
}

const PASSWORD = 'hunter2';
const derivedFromPassword = crypto.createHash('sha256').update(PASSWORD).digest('hex').slice(0, 16);

describe('密码认证主机的公开标识不是口令的校验子', () => {
  it('opaqueCredentialRef 与任何输入无关，两次调用也不相同', () => {
    const a = opaqueCredentialRef();
    const b = opaqueCredentialRef();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it('拿到公开标识也无法验证口令猜测', () => {
    const published = opaqueCredentialRef();
    // 攻击者的动作：对候选口令跑同一个派生函数，比对公开值。
    // 曾经的实现就是 sha256(password).slice(0,16)，这一步会命中。
    expect(published).not.toBe(fingerprintPrivateKey(PASSWORD));
    expect(published).not.toBe(derivedFromPassword);
  });

  // 上面两条只证明「那个辅助函数是安全的」。真正会外泄的是 create()/update()
  // 落库并经 GET /api/cds-system/remote-hosts 返回的那个值——不断言到这一层，
  // 把 create() 改回 fingerprintPrivateKey(password) 测试照样全绿。
  it('create() 建的密码主机，公开指纹不是口令派生的', () => {
    const { service } = stubState();
    const view = service.create({
      name: 'prod', host: '10.0.0.1', sshUser: 'root', sshPassword: PASSWORD,
    } as never);
    expect(view.authMethod).toBe('password');
    expect(view.sshPrivateKeyFingerprint).not.toBe(derivedFromPassword);
    expect(view.sshPrivateKeyFingerprint).not.toBe(fingerprintPrivateKey(PASSWORD));
  });

  it('update() 换成密码认证时同样不派生', () => {
    const { service } = stubState();
    const created = service.create({
      name: 'prod', host: '10.0.0.1', sshUser: 'root', generateKeyPair: true,
    } as never);
    const updated = service.update(created.id, { sshPassword: PASSWORD });
    expect(updated.authMethod).toBe('password');
    expect(updated.sshPrivateKeyFingerprint).not.toBe(derivedFromPassword);
  });

  it('私钥主机仍然用内容指纹（换没换过密钥要看得出来）', () => {
    const { service } = stubState();
    const a = service.create({ name: 'a', host: 'h', sshUser: 'root', generateKeyPair: true } as never);
    const b = service.create({ name: 'b', host: 'h', sshUser: 'root', generateKeyPair: true } as never);
    expect(a.sshPrivateKeyFingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(a.sshPrivateKeyFingerprint).not.toBe(b.sshPrivateKeyFingerprint);
  });

  it('切到密码认证会清掉私钥口令，公开视图不再谎报 hasPassphrase', () => {
    const { service } = stubState();
    const created = service.create({
      name: 'prod', host: 'h', sshUser: 'root', sshPrivateKey: 'KEY', sshPassphrase: 'pp',
    } as never);
    expect(created.hasPassphrase).toBe(true);
    const updated = service.update(created.id, { sshPassword: PASSWORD });
    // 留着它：公开视图继续报 hasPassphrase，且日后换回私钥时这枚陈年口令
    // 会被拿去解新私钥，认证失败还查不出原因。
    expect(updated.hasPassphrase).toBe(false);
  });

  it('建密码主机时顺带传了口令也不存（没有私钥可解）', () => {
    const { service } = stubState();
    const view = service.create({
      name: 'prod', host: 'h', sshUser: 'root', sshPassword: PASSWORD, sshPassphrase: 'pp',
    } as never);
    expect(view.hasPassphrase).toBe(false);
  });
});

describe('maskSshExecSecrets 覆盖真实输出里的凭据形状', () => {
  it('裸环境变量赋值', () => {
    expect(maskSshExecSecrets('LLMGW_GATE_KEY=abc123')).toBe('LLMGW_GATE_KEY=***');
    expect(maskSshExecSecrets('PASSWORD=p@ss w0rd')).toBe('PASSWORD=*** w0rd');
  });

  it('Authorization 头连 scheme 一起盖掉', () => {
    expect(maskSshExecSecrets('Authorization: Bearer eyJhbGciOi.xxx.yyy'))
      .toBe('Authorization: ***');
    expect(maskSshExecSecrets('authorization:Basic dXNlcjpwYXNz')).toBe('authorization: ***');
    expect(maskSshExecSecrets('Proxy-Authorization: Bearer tok')).toBe('Proxy-Authorization: ***');
  });

  it('JSON / YAML 里的带引号口令', () => {
    expect(maskSshExecSecrets('{"password":"hunter2"}')).toBe('{"password":"***"}');
    expect(maskSshExecSecrets("token = 'abc'")).toBe("token = '***'");
    expect(maskSshExecSecrets('{"apiKey": "sk-live-1"}')).toBe('{"apiKey": "***"}');
    expect(maskSshExecSecrets('{"access_key": "AKIA"}')).toBe('{"access_key": "***"}');
  });

  it('URL 里的 userinfo', () => {
    expect(maskSshExecSecrets('git clone https://bot:ghp_secret@github.com/x/y.git'))
      .toBe('git clone https://bot:***@github.com/x/y.git');
    expect(maskSshExecSecrets('mongodb://admin:p4ss@db:27017/app'))
      .toBe('mongodb://admin:***@db:27017/app');
  });

  it('PEM 私钥整块替换', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----';
    expect(maskSshExecSecrets(pem)).toBe('***PRIVATE_KEY***');
  });

  it('不误伤普通输出', () => {
    const plain = 'npm WARN deprecated foo@1.0.0\nBuild succeeded in 12s\nhttps://example.com/path';
    expect(maskSshExecSecrets(plain)).toBe(plain);
  });

  it('几十 KB 单行输入不触发指数回溯（10 秒内必须返回）', () => {
    const started = Date.now();
    maskSshExecSecrets(`${'a'.repeat(80_000)} PASSWORD=x`);
    maskSshExecSecrets(`${'https://'.repeat(5_000)}x`);
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

describe('发布日志与失败摘要共用同一个脱敏器（接线守卫）', () => {
  it('release-service 的 maskLog 不再自带一份规则', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const url = await import('node:url');
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const source = fs.readFileSync(
      path.resolve(here, '../../src/services/release-service.ts'),
      'utf8',
    );
    // 两份分头漂移的后果是：同一条凭据在失败摘要里被盖住、在运行日志里照样露出来。
    expect(source).toMatch(/function maskLog\([^)]*\)[^{]*\{\s*(?:\/\/[^\n]*\n\s*)*return maskSshExecSecrets\(/);
    expect(source).not.toMatch(/maskLog[\s\S]{0,200}BEGIN \[\\s\\S\]/);
  });
});
