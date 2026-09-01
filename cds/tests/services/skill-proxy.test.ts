/**
 * 技能代理 + 引导脚本守卫。
 *
 * 这条链是「帮别人从零建项目」的落地点：脚本装不上或装错层，整套方法论就落不了地。
 * 重点守三件容易悄悄坏掉的事：
 *   1. 回源失败时必须用缓存兜底并如实标记（客户现场网络最不可控）
 *   2. 脚本必须装到项目级技能目录（装到用户级的话，人一走团队什么都不剩）
 *   3. 脚本不得含密钥、不得改 shell profile / PATH / 用户主目录
 *
 * 详见 doc/design.cds.project-bootstrap.md。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SkillProxy,
  SkillProxyError,
  STARTER_SKILL_BUNDLES,
  isSafeSkillKey,
} from '../../src/services/skill-proxy.js';
import {
  BOOTSTRAP_PRESETS,
  CdsSkillPackCache,
  UpstreamSkillPackCache,
  __upstreamPackLimitsForTest,
  buildBootstrapScript,
  findPreset,
} from '../../src/routes/bootstrap.js';

/** 合法 zip 前缀（PK\x03\x04 本地文件头）+ 一个标记，用来分辨是哪一次回源的产物。 */
function zipBytes(marker: string): Buffer {
  return Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(marker)]);
}

function zipBody(marker: string): Response {
  return new Response(zipBytes(marker), { status: 200 });
}

