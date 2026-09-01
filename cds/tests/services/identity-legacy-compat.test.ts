/**
 * 身份层的**零回归**守卫。
 *
 * 这一层是纯增量：三张表缺省为空，存量凭证不带主体、不带到期。把这句话写成
 * 能变红的判据，而不是留在提交信息里 —— 否则下一个人加一条「必须有主体」的
 * 校验时，存量安装会在他毫不知情的情况下集体 401。
 *
 * 判据取自一份**没有任何身份层字段**的 state.json（升级前的真实形状）。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { StateService } from '../../src/services/state.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';
import { buildPrincipalOverview, credentialUsability } from '../../src/services/identity.js';

const LEGACY_KEY = 'cdsp_legacy-proj_thisisalegacyplaintextkey';

function writeLegacyState(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const now = '2026-01-01T00:00:00Z';
  fs.writeFileSync(filePath, JSON.stringify({
    routingRules: [], buildProfiles: [], branches: {}, infraServices: [],
    nextPortIndex: 0, logs: {}, defaultBranch: null,
    // 升级前的项目形状：agentKeys 没有 principalId / issuedByCredentialId / expiresAt
    projects: [{
      id: 'legacy-p', slug: 'legacy-proj', name: '存量项目',
      createdAt: now, updatedAt: now,
      agentKeys: [{
        id: 'legacy-key-1',
        label: '升级前签发的钥匙',
        hash: crypto.createHash('sha256').update(LEGACY_KEY).digest('hex'),
        scope: 'rw',
        createdAt: now,
      }],
    }],
    // 刻意不写 principals / userCredentials / projectGrants
  }), 'utf-8');
}

describe('身份层零回归 —— 升级前的 state.json', () => {
  let tmp: string;
  let stateFile: string;
  let svc: StateService;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-legacy-compat-'));
    stateFile = path.join(tmp, 'state.json');
    writeLegacyState(stateFile);
    svc = new StateService(stateFile, tmp);
    svc.load();
  });

  afterEach(() => {
    flushAllJsonStateStores();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('三张表缺省为空，读它们不抛错', () => {
    expect(svc.getPrincipals()).toEqual([]);
    expect(svc.getUserCredentials()).toEqual([]);
    expect(svc.getProjectGrants()).toEqual([]);
  });

  it('存量项目级凭证照常通过鉴权 —— 这是升级最不能坏的一条', () => {
    expect(svc.findAgentKeyForAuth(LEGACY_KEY)).toEqual({
      projectId: 'legacy-p',
      keyId: 'legacy-key-1',
    });
  });

  it('存量凭证没有到期字段 = 永不过期，十年后照样能用', () => {
    const key = svc.getAgentKeys('legacy-p')[0];
    expect(key.expiresAt).toBeUndefined();
    const tenYears = Date.now() + 10 * 365 * 24 * 60 * 60 * 1000;
    expect(credentialUsability(key, undefined, tenYears)).toEqual({ usable: true });
  });

  it('存量凭证不带主体，也不会被硬塞给某个主体 —— 在总览里明说成「未认领」', () => {
    const overview = buildPrincipalOverview({
      principals: svc.getPrincipals(),
      userCredentials: svc.getUserCredentials(),
      projectCredentials: svc.getAllAgentKeysWithProject(),
      grants: svc.getProjectGrants(),
    });
    expect(overview.rows).toEqual([]);
    expect(overview.unclaimed.map((c) => c.id)).toEqual(['legacy-key-1']);
    expect(overview.unclaimed[0].status).toBe('active');
  });

  it('不认领也能继续用：认领只影响能不能自助补发，不影响能不能鉴权', () => {
    // 先确认能用
    expect(svc.findAgentKeyForAuth(LEGACY_KEY)).not.toBeNull();
    // 加一个主体和一张不相干的用户级凭证，存量凭证不受任何影响
    svc.addPrincipal({
      id: 'pr_new', name: '新机器', kind: 'machine', status: 'active',
      createdAt: new Date().toISOString(),
    });
    expect(svc.findAgentKeyForAuth(LEGACY_KEY)).toEqual({
      projectId: 'legacy-p', keyId: 'legacy-key-1',
    });
  });

  it('吊销存量凭证的行为不变（吊销后不可用，记录仍在）', () => {
    expect(svc.revokeAgentKey('legacy-p', 'legacy-key-1')).toBe(true);
    expect(svc.findAgentKeyForAuth(LEGACY_KEY)).toBeNull();
    expect(svc.getAgentKeys('legacy-p')[0].revokedAt).toBeTruthy();
  });
});
