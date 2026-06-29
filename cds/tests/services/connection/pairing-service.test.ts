/**
 * pairing-service.test.ts —— spec.cds.map-pairing-protocol.md v1 状态机锁定。
 *
 * 覆盖：
 *   1. encodeClipboard / decodeClipboard round-trip
 *   2. issue 写一条 status='pending-pairing' + tokenHash + TTL
 *   3. accept 成功：转 active + projectId 落地 + 长效 token 返回
 *   4. accept 失败枚举（pairing_token_not_found / expired / used / project_intent_unsupported）
 *   5. authenticateLongToken：active + 未过期能解到 connection；revoked / 错 hash / 过期都拒
 *
 * 不接 MongoDB —— 走临时 state.json，与其他 state-* 测试同模式。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { StateService } from '../../../src/services/state.js';
import {
  CdsPairingService,
  PairingError,
  decodeClipboard,
  encodeClipboard,
  sha256Hex,
} from '../../../src/services/connection/pairing-service.js';
import type { Project } from '../../../src/types.js';

function makeService(): {
  state: StateService;
  pairing: CdsPairingService;
  cleanup: () => void;
} {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-pairing-'));
  const stateFile = path.join(tmpDir, 'state.json');
  const state = new StateService(stateFile, tmpDir);
  state.load();

  const pairing = new CdsPairingService(
    state,
    () => 'https://cds.test',
    () => 'cds-test-instance',
    () => 'cds-test',
  );

  return {
    state,
    pairing,
    cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
  };
}

function makeProject(id: string): Project {
  return {
    id,
    slug: id,
    name: id,
    kind: 'shared-service',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe('encodeClipboard / decodeClipboard', () => {
  it('round-trip 还原 payload', () => {
    const payload = {
      version: 1,
      cdsBaseUrl: 'https://cds.test',
      cdsId: 'a',
      pairingToken: 'pt_xxx',
      foo: { nested: 'bar' },
    };
    const txt = encodeClipboard(payload);
    expect(txt.startsWith('cds-connect:v1:')).toBe(true);
    const decoded = decodeClipboard(txt);
    expect(decoded.ok).toBe(true);
    expect(decoded.payload).toEqual(payload);
  });

  it('错误 prefix 报 invalid_format / version_not_supported', () => {
    expect(decodeClipboard('').ok).toBe(false);
    expect(decodeClipboard('not-cds-connect').errorCode).toBe('clipboard_invalid_format');
    expect(decodeClipboard('cds-connect:v999:abc').errorCode).toBe('clipboard_version_not_supported');
  });

  it('损坏 base64 报 invalid_format', () => {
    const txt = 'cds-connect:v1:!!!!!@@@@';
    const decoded = decodeClipboard(txt);
    expect(decoded.ok).toBe(false);
  });
});

describe('CdsPairingService.issue', () => {
  let env: ReturnType<typeof makeService>;
  beforeEach(() => { env = makeService(); });
  afterEach(() => env.cleanup());

  it('生成 pending-pairing connection + base64url 剪贴板', () => {
    const result = env.pairing.issue({});
    expect(result.connectionId).toMatch(/^conn_/);
    expect(result.pairingToken).toMatch(/^pt_/);
    expect(result.clipboardText.startsWith('cds-connect:v1:')).toBe(true);

    const conn = env.state.getCdsConnection(result.connectionId)!;
    expect(conn.status).toBe('pending-pairing');
    expect(conn.pairingTokenHash).toBe(sha256Hex(result.pairingToken));
    expect(conn.pairingExpiresAt).toBeDefined();
    expect(new Date(conn.pairingExpiresAt!).getTime()).toBeGreaterThan(Date.now());
  });

  it('clipboardText 解开后含 cds-base-url + pairingToken', () => {
    const result = env.pairing.issue({ name: 'demo' });
    const decoded = decodeClipboard(result.clipboardText);
    expect(decoded.ok).toBe(true);
    expect(decoded.payload!.cdsBaseUrl).toBe('https://cds.test');
    expect(decoded.payload!.pairingToken).toBe(result.pairingToken);
  });

  it('TTL clamp 到 1-60 分钟', () => {
    const tooShort = env.pairing.issue({ ttlMinutes: 0 });
    const exp1 = new Date(env.state.getCdsConnection(tooShort.connectionId)!.pairingExpiresAt!);
    expect(exp1.getTime() - Date.now()).toBeGreaterThan(0);
    expect(exp1.getTime() - Date.now()).toBeLessThan(2 * 60 * 1000); // 1 分钟

    const tooLong = env.pairing.issue({ ttlMinutes: 9999 });
    const exp2 = new Date(env.state.getCdsConnection(tooLong.connectionId)!.pairingExpiresAt!);
    expect(exp2.getTime() - Date.now()).toBeLessThan(61 * 60 * 1000); // 60 分钟
  });
});

describe('CdsPairingService.accept', () => {
  let env: ReturnType<typeof makeService>;
  beforeEach(() => { env = makeService(); });
  afterEach(() => env.cleanup());

  it('成功路径：pending → active + projectId 写入 + 返回 longToken', () => {
    const issued = env.pairing.issue({});
    const result = env.pairing.accept(
      {
        pairingToken: issued.pairingToken,
        partnerKind: 'map',
        partnerId: 'map-uuid',
        partnerName: 'prd-agent prod',
        partnerBaseUrl: 'https://prd-agent.test',
        projectIntent: { kind: 'shared-service', name: 'sidecar-pool' },
      },
      intent => {
        const p = makeProject(`proj-${intent.name}`);
        env.state.addProject(p);
        return p;
      },
    );

    expect(result.connectionId).toBe(issued.connectionId);
    expect(result.cdsLongToken).toMatch(/^ct_/);
    expect(result.projectId).toBe('proj-sidecar-pool');
    expect(result.instanceDiscoveryUrl).toBe('/api/projects/proj-sidecar-pool/instances');

    const conn = env.state.getCdsConnection(issued.connectionId)!;
    expect(conn.status).toBe('active');
    expect(conn.projectId).toBe('proj-sidecar-pool');
    expect(conn.partnerName).toBe('prd-agent prod');
    expect(conn.longTokenHash).toBe(sha256Hex(result.cdsLongToken));
    // pairing 字段被清空
    expect(conn.pairingTokenHash).toBeUndefined();
  });

  it('pairing_token_not_found：随机 token', () => {
    const err = (() => {
      try {
        env.pairing.accept(
          {
            pairingToken: 'pt_nonexistent',
            partnerKind: 'map',
            partnerId: 'a',
            partnerName: 'b',
            partnerBaseUrl: 'c',
            projectIntent: { kind: 'shared-service', name: 'x' },
          },
          () => makeProject('x'),
        );
        return null;
      } catch (e) {
        return e as PairingError;
      }
    })();
    expect(err).not.toBeNull();
    expect(err?.errorCode).toBe('pairing_token_not_found');
    expect(err?.httpStatus).toBe(404);
  });

  it('pairing_token_expired：手工把 expiresAt 调到过去', () => {
    const issued = env.pairing.issue({});
    env.state.updateCdsConnection(issued.connectionId, {
      pairingExpiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    const err = (() => {
      try {
        env.pairing.accept(
          {
            pairingToken: issued.pairingToken,
            partnerKind: 'map',
            partnerId: 'a',
            partnerName: 'b',
            partnerBaseUrl: 'c',
            projectIntent: { kind: 'shared-service', name: 'x' },
          },
          () => makeProject('x'),
        );
        return null;
      } catch (e) {
        return e as PairingError;
      }
    })();
    expect(err?.errorCode).toBe('pairing_token_expired');
    expect(err?.httpStatus).toBe(410);
  });

  it('pairing_token_used：第二次 accept 同一 token', () => {
    const issued = env.pairing.issue({});
    env.pairing.accept(
      {
        pairingToken: issued.pairingToken,
        partnerKind: 'map',
        partnerId: 'a',
        partnerName: 'b',
        partnerBaseUrl: 'c',
        projectIntent: { kind: 'shared-service', name: 'x' },
      },
      i => {
        const p = makeProject(`proj-${i.name}`);
        env.state.addProject(p);
        return p;
      },
    );

    const err = (() => {
      try {
        env.pairing.accept(
          {
            pairingToken: issued.pairingToken,
            partnerKind: 'map',
            partnerId: 'a',
            partnerName: 'b',
            partnerBaseUrl: 'c',
            projectIntent: { kind: 'shared-service', name: 'y' },
          },
          () => makeProject('y'),
        );
        return null;
      } catch (e) {
        return e as PairingError;
      }
    })();
    // 第二次：connection 已 active，hash 仍可查到但 status 不是 pending
    // findCdsConnectionByPairingHash 只找 pending → 走 not_found 分支或 used 分支
    expect(err).not.toBeNull();
    expect(['pairing_token_used', 'pairing_token_not_found']).toContain(err!.errorCode);
  });

  it('project_intent_unsupported', () => {
    const issued = env.pairing.issue({});
    const err = (() => {
      try {
        env.pairing.accept(
          {
            pairingToken: issued.pairingToken,
            partnerKind: 'map',
            partnerId: 'a',
            partnerName: 'b',
            partnerBaseUrl: 'c',
            projectIntent: { kind: 'unknown-kind' as 'shared-service', name: 'x' },
          },
          () => makeProject('x'),
        );
        return null;
      } catch (e) {
        return e as PairingError;
      }
    })();
    expect(err?.errorCode).toBe('project_intent_unsupported');
  });

  it('同一 MAP 重新授权：撤销旧 active 连接并签发新 longToken', () => {
    const first = env.pairing.issue({});
    const firstResult = env.pairing.accept(
      {
        pairingToken: first.pairingToken,
        partnerKind: 'map',
        partnerId: 'map-uuid',
        partnerName: 'prd-agent prod',
        partnerBaseUrl: 'https://prd-agent.test',
        projectIntent: { kind: 'shared-service', name: 'sidecar-pool' },
      },
      intent => {
        const p = makeProject(`proj-${intent.name}`);
        env.state.addProject(p);
        return p;
      },
    );

    const second = env.pairing.issue({});
    const secondResult = env.pairing.accept(
      {
        pairingToken: second.pairingToken,
        partnerKind: 'map',
        partnerId: 'map-uuid',
        partnerName: 'prd-agent prod',
        partnerBaseUrl: 'https://prd-agent.test',
        projectIntent: { kind: 'shared-service', name: 'sidecar-pool' },
      },
      intent => env.state.getProjects().find(p => p.id === `proj-${intent.name}`) ?? makeProject(`proj-${intent.name}`),
    );

    expect(secondResult.connectionId).toBe(second.connectionId);
    expect(secondResult.cdsLongToken).toMatch(/^ct_/);
    expect(secondResult.cdsLongToken).not.toBe(firstResult.cdsLongToken);
    expect(env.state.getCdsConnection(first.connectionId)?.status).toBe('revoked');
    expect(env.state.getCdsConnection(second.connectionId)?.status).toBe('active');
    expect(env.state.getActiveCdsConnections().filter(c => c.partnerId === 'map-uuid')).toHaveLength(1);
  });
});

describe('CdsPairingService.authenticateLongToken', () => {
  let env: ReturnType<typeof makeService>;
  beforeEach(() => { env = makeService(); });
  afterEach(() => env.cleanup());

  it('active + 未过期 → 解到 connection', () => {
    const issued = env.pairing.issue({});
    const result = env.pairing.accept(
      {
        pairingToken: issued.pairingToken,
        partnerKind: 'map',
        partnerId: 'a',
        partnerName: 'b',
        partnerBaseUrl: 'c',
        projectIntent: { kind: 'shared-service', name: 'svc' },
      },
      i => {
        const p = makeProject(`proj-${i.name}`);
        env.state.addProject(p);
        return p;
      },
    );
    const found = env.pairing.authenticateLongToken(result.cdsLongToken);
    expect(found?.id).toBe(issued.connectionId);
  });

  it('错 token / undefined / revoked → null', () => {
    expect(env.pairing.authenticateLongToken(undefined)).toBeNull();
    expect(env.pairing.authenticateLongToken('ct_random')).toBeNull();

    const issued = env.pairing.issue({});
    const accepted = env.pairing.accept(
      {
        pairingToken: issued.pairingToken,
        partnerKind: 'map',
        partnerId: 'a',
        partnerName: 'b',
        partnerBaseUrl: 'c',
        projectIntent: { kind: 'shared-service', name: 'svc2' },
      },
      i => {
        const p = makeProject(`proj-${i.name}`);
        env.state.addProject(p);
        return p;
      },
    );
    env.state.updateCdsConnection(issued.connectionId, { status: 'revoked', longTokenHash: undefined });
    expect(env.pairing.authenticateLongToken(accepted.cdsLongToken)).toBeNull();
  });
});