describe('SkillProxy', () => {
  let cacheDir: string;

  beforeEach(() => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-proxy-'));
  });
  afterEach(() => {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  it('技能名只允许 kebab-case，挡住路径穿越', () => {
    expect(isSafeSkillKey('pm-starter')).toBe(true);
    expect(isSafeSkillKey('../../etc/passwd')).toBe(false);
    expect(isSafeSkillKey('Foo')).toBe(false);
    expect(isSafeSkillKey('a/b')).toBe(false);
  });

  it('首次回源成功并写缓存，二次命中缓存不再请求上游', async () => {
    let calls = 0;
    const proxy = new SkillProxy({
      mapBase: 'https://map.example.test',
      cacheDir,
      fetchImpl: async () => { calls += 1; return zipBody('fresh'); },
    });

    const first = await proxy.fetchSkill('pm-starter');
    expect(first.source).toBe('upstream');
    expect(first.stale).toBe(false);

    const second = await proxy.fetchSkill('pm-starter');
    expect(second.source).toBe('cache');
    expect(second.stale).toBe(false);
    expect(calls).toBe(1);
  });

  it('缓存过期且回源失败时返回陈旧副本并标记 stale', async () => {
    let calls = 0;
    let clock = 1_000_000;
    const proxy = new SkillProxy({
      mapBase: 'https://map.example.test',
      cacheDir,
      now: () => clock,
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) return zipBody('fresh');
        throw new Error('上游不可达');
      },
    });

    await proxy.fetchSkill('pm-starter');
    clock += 60 * 60 * 1000; // 推过 TTL

    const stale = await proxy.fetchSkill('pm-starter');
    // 装得上比装不上重要，但必须让用户知道用的是缓存版本
    expect(stale.stale).toBe(true);
    expect(stale.body.toString()).toContain('fresh');
  });

  it('无缓存且回源失败时明确报错，不静默降级', async () => {
    const proxy = new SkillProxy({
      mapBase: 'https://map.example.test',
      cacheDir,
      fetchImpl: async () => { throw new Error('上游不可达'); },
    });

    await expect(proxy.fetchSkill('pm-starter')).rejects.toBeInstanceOf(SkillProxyError);
    await proxy.fetchSkill('pm-starter').catch((e: SkillProxyError) => {
      expect(e.status).toBe(502);
      // 报错要说清「不是你的项目有问题」，否则非技术用户只会以为自己搞砸了
      expect(e.hint).toContain('不是你的项目有问题');
    });
  });

  it('上游返回空内容视为失败，不把空 zip 写进缓存', async () => {
    const proxy = new SkillProxy({
      mapBase: 'https://map.example.test',
      cacheDir,
      fetchImpl: async () => new Response(Buffer.alloc(0), { status: 200 }),
    });
    await expect(proxy.fetchSkill('pm-starter')).rejects.toBeInstanceOf(SkillProxyError);
    expect(fs.existsSync(path.join(cacheDir, 'pm-starter.zip'))).toBe(false);
  });

  it('上游 200 返回 HTML 错误页时不当成技能包，也不写进缓存', async () => {
    // 这是「失败被缓存住」的形态：非空、够长、状态 200，但根本不是 zip。
    // 一旦落缓存，客户侧 unzip 报错，且 MAP 恢复后仍要等缓存过期才自愈。
    let calls = 0;
    const proxy = new SkillProxy({
      mapBase: 'https://map.example.test',
      cacheDir,
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) {
          return new Response(Buffer.from('<html><body>502 Bad Gateway</body></html>'), { status: 200 });
        }
        return zipBody('recovered');
      },
    });

    await expect(proxy.fetchSkill('pm-starter')).rejects.toBeInstanceOf(SkillProxyError);
    expect(fs.existsSync(path.join(cacheDir, 'pm-starter.zip'))).toBe(false);

    // 上游恢复后立刻能拿到真包，不必等任何 TTL
    const ok = await proxy.fetchSkill('pm-starter');
    expect(ok.source).toBe('upstream');
    expect(ok.body.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  });

  it('磁盘上的坏缓存当作未命中，回源自愈而不是继续发错误页', async () => {
    // 校验是 2026-07-28 才加的，此前写进去的坏内容必须能自己走掉
    fs.writeFileSync(path.join(cacheDir, 'pm-starter.zip'), Buffer.from('<html>oops</html>'));

    const proxy = new SkillProxy({
      mapBase: 'https://map.example.test',
      cacheDir,
      fetchImpl: async () => zipBody('fresh'),
    });

    const got = await proxy.fetchSkill('pm-starter');
    expect(got.source).toBe('upstream');
    expect(got.stale).toBe(false);
  });

  it('CDS 本地携带的技能直接打包，不请求 MAP 中不存在的同名技能', async () => {
    const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'local-skills-'));
    fs.mkdirSync(path.join(localRoot, 'plan-first'), { recursive: true });
    fs.writeFileSync(path.join(localRoot, 'plan-first', 'SKILL.md'), '# plan-first\n');
    let calls = 0;
    const proxy = new SkillProxy({
      mapBase: 'https://map.example.test',
      cacheDir,
      localSkillRoots: [localRoot],
      fetchImpl: async () => { calls += 1; return new Response(null, { status: 404 }); },
    });

    try {
      const result = await proxy.fetchSkill('plan-first');
      expect(result.source).toBe('local');
      expect(result.stale).toBe(false);
      expect(result.body.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
      expect(result.body.toString('utf8')).toContain('plan-first/SKILL.md');
      expect(calls).toBe(0);
    } finally {
      fs.rmSync(localRoot, { recursive: true, force: true });
    }
  });

  it('来源自述如实数出本机自带的技能，剩下的算回源', async () => {
    // 上手助手的「技能来源」面板拿这两个数回答用户「我还能不能装」。
    // 数错了，用户会以为断网也能装上一个其实要回源的技能。
    const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'local-skills-'));
    for (const key of ['plan-first', 'scope-check']) {
      fs.mkdirSync(path.join(localRoot, key), { recursive: true });
      fs.writeFileSync(path.join(localRoot, key, 'SKILL.md'), `# ${key}\n`);
    }
    // 目录不存在的 key 不许被算成本机自带；同名的普通文件也不算。
    fs.writeFileSync(path.join(localRoot, 'human-verify'), 'not a directory');

    try {
      const proxy = new SkillProxy({ mapBase: '', cacheDir, localSkillRoots: [localRoot] });
      const { source } = await proxy.fetchBundles();
      expect(source.localSkillCount).toBe(2);
      expect(source.upstreamSkillCount).toBe(source.skillCount - 2);
      expect(source.upstreamConfigured).toBe(false);
    } finally {
      fs.rmSync(localRoot, { recursive: true, force: true });
    }
  });

  it('启动套件目录由 CDS 本地发布契约提供，不访问不存在的 MAP bundles 端点', async () => {
    let calls = 0;
    const proxy = new SkillProxy({
      mapBase: 'https://map.example.test',
      cacheDir,
      fetchImpl: async () => { calls += 1; throw new Error('不应访问上游'); },
    });

    const response = await proxy.fetchBundles();
    expect(response.bundles).toEqual(STARTER_SKILL_BUNDLES.bundles);
    const catalogSkills = STARTER_SKILL_BUNDLES.bundles.flatMap((bundle) => bundle.skills);
    // 来源自述要如实：这台实例没配 localSkillRoots，所以一个都不是本机自带的。
    expect(response.source).toEqual({
      kind: 'builtin',
      bundleCount: STARTER_SKILL_BUNDLES.bundles.length,
      skillCount: catalogSkills.length,
      localSkillCount: 0,
      upstreamSkillCount: catalogSkills.length,
      upstreamConfigured: true,
    });
    expect(STARTER_SKILL_BUNDLES.bundles.map((bundle) => bundle.key)).toEqual([
      'foundation', 'product', 'delivery', 'quality',
    ]);
    expect(catalogSkills.length).toBeGreaterThanOrEqual(22);
    expect(new Set(catalogSkills.map((skill) => skill.key)).size).toBe(catalogSkills.length);
    expect(catalogSkills.map((skill) => skill.key)).toEqual(expect.arrayContaining([
      'phase0-guard',
      'doc-writer',
      'product-document-generator',
      'conflict-resolution',
      'scope-check',
      'task-handoff-checklist',
      'human-verify',
      'code-hygiene',
      'create-skill-file',
      'acceptance-test-design',
      'create-visual-test-to-kb',
      'preview-url',
    ]));
    expect(calls).toBe(0);
  });

  it('目录中的每个技能都能从仓库本地打包，不把不存在的卡片交给用户', async () => {
    const repositorySkillRoot = fileURLToPath(new URL('../../../.claude/skills', import.meta.url));
    let calls = 0;
    const proxy = new SkillProxy({
      mapBase: 'https://map.example.test',
      cacheDir,
      localSkillRoots: [repositorySkillRoot],
      fetchImpl: async () => { calls += 1; return new Response(null, { status: 404 }); },
    });

    const catalogSkills = STARTER_SKILL_BUNDLES.bundles.flatMap((bundle) => bundle.skills);
    for (const skill of catalogSkills) {
      expect(fs.existsSync(path.join(repositorySkillRoot, skill.key, 'SKILL.md')), skill.key).toBe(true);
      const result = await proxy.fetchSkill(skill.key);
      expect(result.source, skill.key).toBe('local');
      expect(result.body.subarray(0, 4), skill.key).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    }
    expect(calls).toBe(0);
  });

  it('本地与 MAP 都不存在的技能返回准确 404，不伪装成上游 502', async () => {
    const proxy = new SkillProxy({
      mapBase: 'https://map.example.test',
      cacheDir,
      fetchImpl: async () => new Response(null, { status: 404 }),
    });

    await proxy.fetchSkill('missing-skill').catch((error: SkillProxyError) => {
      expect(error.status).toBe(404);
      expect(error.message).toBe('技能不存在');
    });
  });
});

