/**
 * credential-self-check —— 「我这把凭据到底怎么了」的判据测试。
 *
 * 本模块存在的唯一理由是：把今天塌缩成一句「未授权」的四五种成因拆开。
 * 所以测试的重点不是「有效的能认出来」（那太容易），而是：
 *
 *   1. **已吊销** 与 **从未签发** 必须分得开 —— 这正是鉴权路径做不到的事
 *      （它对两者都返回 null），也是用户「吊销页面删也不是留也不是」那个
 *      两难的技术根源。
 *   2. **prefix-mismatch** 能被单独报出来 —— 项目改过 slug 之后，存量凭据
 *      没被吊销、项目卡上看得见，但鉴权按前缀定位项目时会跳过它。
 *   3. 判据与真实鉴权路径 `StateService.findAgentKeyForAuth` **不漂移**：
 *      对同一把有效凭据，两者必须指向同一个 project/key。
 *   4. 结果里**绝不出现明文或哈希**。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {
  checkCredential,
  classifyCredential,
  hashCredential,
  PROJECT_SLUG_HEAD_LENGTH,
  type CredentialFacts,
  type StoredCredential,
} from '../../src/services/credential-self-check.js';
import { StateService } from '../../src/services/state.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';

/** 写一份最小 state.json，里面只有一个项目 —— 漂移守卫需要真实 StateService。 */
function seedStateWithProject(filePath: string, slug: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const now = '2026-01-01T00:00:00Z';
  fs.writeFileSync(
    filePath,
    JSON.stringify({
      routingRules: [],
      buildProfiles: [],
      branches: {},
      infraServices: [],
      nextPortIndex: 0,
      logs: {},
      defaultBranch: null,
      projects: [
        { id: 'p1', slug, name: '示例项目', createdAt: now, updatedAt: now },
      ],
    }),
    'utf-8',
  );
}

/** 造一把项目级明文凭据，前缀取自给定 slug（与签发路径同一公式）。 */
function makeProjectKey(slug: string, suffix = 'abcdefghijklmnopqrstuvwx'): string {
  return `cdsp_${slug.slice(0, PROJECT_SLUG_HEAD_LENGTH).toLowerCase()}_${suffix}`;
}

function storedFor(plaintext: string, overrides: Partial<StoredCredential> = {}): StoredCredential {
  return {
    id: 'k1',
    label: '签发于测试',
    hash: hashCredential(plaintext),
    createdAt: '2026-01-01T00:00:00Z',
    createdBy: 'tester',
    ...overrides,
  };
}

function factsWith(projectSlug: string, keys: StoredCredential[]): CredentialFacts {
  return {
    projects: [{ id: 'p1', slug: projectSlug, name: '示例项目', agentKeys: keys }],
  };
}

describe('classifyCredential', () => {
  it('按前缀认出四类凭据', () => {
    expect(classifyCredential('cdsp_demo_xxx')).toBe('project');
    expect(classifyCredential('cdsg_xxx')).toBe('global');
    expect(classifyCredential('ct_xxx')).toBe('connection');
    // 静态访问密钥没有约定前缀，先归为 static，由主流程按事实决定能不能判
    expect(classifyCredential('some-random-static-key')).toBe('static');
    expect(classifyCredential('')).toBe('unrecognized');
  });
});

