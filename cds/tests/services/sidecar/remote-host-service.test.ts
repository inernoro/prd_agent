/**
 * remote-host-service.test.ts — 验证 RemoteHostService 的核心契约：
 *
 *   1. 录入主机时 SSH 私钥被 sealToken 加密（明文不出库视图）
 *   2. fingerprint = SHA256 前 16 hex，与明文一一对应，重复明文得相同 fp
 *   3. update 不传 sshPrivateKey 不会覆盖已有密文
 *   4. update + clearPassphrase 能擦除口令
 *   5. recordTestResult 把 lastTestOk / lastTestError / lastTestedAt 落到状态
 *
 * 使用临时 state.json + 真实 StateService（与其他 state-*.test.ts 同模式）。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { StateService } from '../../../src/services/state.js';
import { flushAllJsonStateStores } from '../../../src/infra/state-store/json-backing-store.js';
import {
  RemoteHostService,
  fingerprintPrivateKey,
  decryptRemoteHostSecrets,
} from '../../../src/services/sidecar/remote-host-service.js';

const SAMPLE_PEM =
  '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAAB\n-----END OPENSSH PRIVATE KEY-----\n';

describe('RemoteHostService', () => {
  let tmpDir: string;
  let stateFile: string;
  let state: StateService;
  let svc: RemoteHostService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-remote-host-'));
    stateFile = path.join(tmpDir, 'state.json');
    state = new StateService(stateFile, tmpDir);
    state.load();
    svc = new RemoteHostService(state);
  });

  afterEach(async () => {
    await flushAllJsonStateStores();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  describe('create', () => {
    it('录入后视图含 fingerprint，不暴露密文字段（出库 redact）', () => {
      const created = svc.create({
        name: 'sandbox-1',
        host: '1.2.3.4',
        sshUser: 'root',
        sshPrivateKey: SAMPLE_PEM,
      });

      expect(created.sshPrivateKeyFingerprint).toBe(fingerprintPrivateKey(SAMPLE_PEM));
      // RemoteHostPublicView 不暴露 sshPrivateKeyEncrypted
      expect((created as unknown as Record<string, unknown>).sshPrivateKeyEncrypted).toBeUndefined();

      // 内部 raw 视图始终能拿到（用于 deployer / decryption 路径）
      const raw = svc.getRaw(created.id)!;
      expect(raw.sshPrivateKeyEncrypted.length).toBeGreaterThan(0);
    });

    it('round-trip：sealToken → unsealToken 拿回明文（兼容 seal 启用与未启用两种 env）', () => {
      const created = svc.create({
        name: 'sandbox-2',
        host: '1.2.3.4',
        sshUser: 'root',
        sshPrivateKey: SAMPLE_PEM,
      });
      const raw = svc.getRaw(created.id)!;
      const { privateKey } = decryptRemoteHostSecrets(raw);
      expect(privateKey).toBe(SAMPLE_PEM);
    });

    it('seal 启用场景下密文是 SealedSecret 对象，不被 JSON.stringify 折叠成字符串（PR #529 Bugbot HIGH）', () => {
      // 历史 bug：旧代码用 `typeof sealed === 'string' ? sealed : JSON.stringify(sealed)`
      // 把 SealedSecret 序列化进 string 字段，导致 unsealToken 的 string 短路分支
      // 直接返回 JSON 字符串，永远拿不回明文。修复后字段类型改成 string | SealedSecret，
      // 直接存对象。
      const prev = process.env.CDS_SECRET_KEY;
      process.env.CDS_SECRET_KEY = 'a'.repeat(64); // 触发 sealToken 走加密路径
      try {
        const created = svc.create({
          name: 'sandbox-sealed',
          host: '1.2.3.4',
          sshUser: 'root',
          sshPrivateKey: SAMPLE_PEM,
          sshPassphrase: 'topsecret',
        });
        const raw = svc.getRaw(created.id)!;

        // 密文必须是对象，不是序列化字符串
        expect(typeof raw.sshPrivateKeyEncrypted).toBe('object');
        expect((raw.sshPrivateKeyEncrypted as { __sealed?: boolean }).__sealed).toBe(true);
        expect(typeof raw.sshPassphraseEncrypted).toBe('object');

        // round-trip 必须拿回原明文
        const { privateKey, passphrase } = decryptRemoteHostSecrets(raw);
        expect(privateKey).toBe(SAMPLE_PEM);
        expect(passphrase).toBe('topsecret');
      } finally {
        if (prev === undefined) delete process.env.CDS_SECRET_KEY;
        else process.env.CDS_SECRET_KEY = prev;
      }
    });

    it('fingerprint = SHA256 前 16 hex（与明文一对一）', () => {
      expect(fingerprintPrivateKey('aaa').length).toBe(16);
      expect(fingerprintPrivateKey('aaa')).toBe(fingerprintPrivateKey('aaa'));
      expect(fingerprintPrivateKey('aaa')).not.toBe(fingerprintPrivateKey('bbb'));
    });

    it('缺必填字段抛错', () => {
      expect(() =>
        svc.create({ name: '', host: '1.1.1.1', sshUser: 'r', sshPrivateKey: SAMPLE_PEM }),
      ).toThrow(/name/);
      expect(() =>
        svc.create({ name: 'x', host: '', sshUser: 'r', sshPrivateKey: SAMPLE_PEM }),
      ).toThrow(/host/);
      expect(() =>
        svc.create({ name: 'x', host: '1', sshUser: '', sshPrivateKey: SAMPLE_PEM }),
      ).toThrow(/sshUser/);
      expect(() =>
        svc.create({ name: 'x', host: '1', sshUser: 'r', sshPrivateKey: '' }),
      ).toThrow(/sshPrivateKey/);
    });

    it('重名拒绝', () => {
      svc.create({ name: 'dup', host: '1.2.3.4', sshUser: 'root', sshPrivateKey: SAMPLE_PEM });
      expect(() =>
        svc.create({ name: 'dup', host: '5.6.7.8', sshUser: 'root', sshPrivateKey: SAMPLE_PEM }),
      ).toThrow(/already exists/);
    });
  });

  describe('update', () => {
    let id: string;

    beforeEach(() => {
      const created = svc.create({
        name: 'h1',
        host: '1.2.3.4',
        sshUser: 'root',
        sshPrivateKey: SAMPLE_PEM,
        sshPassphrase: 'pp1',
      });
      id = created.id;
    });

    it('不传私钥时密文保持不变', () => {
      const before = svc.getRaw(id)!.sshPrivateKeyEncrypted;
      svc.update(id, { name: 'h1-renamed' });
      expect(svc.getRaw(id)!.sshPrivateKeyEncrypted).toBe(before);
      expect(svc.getRaw(id)!.name).toBe('h1-renamed');
    });

    it('传新私钥 → fingerprint + 密文都更新', () => {
      const newPem = 'NEW_PEM_CONTENT';
      svc.update(id, { sshPrivateKey: newPem });
      const raw = svc.getRaw(id)!;
      expect(raw.sshPrivateKeyFingerprint).toBe(fingerprintPrivateKey(newPem));
      const { privateKey } = decryptRemoteHostSecrets(raw);
      expect(privateKey).toBe(newPem);
    });

    it('clearPassphrase 擦除口令', () => {
      expect(svc.getRaw(id)!.sshPassphraseEncrypted).toBeDefined();
      svc.update(id, { clearPassphrase: true });
      expect(svc.getRaw(id)!.sshPassphraseEncrypted).toBeUndefined();
    });

    it('recordTestResult 写入 lastTestOk / lastTestError / lastTestedAt', () => {
      svc.recordTestResult(id, false, 'connection refused');
      const view = svc.get(id)!;
      expect(view.lastTestOk).toBe(false);
      expect(view.lastTestError).toBe('connection refused');
      expect(view.lastTestedAt).toBeDefined();

      svc.recordTestResult(id, true);
      const view2 = svc.get(id)!;
      expect(view2.lastTestOk).toBe(true);
      expect(view2.lastTestError).toBeUndefined();
    });
  });
});