describe('引导脚本', () => {
  const preset = findPreset('pm-project')!;
  const script = buildBootstrapScript(preset, 'https://cds.example.test/', 'https://cds.upstream.test');

  it('预设齐全且每个都给出下一步', () => {
    expect(BOOTSTRAP_PRESETS.length).toBeGreaterThan(0);
    for (const p of BOOTSTRAP_PRESETS) {
      expect(p.nextStep.trim().length).toBeGreaterThan(0);
      expect(p.key).toMatch(/^[a-z0-9-]+$/);
      expect(p.marketplaceKeys.every((key) => !key.endsWith('-starter'))).toBe(true);
    }
  });

  it('默认装到项目级技能目录，绝不写用户主目录', () => {
    // 三个宿主根目录都要遍历（目录名由 $h/skills 拼出，故断言宿主名而非拼好的路径）
    expect(script).toMatch(/for h in \.claude \.cursor \.agents/);
    expect(script).toContain('.agents/skills');   // 一个宿主都没有时的兜底
    // 装到 ~ 的话人一走团队什么都不剩
    expect(script).not.toContain('$HOME/.claude');
    expect(script).not.toContain('~/.claude');
  });

  it('装到所有存在的宿主，不是只装第一个命中的', () => {
    // 本仓库同时有 .claude 和 .agents：只装第一个的话，从 Codex 跑会装进
    // .claude/skills，而 Codex 只读 .agents/skills —— 装完了一个技能都看不见。
    expect(script).toMatch(/for _d in \$SKILLS_DIRS/);      // 安装函数遍历全部目录
    expect(script).not.toMatch(/elif \[ -d "?\.cursor/);     // 早期「取第一个」写法不许回潮
  });

  it('不含密钥，不改 shell profile / PATH', () => {
    // 只匹配独立且达到凭据长度的 sk- 前缀，不能把合法技能名 risk-matrix 的 `sk-m` 误报成 Key。
    expect(script).not.toMatch(/(?:^|[^a-z])sk-[a-zA-Z0-9-]{8,}/);
    expect(script).not.toMatch(/cdsp_|cdsg_/);
    expect(script).not.toContain('.bashrc');
    expect(script).not.toContain('.zshrc');
    expect(script).not.toMatch(/export PATH=/);
  });

  it('依赖自检一次扫完并给三种平台的安装命令', () => {
    expect(script).toContain('for cmd in curl unzip tar');
    expect(script).toContain('apt-get install');
    expect(script).toContain('yum install');
    expect(script).toContain('brew install');
  });

  it('CDS 技能包取不到时回退上游公共 CDS（自托管场景）', () => {
    expect(script).toContain('for base in "$CDS_ORIGIN" "$CDS_UPSTREAM"');
    expect(script).toContain('https://cds.upstream.test');
  });

  it('装不全时如实报出未安装项，不假装成功', () => {
    expect(script).toContain('未安装');
    expect(script).toContain('安装未完成');
    expect(script).toContain('缺了功能不完整');
    // 光打 warning 还 exit 0 等于骗调用方：必须以非零码退出（行为断言见
    // skill-install-contract.test.ts「引导脚本的退出码语义」）
    expect(script).toMatch(/未安装:\$skipped[\s\S]{0,400}exit 1/);
  });

  it('结尾明确给出下一句该说什么', () => {
    expect(script).toContain(preset.nextStep);
    expect(script).toContain('下一步');
  });

  it('CDS 地址做单引号转义，防脚本注入', () => {
    const injected = buildBootstrapScript(preset, "https://evil.test'; rm -rf /; echo '", 'https://cds.upstream.test');
    expect(injected).not.toContain("rm -rf /; echo ''");
    expect(injected).toContain("'\\''");
  });
});

describe('CDS 技能包缓存（匿名端点的放大防护）', () => {
  let root: string;

  const mkSkill = (base: string, key: string): void => {
    fs.mkdirSync(path.join(base, key), { recursive: true });
    fs.writeFileSync(path.join(base, key, 'SKILL.md'), `# ${key}\n`);
  };
  const ALL = ['cds', 'cds-project-scan', 'cds-deploy-pipeline', 'cds-release', 'preview-url'];

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-skills-root-'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('技能不齐时拒发本地包（半成品会让脚本以为装好了、不再回源）', async () => {
    for (const k of ALL.slice(0, 3)) mkSkill(root, k);
    const cache = new CdsSkillPackCache();
    expect(await cache.get(root)).toBeNull();
  });

  it('五个齐全时出包，第二次命中缓存不再重新构建', async () => {
    for (const k of ALL) mkSkill(root, k);
    const cache = new CdsSkillPackCache();
    const first = await cache.get(root);
    expect(first?.cached).toBe(false);
    expect((first?.body.byteLength ?? 0)).toBeGreaterThan(0);

    const second = await cache.get(root);
    expect(second?.cached).toBe(true);
    expect(second?.body).toBe(first?.body);
  });

  it('并发请求共享同一次构建（单飞），不会各 spawn 一个 tar', async () => {
    for (const k of ALL) mkSkill(root, k);
    const cache = new CdsSkillPackCache();
    const results = await Promise.all([cache.get(root), cache.get(root), cache.get(root)]);
    const bodies = results.map((r) => r?.body);
    expect(bodies[0]).toBe(bodies[1]);
    expect(bodies[1]).toBe(bodies[2]);
  });

  it('技能内容变了缓存失效，重新构建', async () => {
    for (const k of ALL) mkSkill(root, k);
    const cache = new CdsSkillPackCache();
    const first = await cache.get(root);
    fs.writeFileSync(path.join(root, 'cds', 'NEW.md'), 'changed\n');
    const second = await cache.get(root);
    expect(second?.cached).toBe(false);
    expect(second?.body).not.toBe(first?.body);
  });
});