describe('checkCredential —— 三态可分辨', () => {
  it('有效的项目级凭据：给出项目身份与签发信息', () => {
    const key = makeProjectKey('demo-project');
    const result = checkCredential(key, factsWith('demo-project', [storedFor(key)]));
    expect(result.kind).toBe('project');
    expect(result.status).toBe('active');
    expect(result.projectId).toBe('p1');
    expect(result.projectSlug).toBe('demo-project');
    expect(result.keyId).toBe('k1');
    expect(result.issuedAt).toBe('2026-01-01T00:00:00Z');
  });

  it('已吊销与从未签发是两种不同的结论（鉴权路径对两者都只回一个 null）', () => {
    const revokedKey = makeProjectKey('demo-project', 'revokedsuffixaaaaaaaaaaa');
    const strangerKey = makeProjectKey('demo-project', 'strangersuffixbbbbbbbbbb');
    const facts = factsWith('demo-project', [
      storedFor(revokedKey, { id: 'k-revoked', revokedAt: '2026-02-02T03:04:05Z' }),
    ]);

    const revoked = checkCredential(revokedKey, facts);
    expect(revoked.status).toBe('revoked');
    expect(revoked.revokedAt).toBe('2026-02-02T03:04:05Z');
    expect(revoked.keyId).toBe('k-revoked');
    expect(revoked.projectId).toBe('p1');

    const never = checkCredential(strangerKey, facts);
    expect(never.status).toBe('never-issued');
    // 从未签发时不得泄露任何项目信息
    expect(never.projectId).toBeUndefined();
    expect(never.keyId).toBeUndefined();

    expect(revoked.status).not.toBe(never.status);
  });

  it('项目改过 slug：凭据仍有效，但要报 prefix-mismatch 而不是 active', () => {
    // 凭据在项目还叫 old-slug 时签发；项目后来改名 new-slug。
    const key = makeProjectKey('old-slug-here');
    const facts = factsWith('new-slug-here', [storedFor(key)]);
    const result = checkCredential(key, facts);
    expect(result.status).toBe('prefix-mismatch');
    expect(result.projectSlug).toBe('new-slug-here');
    expect(result.revokedAt).toBeUndefined();
    // 结论必须点明「重试没用」，否则持有者会一直重试
    expect(result.nextStep).toContain('重新签发');
  });

  it('形状不对的项目级凭据报 malformed，不报 never-issued', () => {
    const result = checkCredential('cdsp_onlyonepart', factsWith('demo-project', []));
    expect(result.status).toBe('malformed');
  });

  it('全局凭据：有效 / 已吊销 / 从未签发三态齐全', () => {
    const active = 'cdsg_activesuffixaaaaaaaaaaaa';
    const revoked = 'cdsg_revokedsuffixbbbbbbbbbb';
    const facts: CredentialFacts = {
      projects: [],
      globalAgentKeys: [
        storedFor(active, { id: 'g-active' }),
        storedFor(revoked, { id: 'g-revoked', revokedAt: '2026-03-03T00:00:00Z' }),
      ],
    };
    expect(checkCredential(active, facts).status).toBe('active');
    const revokedResult = checkCredential(revoked, facts);
    expect(revokedResult.status).toBe('revoked');
    // 一次性「只能建项目」凭据被系统自动吊销，是最容易误判成故障的一种，
    // 结论里必须提到它，否则持有者会以为是被人撤了权限。
    expect(revokedResult.nextStep).toContain('一次性');
    expect(checkCredential('cdsg_neverissuedccccccccccc', facts).status).toBe('never-issued');
  });

  it('系统互联凭据缺少可比对记录时报 not-checkable，不猜', () => {
    const result = checkCredential('ct_sometoken', { projects: [] });
    expect(result.kind).toBe('connection');
    expect(result.status).toBe('not-checkable');
    expect(result.summary).toContain('查不了');
  });

  it('静态访问密钥：配了才判，没配就说查不了', () => {
    const key = 'plain-static-access-key';
    expect(checkCredential(key, { projects: [] }).status).toBe('not-checkable');
    const withStatic = checkCredential(key, {
      projects: [],
      staticKeyHashes: [hashCredential(key)],
    });
    expect(withStatic.kind).toBe('static');
    expect(withStatic.status).toBe('active');
  });

  it('空凭据报 malformed 并指出该放在哪个请求头', () => {
    const result = checkCredential('', { projects: [] });
    expect(result.status).toBe('malformed');
    expect(result.nextStep).toContain('请求头');
  });
});

