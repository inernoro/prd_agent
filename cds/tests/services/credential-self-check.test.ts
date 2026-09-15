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

  afterEach(async () => {
    await flushAllJsonStateStores();
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

/**
 * 用户级凭证（`cdsu_`）—— 这一段是发布当天在生产上撞出来的。
 *
 * P1 写自检时身份层还不存在，判据只认四种面。等 P2/P3 把 `cdsu_` 加进来，
 * 自检没跟着扩，于是一把**刚签发、正在生效**的用户级凭证被自检答成
 * 「从未签发」—— 恰恰是这个端点最不该给出的那句话（判据与凭据面漂移，
 * 见 predicate-and-wiring-discipline 形状 1）。下面这组用例把每一种结论
 * 都钉住，凭据面再扩时漏掉就会红。
 */
describe('credential-self-check：用户级凭证与到期', () => {
  const now = Date.now();
  const iso = (deltaMs: number) => new Date(now + deltaMs).toISOString();
  const userKey = 'cdsu_' + crypto.randomBytes(18).toString('base64url');

  const factsWith = (over: Partial<Parameters<typeof checkCredential>[1]> = {}) => ({
    projects: [],
    userCredentials: [
      {
        id: 'uc_live',
        principalId: 'pr_alice',
        hash: hashCredential(userKey),
        createdAt: iso(-1000),
        expiresAt: iso(30 * 86400_000),
      },
    ],
    principals: [{ id: 'pr_alice', name: '爱丽丝的笔记本', status: 'active' }],
    ...over,
  });

  it('形状识别：cdsu_ 单独成一类，不再落进 static/unrecognized', () => {
    expect(classifyCredential(userKey)).toBe('user');
  });

  it('生效中的用户级凭证报 active —— 这是发布当天生产上答错的那一条', () => {
    const r = checkCredential(userKey, factsWith());
    expect(r.kind).toBe('user');
    expect(r.status).toBe('active');
    expect(r.keyId).toBe('uc_live');
    // reach 必须同时说清「能到哪」和「到不了哪」——只写一半就是又一个含糊结论
    expect(r.reach).toContain('签发项目级凭证');
    expect(r.reach).toContain('不能');
  });

  it('到期与被吊销分得开：两者下一步不同，不许都答 revoked', () => {
    const expired = checkCredential(userKey, factsWith({
      userCredentials: [{
        id: 'uc_old',
        principalId: 'pr_alice',
        hash: hashCredential(userKey),
        createdAt: iso(-100 * 86400_000),
        expiresAt: iso(-86400_000),
      }],
    }));
    expect(expired.status).toBe('expired');
    // 断言的是「两者结论与下一步不同」，不是文案里出不出现某个词
    // （文案里刻意点明「到期与被吊销不同」，逐字禁词就成了反向锁死）
    expect(expired.summary).toContain('到期');

    const revoked = checkCredential(userKey, factsWith({
      userCredentials: [{
        id: 'uc_gone',
        principalId: 'pr_alice',
        hash: hashCredential(userKey),
        createdAt: iso(-1000),
        revokedAt: iso(-500),
      }],
    }));
    expect(revoked.status).toBe('revoked');
    expect(revoked.nextStep).not.toBe(expired.nextStep);
    // 级联是这条凭据面的特有后果，必须在下一步里讲明白
    expect(revoked.nextStep).toContain('级联');
  });

  it('主体被停用时报 principal-disabled，而不是 active —— 重新签发没用', () => {
    const r = checkCredential(userKey, factsWith({
      principals: [{ id: 'pr_alice', name: '爱丽丝的笔记本', status: 'disabled' }],
    }));
    expect(r.status).toBe('principal-disabled');
    expect(r.summary).toContain('爱丽丝的笔记本');
  });

  it('身份层未启用时报 not-checkable，不许退化成 never-issued', () => {
    const r = checkCredential(userKey, { projects: [] });
    expect(r.kind).toBe('user');
    expect(r.status).toBe('not-checkable');
  });

  it('身份层已启用但没这把 → never-issued', () => {
    const r = checkCredential('cdsu_' + crypto.randomBytes(18).toString('base64url'), factsWith());
    expect(r.status).toBe('never-issued');
  });

  it('项目级凭据同样认到期：新签发的项目级凭据是 30 天短命的', () => {
    const projectKey = 'cdsp_demo_' + crypto.randomBytes(18).toString('base64url');
    const r = checkCredential(projectKey, {
      projects: [{
        id: 'p1',
        slug: 'demo',
        name: '演示',
        agentKeys: [{
          id: 'ak_expired',
          hash: hashCredential(projectKey),
          createdAt: iso(-40 * 86400_000),
          expiresAt: iso(-86400_000),
        }],
      }],
    });
    expect(r.status).toBe('expired');
    expect(r.projectId).toBe('p1');
    // 项目级到期是可自愈的，下一步必须指向自愈而不是「找管理员」
    expect(r.nextStep).toContain('heal');
  });

  it('存量项目级凭据没有 expiresAt，判定与加这层之前逐字一致（零回归）', () => {
    const projectKey = 'cdsp_demo_' + crypto.randomBytes(18).toString('base64url');
    const r = checkCredential(projectKey, {
      projects: [{
        id: 'p1',
        slug: 'demo',
        agentKeys: [{ id: 'ak_legacy', hash: hashCredential(projectKey), createdAt: iso(-400 * 86400_000) }],
      }],
    });
    expect(r.status).toBe('active');
  });

  it('结果里绝不出现明文或哈希', () => {
    const serialized = JSON.stringify(checkCredential(userKey, factsWith()));
    expect(serialized).not.toContain(userKey);
    expect(serialized).not.toContain(hashCredential(userKey));
  });
});

/**
 * 接线守卫：凭据面再扩时，自检不许再落下（形状 2 / 形状 7）。
 *
 * 这次的洞不是逻辑写错，是 `server.ts` 加了第五种凭据面而自检没跟上——两处
 * 各自成立、编译过、测试全绿，只有拿真凭据打一次生产才现形。所以判据不能停在
 * 「cdsu_ 现在认得出」，得钉住「server 认得的每一种前缀，自检都认得出」，
 * 否则下一种面照样漏。
 */
describe('credential-self-check：与鉴权路径的凭据面对齐', () => {
  it('server.ts 鉴权分支认得的每一种前缀，classifyCredential 都必须单独归类', () => {
    const serverSource = fs.readFileSync(
      path.join(process.cwd(), 'src', 'server.ts'),
      'utf-8',
    );
    const prefixes = Array.from(
      new Set(
        Array.from(serverSource.matchAll(/startsWith\('(cds[a-z]*_)'\)/g)).map((m) => m[1]),
      ),
    );
    // 前缀一个都没扫到 = 正则跟源码漂了，不能当成「全都对齐」放过去
    expect(prefixes.length).toBeGreaterThanOrEqual(3);
    expect(prefixes).toContain('cdsu_');

    const kinds = prefixes.map((p) => classifyCredential(p + 'x'.repeat(24)));
    // 'static' 是「认不出前缀时的兜底」，任何一种被 server 显式识别的前缀
    // 落到它上面，就说明自检漏了这一面
    expect(kinds).not.toContain('static');
    expect(kinds).not.toContain('unrecognized');
    // 且必须彼此可分辨，不能几种面共用一个结论
    expect(new Set(kinds).size).toBe(prefixes.length);
  });
});

/**
 * 自检必须认得「授权被撤」这一档（Codex P2）。
 *
 * 上一轮我让鉴权在授权被撤时拒掉一把没吊销、没过期的项目级凭据 —— 却没同步给
 * 自检这份事实。于是自检对着**它自己造成的那个 401** 回答「有效」，正是这个端点
 * 最不该给出的答案。同一个判断被拆在两处、只改了一处，是本仓库反复踩的形状。
 */
describe('credential-self-check：授权被撤要单独报出来', () => {
  const projectKey = 'cdsp_demo_' + crypto.randomBytes(18).toString('base64url');
  const iso = (d: number) => new Date(Date.now() + d * 86400_000).toISOString();

  const facts = (grants: Array<{ principalId: string; projectId: string; revokedAt?: string }>) => ({
    projects: [{
      id: 'p1', slug: 'demo', name: '演示项目',
      agentKeys: [{
        id: 'ak1', principalId: 'pr_a', hash: hashCredential(projectKey),
        createdAt: iso(-1), expiresAt: iso(20),
      }],
    }],
    principals: [{ id: 'pr_a', name: '某台机器', status: 'active' }],
    grants,
  });

  it('授权还在：active', () => {
    const r = checkCredential(projectKey, facts([{ principalId: 'pr_a', projectId: 'p1' }]));
    expect(r.status).toBe('active');
  });

  it('授权被撤：grant-revoked，而不是谎报 active', () => {
    const r = checkCredential(projectKey, facts([
      { principalId: 'pr_a', projectId: 'p1', revokedAt: iso(-1) },
    ]));
    expect(r.status).toBe('grant-revoked');
    expect(r.projectId).toBe('p1');
    // 下一步必须指向「重新批准」，而不是「重新签发」——换把钥匙照样进不来
    expect(r.nextStep).toContain('批准');
    expect(r.nextStep).toContain('重新签发也进不来');
  });

  it('压根没有授权行，也不是 active（自愈签出后授权被删的情形）', () => {
    const r = checkCredential(projectKey, facts([]));
    expect(r.status).toBe('grant-revoked');
  });

  it('存量密钥没有主体，不参与授权判定（零回归）', () => {
    const legacyKey = 'cdsp_demo_' + crypto.randomBytes(18).toString('base64url');
    const r = checkCredential(legacyKey, {
      projects: [{
        id: 'p1', slug: 'demo',
        agentKeys: [{ id: 'ak_legacy', hash: hashCredential(legacyKey), createdAt: iso(-400) }],
      }],
      principals: [],
      grants: [],
    });
    expect(r.status).toBe('active');
  });

  it('拿不到授权事实时不猜（旧实例 / 身份层未启用）', () => {
    const r = checkCredential(projectKey, {
      projects: facts([]).projects,
      principals: [{ id: 'pr_a', name: '某台机器', status: 'active' }],
    });
    expect(r.status).toBe('active');
  });
});