describe('上游 CDS 技能包回源（自托管无本地技能树时的唯一来源）', () => {
  const url = 'https://up.test/api/skills/cds-pack/download';
  // 技能包是 .tar.gz，所以要带上 gzip 魔数，否则会被「不是 tar.gz」的校验挡下
  const okResponse = (bytes: number): Response =>
    new Response(
      Buffer.concat([Buffer.from([0x1f, 0x8b]), Buffer.alloc(Math.max(0, bytes - 2), 1)]),
      { status: 200 },
    );

  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('第二次命中缓存，不再打上游', async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls += 1; return okResponse(1024); }) as typeof globalThis.fetch;

    const cache = new UpstreamSkillPackCache();
    const first = await cache.get(url);
    const second = await cache.get(url);

    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(calls).toBe(1);
  });

  it('并发请求共享同一次回源（单飞）', async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls += 1; return okResponse(1024); }) as typeof globalThis.fetch;

    const cache = new UpstreamSkillPackCache();
    const results = await Promise.all([cache.get(url), cache.get(url), cache.get(url)]);

    expect(calls).toBe(1);
    expect(results[0].body).toBe(results[1].body);
  });

  it('上游响应超过体积上限时中止，不把堆吃干净', async () => {
    globalThis.fetch = (async () =>
      okResponse(__upstreamPackLimitsForTest.maxBytes + 1)) as typeof globalThis.fetch;

    const cache = new UpstreamSkillPackCache();
    await expect(cache.get(url)).rejects.toThrow(/上限/);
  });

  it('回源带超时，不会无限期挂住连接', async () => {
    let sawSignal = false;
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
      sawSignal = init?.signal instanceof AbortSignal;
      return okResponse(16);
    }) as typeof globalThis.fetch;

    await new UpstreamSkillPackCache().get(url);
    expect(sawSignal).toBe(true);
    expect(__upstreamPackLimitsForTest.timeoutMs).toBeGreaterThan(0);
  });

  it('上游 200 返回 HTML 错误页时不缓存，恢复后立刻自愈', async () => {
    // 与 SkillProxy 同源的坑：不校验就会把错误页缓存成技能包，上游恢复也得等 TTL
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) return new Response(Buffer.from('<html>502</html>'), { status: 200 });
      return okResponse(64);
    }) as typeof globalThis.fetch;

    const cache = new UpstreamSkillPackCache();
    await expect(cache.get(url)).rejects.toThrow(/tar\.gz/);

    const ok = await cache.get(url);
    expect(ok.cached).toBe(false);
    expect(ok.body.subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));
  });

  it('时钟回拨不会让缓存永不失效', async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls += 1; return okResponse(64); }) as typeof globalThis.fetch;

    // 第一次写入时刻很晚，之后时钟回拨 -> 龄期为负，必须当成过期而不是新鲜
    const clock = [10_000_000, 0, 0];
    let i = 0;
    const cache = new UpstreamSkillPackCache(() => clock[Math.min(i++, clock.length - 1)]);
    await cache.get(url);
    const second = await cache.get(url);

    expect(second.cached).toBe(false);
    expect(calls).toBe(2);
  });
});