describe('checkCredential —— 不泄密', () => {
  it('任何一种结论的完整输出里都不出现明文或哈希', () => {
    const key = makeProjectKey('demo-project');
    const hash = hashCredential(key);
    const cases = [
      checkCredential(key, factsWith('demo-project', [storedFor(key)])),
      checkCredential(key, factsWith('demo-project', [storedFor(key, { revokedAt: '2026-02-02T00:00:00Z' })])),
      checkCredential(key, factsWith('demo-project', [])),
      checkCredential(key, factsWith('other-slug-aa', [storedFor(key)])),
      checkCredential('ct_x', { projects: [] }),
    ];
    for (const result of cases) {
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(key);
      expect(serialized).not.toContain(hash);
    }
  });
});

describe('与真实鉴权路径不漂移', () => {
  let tmpDir: string;
  let stateFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-cred-selfcheck-'));
    stateFile = path.join(tmpDir, 'state.json');
  });

  afterEach(() => {
    flushAllJsonStateStores();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * 这条守卫防的是形状 3（同一个判断被抄成两份然后各自漂移）：自检模块
   * 自己算哈希、自己比对，如果哪天签发路径换了哈希算法或前缀公式，而只改了
   * 一边，这里会红。
   */
  it('对同一把有效凭据，自检与 findAgentKeyForAuth 指向同一个 project/key', () => {
    seedStateWithProject(stateFile, 'drift-guard-proj');
    const svc = new StateService(stateFile, tmpDir);
    svc.load();
    const projects = svc.getState().projects || [];
    expect(projects.length).toBeGreaterThan(0);
    const project = projects[0];

    const key = makeProjectKey(project.slug, crypto.randomBytes(18).toString('base64url'));
    svc.addAgentKey(project.id, {
      id: 'drift-guard-key',
      label: '漂移守卫',
      hash: hashCredential(key),
      scope: 'rw',
      createdAt: new Date().toISOString(),
    });

    const viaAuth = svc.findAgentKeyForAuth(key);
    expect(viaAuth).not.toBeNull();

    const viaSelfCheck = checkCredential(key, {
      projects: (svc.getState().projects || []).map((p) => ({
        id: p.id,
        slug: p.slug,
        name: p.name,
        agentKeys: p.agentKeys,
      })),
    });

    expect(viaSelfCheck.status).toBe('active');
    expect(viaSelfCheck.projectId).toBe(viaAuth!.projectId);
    expect(viaSelfCheck.keyId).toBe(viaAuth!.keyId);
  });

  it('吊销之后：鉴权返回 null，自检仍答得出「被吊销」—— 这正是本模块的存在理由', () => {
    seedStateWithProject(stateFile, 'revoke-guard-proj');
    const svc = new StateService(stateFile, tmpDir);
    svc.load();
    const project = (svc.getState().projects || [])[0];
    expect(project).toBeTruthy();
    const key = makeProjectKey(project.slug, crypto.randomBytes(18).toString('base64url'));
    svc.addAgentKey(project.id, {
      id: 'to-be-revoked',
      label: '待吊销',
      hash: hashCredential(key),
      scope: 'rw',
      createdAt: new Date().toISOString(),
    });
    expect(svc.findAgentKeyForAuth(key)).not.toBeNull();

    svc.revokeAgentKey(project.id, 'to-be-revoked');

    // 鉴权只回答「不能进」，分不出为什么
    expect(svc.findAgentKeyForAuth(key)).toBeNull();

    // 自检答得出「被吊销、何时」
    const result = checkCredential(key, {
      projects: (svc.getState().projects || []).map((p) => ({
        id: p.id,
        slug: p.slug,
        name: p.name,
        agentKeys: p.agentKeys,
      })),
    });
    expect(result.status).toBe('revoked');
    expect(result.keyId).toBe('to-be-revoked');
    expect(result.revokedAt).toBeTruthy();
  });
});
