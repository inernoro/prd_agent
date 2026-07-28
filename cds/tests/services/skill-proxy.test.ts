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

import { SkillProxy, SkillProxyError, isSafeSkillKey } from '../../src/services/skill-proxy.js';
import { BOOTSTRAP_PRESETS, CdsSkillPackCache, buildBootstrapScript, findPreset } from '../../src/routes/bootstrap.js';

function zipBody(marker: string): Response {
  return new Response(Buffer.from(`PK-${marker}`), { status: 200 });
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
});

describe('引导脚本', () => {
  const preset = findPreset('pm-project')!;
  const script = buildBootstrapScript(preset, 'https://cds.example.test/', 'https://cds.upstream.test');

  it('预设齐全且每个都给出下一步', () => {
    expect(BOOTSTRAP_PRESETS.length).toBeGreaterThan(0);
    for (const p of BOOTSTRAP_PRESETS) {
      expect(p.nextStep.trim().length).toBeGreaterThan(0);
      expect(p.key).toMatch(/^[a-z0-9-]+$/);
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
    expect(script).not.toMatch(/sk-[a-zA-Z0-9]/);
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