describe('技能包回源的边界保护（匿名路径，无全局限流）', () => {
  let cacheDir: string;
  beforeEach(() => { cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-proxy-bound-')); });
  afterEach(() => { fs.rmSync(cacheDir, { recursive: true, force: true }); });

  const proxyWith = (fetchImpl: typeof fetch): SkillProxy =>
    new SkillProxy({ mapBase: 'https://map.test', cacheDir, fetchImpl });

  // 技能包是 zip，body 必须带 PK 魔数，否则会被「不是 zip」的校验挡下
  const zipOf = (bytes: number): Buffer =>
    Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(Math.max(0, bytes - 4), 7)]);

  it('同一 key 的并发回源合并成一次（单飞）', async () => {
    let calls = 0;
    const proxy = proxyWith((async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 20));
      return new Response(zipOf(512), { status: 200 });
    }) as typeof fetch);

    const all = await Promise.all([
      proxy.fetchSkill('pm-starter'),
      proxy.fetchSkill('pm-starter'),
      proxy.fetchSkill('pm-starter'),
    ]);

    expect(calls).toBe(1);
    expect(all.every((r) => r.body.byteLength === 512)).toBe(true);
  });

  it('不同 key 各自回源，不会被单飞串起来', async () => {
    let calls = 0;
    const proxy = proxyWith((async () => {
      calls += 1;
      return new Response(zipOf(64), { status: 200 });
    }) as typeof fetch);

    await Promise.all([proxy.fetchSkill('pm-starter'), proxy.fetchSkill('dev-starter')]);
    expect(calls).toBe(2);
  });

  it('回源带超时信号，不会无限期挂住连接', async () => {
    let sawSignal = false;
    const proxy = proxyWith((async (_u: unknown, init?: RequestInit) => {
      sawSignal = init?.signal instanceof AbortSignal;
      return new Response(zipOf(32), { status: 200 });
    }) as typeof fetch);

    await proxy.fetchSkill('pm-starter');
    expect(sawSignal).toBe(true);
  });

  it('超限在流式读取中中止，而不是先把整个响应缓冲进堆', async () => {
    // 用一个「永远吐数据」的流：如果实现是先 arrayBuffer 再判大小，这里会一直吃内存；
    // 正确实现应在累计超过上限时立刻 cancel 并抛错。
    let pushed = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pushed += 1;
        controller.enqueue(new Uint8Array(1024 * 1024));
        if (pushed > 200) controller.close();
      },
    });
    const proxy = proxyWith((async () =>
      new Response(endless, { status: 200 })) as typeof fetch);

    await expect(proxy.fetchSkill('pm-starter')).rejects.toThrow();
    // 128 MB 上限之内就该中止，不会把 200 MB 全读完
    expect(pushed).toBeLessThanOrEqual(70);
  });
});
