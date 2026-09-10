/**
 * 存活告警 → MAP 站内通知（2026-09-09，规则 degradation-must-alarm 层 4）。
 *
 * 守四件事：
 *   1. canonical 与 MAP 的 BuildCanonicalRequest 逐字节一致——这是**两侧各写一份**的
 *      判据，最容易各自漂移（形状 3），所以用固定向量钉死格式；
 *   2. 签名真的能被 RSA-PSS 公钥验证（等价于 MAP 侧 VerifySignature 的那套参数），
 *      padding 或 saltLength 写错会在线上变成静默的 invalid_signature；
 *   3. 载荷映射：掉线/恢复的级别、幂等键、正文写症状与下一步；
 *   4. index.ts 的接线在场——少这一行，铃装好了但永远不会响，
 *      而这正是本规则要治的病，不能自己先犯。
 */

import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildCanonicalRequest,
  signCanonical,
  buildNotificationPayload,
  mapNotifierConfigFromEnv,
  DEFAULT_TIMEOUT_MS,
} from '../../src/services/map-notifier.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../..');

describe('canonical 请求串', () => {
  it('格式与 MAP 的 BuildCanonicalRequest 逐字节一致', () => {
    // 固定向量：METHOD \n path \n timestamp \n nonce \n username \n sha256hex(body)
    // body 的哈希是小写十六进制（C# 侧 Convert.ToHexString(...).ToLowerInvariant()）。
    const canonical = buildCanonicalRequest(
      'post',
      '/api/dashboard/notifications/events',
      1757404800,
      'nonce-1',
      'cds-uptime-bot',
      '{"a":1}',
    );
    // 字面量而不是现算：现算等于「用同一份逻辑验证自己」，锁不住跨语言契约。
    // 这一串同时写死在 C# 侧 CanonicalRequestCrossLanguageContractTests 里，
    // 任一侧改格式，两边都会红。
    const expectedHash = '015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862';
    expect(crypto.createHash('sha256').update('{"a":1}', 'utf8').digest('hex')).toBe(expectedHash);

    expect(canonical).toBe(
      [
        'POST',                                   // 方法大写
        '/api/dashboard/notifications/events',
        '1757404800',
        'nonce-1',
        'cds-uptime-bot',
        expectedHash,
      ].join('\n'),
    );
    // 小写十六进制，不是 Base64、不带分隔符
    expect(expectedHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('空 body 也按 sha256 哈希，不是空串', () => {
    const canonical = buildCanonicalRequest('POST', '/p', 1, 'n', 'u', '');
    expect(canonical.split('\n')[5]).toBe(
      crypto.createHash('sha256').update('', 'utf8').digest('hex'),
    );
  });
});

describe('签名', () => {
  it('产出的签名能被 RSA-PSS/SHA256 公钥验证（与 MAP 侧同参数）', () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const canonical = buildCanonicalRequest('POST', '/p', 1757404800, 'n1', 'u1', '{}');

    const signature = signCanonical(privatePem, canonical);

    // 这段验证逻辑刻意与 MAP 的 VerifySignature 同参数：
    // RSA-PSS + SHA256 + salt=摘要长度。改动任一项，线上会变成静默 401。
    const ok = crypto.verify(
      'sha256',
      Buffer.from(canonical, 'utf8'),
      {
        key: publicKey,
        padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
        saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
      },
      Buffer.from(signature, 'base64'),
    );
    expect(ok).toBe(true);
  });

  it('换一个字签名就不成立（证明签的是 canonical 本身）', () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const signature = signCanonical(privatePem, 'AAA');

    const ok = crypto.verify(
      'sha256',
      Buffer.from('AAB', 'utf8'),
      {
        key: publicKey,
        padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
        saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
      },
      Buffer.from(signature, 'base64'),
    );
    expect(ok).toBe(false);
  });
});

describe('通知载荷', () => {
  const base = {
    targetId: 'monitor@abc',
    targetName: 'LLM Gateway serving',
    projectId: 'prd-agent',
    branchId: 'main',
    message: '探测连续失败',
    consecutiveFailures: 2,
    detectedAt: '2026-09-09T09:00:00.000Z',
  };

  it('掉线是 error 级、带下一步；来源与分区固定', () => {
    const p = buildNotificationPayload({ ...base, type: 'uptime.target.down' });
    expect(p.source).toBe('uptime-alert');   // 必须与 MAP SourceCatalog 登记的一致
    expect(p.section).toBe('admin');
    expect(p.level).toBe('error');
    expect(p.title).toContain('不可用');
    expect(p.message).toContain('下一步');   // 症状 + 下一步，不是只报个错
    expect(p.message).toContain('连续失败 2 次');
  });

  it('恢复是 info 级，不带下一步', () => {
    const p = buildNotificationPayload({ ...base, type: 'uptime.target.recovered' });
    expect(p.level).toBe('info');
    expect(p.title).toContain('已恢复');
    expect(p.message).not.toContain('下一步');
  });

  it('幂等键区分方向与时刻：同一次翻转可去重，不同次翻转不被合并', () => {
    const down = buildNotificationPayload({ ...base, type: 'uptime.target.down' });
    const again = buildNotificationPayload({ ...base, type: 'uptime.target.down' });
    const recovered = buildNotificationPayload({ ...base, type: 'uptime.target.recovered' });
    const laterDown = buildNotificationPayload({
      ...base,
      type: 'uptime.target.down',
      detectedAt: '2026-09-09T10:00:00.000Z',
    });

    expect(down.dedupKey).toBe(again.dedupKey);
    expect(down.dedupKey).not.toBe(recovered.dedupKey);
    expect(down.dedupKey).not.toBe(laterDown.dedupKey);
  });

  it('有被监控地址时给出可点击动作', () => {
    const p = buildNotificationPayload({
      ...base,
      type: 'uptime.target.down',
      probeUrl: 'https://example.test/healthz',
    });
    expect(p.actionUrl).toBe('https://example.test/healthz');
    expect(p.actionLabel).toBeTruthy();
  });
});

describe('配置解析', () => {
  const full = {
    CDS_MAP_NOTIFY_ENDPOINT: 'https://map.test/api/dashboard/notifications/events',
    CDS_MAP_NOTIFY_KEY_ID: 'k1',
    CDS_MAP_NOTIFY_USERNAME: 'cds-uptime-bot',
    CDS_MAP_NOTIFY_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nAAA\\n-----END PRIVATE KEY-----',
  } as NodeJS.ProcessEnv;

  it('齐全时解析成功，并把字面 \\n 还原成真换行', () => {
    const cfg = mapNotifierConfigFromEnv(full);
    expect(cfg).not.toBeNull();
    // env 里的 PEM 常被写成字面 \n；不还原的话 crypto 会直接抛，铃在第一次告警时才哑
    expect(cfg!.privateKeyPem).toContain('\n');
    expect(cfg!.privateKeyPem).not.toContain('\\n');
    expect(cfg!.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
  });

  it('缺任何一项都返回 null（宁可明说没配，也不半配着跑）', () => {
    for (const key of Object.keys(full)) {
      const partial = { ...full };
      delete partial[key];
      expect(mapNotifierConfigFromEnv(partial), `缺 ${key} 时应为 null`).toBeNull();
    }
  });
});

describe('接线守卫', () => {
  const indexSource = fs.readFileSync(path.join(REPO, 'cds/src/index.ts'), 'utf8');

  it('onAlert 里必须真的调用 mapNotifier.send —— 少这一行铃永远不会响', () => {
    const at = indexSource.indexOf('onAlert: (type, data) => {');
    expect(at, '找不到 uptime 的 onAlert 接线，守卫的取值范围需要跟着改').toBeGreaterThanOrEqual(0);
    const block = indexSource.slice(at, at + 1200);
    expect(block).toContain('cdsEventsBus.publish');
    expect(block).toContain('mapNotifier?.send');
  });

  it('未配置凭据时必须把「不会有人被通知」印出来，不许静默禁用', () => {
    expect(indexSource).toContain('[map-notifier] 未配置');
    expect(indexSource).toContain('不会有人被通知');
  });
});
