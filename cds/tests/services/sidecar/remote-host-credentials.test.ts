/**
 * remote-host-credentials.test.ts — 三种接法的契约。
 *
 * 背景：CDS 以前只认「粘一段 PEM 私钥」。手上只有一串用户名密码、
 * 或者什么都没有的人，加一台服务器要先离开 CDS 去本地 ssh-keygen，
 * 等于把人挡在门外。这里锁住新的三条路：
 *
 *   1. 粘私钥（存量行为，不许被新代码改坏）
 *   2. 填密码
 *   3. 让 CDS 生成密钥对（私钥留在 CDS，只给公钥）
 *
 * 以及一条更重要的：**三选一必须互斥**。多选静默取其一的话，
 * 「我明明填了密码」会变成一次无人察觉的凭据回退。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { utils as ssh2Utils } from 'ssh2';

import { StateService } from '../../../src/services/state.js';
import { flushAllJsonStateStores } from '../../../src/infra/state-store/json-backing-store.js';
import {
  RemoteHostService,
  decryptRemoteHostSecrets,
  generateSshKeyPair,
} from '../../../src/services/sidecar/remote-host-service.js';

const SAMPLE_PEM =
  '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAAB\n-----END OPENSSH PRIVATE KEY-----\n';

describe('RemoteHost 三种认证方式', () => {
  let tmpDir: string;
  let state: StateService;
  let svc: RemoteHostService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-remote-cred-'));
    state = new StateService(path.join(tmpDir, 'state.json'), tmpDir);
    state.load();
    svc = new RemoteHostService(state);
  });

  afterEach(async () => {
    await flushAllJsonStateStores();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('粘私钥：存量行为不变，authMethod 仍是 private-key', () => {
    const created = svc.create({ name: 'a', host: '10.0.0.1', sshUser: 'root', sshPrivateKey: SAMPLE_PEM });
    expect(created.authMethod).toBe('private-key');
    const secrets = decryptRemoteHostSecrets(svc.getRaw(created.id)!);
    expect(secrets.privateKey).toBe(SAMPLE_PEM);
    expect(secrets.password).toBeUndefined();
  });

  it('填密码：解密拿得到密码，且没有私钥可用', () => {
    const created = svc.create({ name: 'b', host: '10.0.0.2', sshUser: 'deploy', sshPassword: 's3cret' });
    expect(created.authMethod).toBe('password');
    const secrets = decryptRemoteHostSecrets(svc.getRaw(created.id)!);
    expect(secrets.password).toBe('s3cret');
    // undefined 而不是空字符串：ssh2 把 undefined 当「这项没配」，
    // 空串会被当成一把空私钥去尝试，报出来的错完全不知所云。
    expect(secrets.privateKey).toBeUndefined();
  });

  it('密码不出库视图（与私钥同等对待）', () => {
    const created = svc.create({ name: 'c', host: '10.0.0.3', sshUser: 'root', sshPassword: 'p@ss' });
    expect(JSON.stringify(created)).not.toContain('p@ss');
  });

  it('生成密钥对：公钥给出来，私钥留在库里且 ssh2 能解析', () => {
    const created = svc.create({ name: 'd', host: '10.0.0.4', sshUser: 'root', generateKeyPair: true });
    expect(created.authMethod).toBe('private-key');
    expect(created.publicKey).toMatch(/^ssh-rsa AAAA/);

    const secrets = decryptRemoteHostSecrets(svc.getRaw(created.id)!);
    expect(secrets.privateKey).toContain('PRIVATE KEY');
    // 这条断言是这项功能的命门：生成的私钥如果 ssh2 解析不了，
    // 整条「CDS 生成密钥对」的路是死的，而 UI 上一切正常。
    const parsed = ssh2Utils.parseKey(secrets.privateKey!);
    expect(parsed instanceof Error).toBe(false);
  });

  it('生成的公钥与私钥是同一对（不是各生成一次）', () => {
    const pair = generateSshKeyPair('unit');
    const parsed = ssh2Utils.parseKey(pair.privateKey);
    expect(parsed instanceof Error).toBe(false);
    const derived = `${(parsed as { type: string }).type} ${(parsed as { getPublicSSH(): Buffer }).getPublicSSH().toString('base64')}`;
    expect(pair.publicKey.startsWith(derived)).toBe(true);
  });

  it('一种凭据都不给：拒绝，不落一条连不上的主机', () => {
    expect(() => svc.create({ name: 'e', host: '10.0.0.5', sshUser: 'root' })).toThrow(/认证方式/);
    expect(svc.list()).toHaveLength(0);
  });

  it('同时给两种：拒绝，不许有隐藏优先级', () => {
    expect(() => svc.create({
      name: 'f', host: '10.0.0.6', sshUser: 'root', sshPrivateKey: SAMPLE_PEM, sshPassword: 'x',
    })).toThrow(/只能选一种/);
    expect(() => svc.create({
      name: 'g', host: '10.0.0.7', sshUser: 'root', generateKeyPair: true, sshPassword: 'x',
    })).toThrow(/只能选一种/);
  });

  it('改成密码认证会清掉旧私钥（否则等于静默回退到旧凭据）', () => {
    const created = svc.create({ name: 'h', host: '10.0.0.8', sshUser: 'root', sshPrivateKey: SAMPLE_PEM });
    svc.update(created.id, { sshPassword: 'newpass' });
    const secrets = decryptRemoteHostSecrets(svc.getRaw(created.id)!);
    expect(secrets.password).toBe('newpass');
    expect(secrets.privateKey).toBeUndefined();
    expect(svc.get(created.id)?.authMethod).toBe('password');
  });

  it('改回私钥认证会清掉旧密码', () => {
    const created = svc.create({ name: 'i', host: '10.0.0.9', sshUser: 'root', sshPassword: 'oldpass' });
    svc.update(created.id, { sshPrivateKey: SAMPLE_PEM });
    const secrets = decryptRemoteHostSecrets(svc.getRaw(created.id)!);
    expect(secrets.privateKey).toBe(SAMPLE_PEM);
    expect(secrets.password).toBeUndefined();
    expect(svc.get(created.id)?.authMethod).toBe('private-key');
  });

  it('存量数据没有 sshAuthMethod 时按 private-key 解读', () => {
    const created = svc.create({ name: 'j', host: '10.0.1.0', sshUser: 'root', sshPrivateKey: SAMPLE_PEM });
    state.updateRemoteHost(created.id, { sshAuthMethod: undefined });
    expect(svc.get(created.id)?.authMethod).toBe('private-key');
  });
});
