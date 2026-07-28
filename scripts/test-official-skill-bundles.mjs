#!/usr/bin/env node
// 角色套装端到端自测：把后端 zip 组装逻辑在 Node 里等价重放一遍，
// 验证「别人下载解压之后到底能不能用」，而不是只验证 JSON 长得对。
//
// 为什么需要这个：C# 侧的组装逻辑（ExpandWithRequires + PackSkills）依赖
// official-skills.generated.json 的内容。生成物一旦缺技能 / 依赖悬空 / key 撞车，
// 编译是过的，用户下载下来才发现是残包。本脚本在提交期就把这条链跑穿。
//
// 运行：node scripts/test-official-skill-bundles.mjs
// 退出码：0 全绿；1 有断言失败（CI 应当据此 fail）

import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG = join(ROOT, 'prd-api', 'src', 'PrdAgent.Api', 'OfficialSkills', 'official-skills.generated.json');
const BUNDLES_FILE = join(ROOT, 'scripts', 'skill-bundles.json');

let failed = 0;
const ok = (msg) => console.log(`  PASS  ${msg}`);
const bad = (msg) => { failed++; console.error(`  FAIL  ${msg}`); };
const assert = (cond, msg) => (cond ? ok(msg) : bad(msg));

// ── 1. 生成物必须是最新的（防止改了 skill-bundles.json 忘记重跑打包脚本）────
console.log('[1] 生成物新鲜度');
const before = existsSync(CATALOG) ? readFileSync(CATALOG, 'utf8') : '';
execFileSync('node', [join(ROOT, 'scripts', 'bundle-official-skills.mjs')], { cwd: ROOT, stdio: 'pipe' });
const after = readFileSync(CATALOG, 'utf8');
const stripGeneratedAt = (s) => s.replace(/"generatedAt":\s*"[^"]*",?/g, '');
assert(
  stripGeneratedAt(before) === stripGeneratedAt(after),
  '已提交的 official-skills.generated.json 与源技能一致（不一致请重跑 node scripts/bundle-official-skills.mjs 并提交）',
);

const catalog = JSON.parse(after);

// ── 2. schema 与角色完整性 ───────────────────────────────────────────────
console.log('[2] schema 与角色');
assert(catalog.version === 3, `catalog schema 版本为 3（实际 ${catalog.version}）`);
assert(Object.keys(catalog.roleLabels || {}).length > 0, '有角色标签定义');
assert(Array.isArray(catalog.bundles) && catalog.bundles.length > 0, `至少一个角色套装（实际 ${catalog.bundles?.length ?? 0}）`);

const skillByKey = new Map(catalog.skills.map((s) => [s.key, s]));
const bundleKeys = new Set(catalog.bundles.map((b) => b.key));
const collide = [...bundleKeys].filter((k) => skillByKey.has(k));
assert(collide.length === 0, `套装 key 不与技能 key 相撞${collide.length ? `（撞了：${collide.join(', ')}）` : ''}`);

for (const s of catalog.skills) {
  for (const r of s.requires || []) {
    if (!skillByKey.has(r)) bad(`技能 ${s.key} 的依赖 ${r} 不在目录里（下载会 500）`);
  }
}
ok('技能依赖无悬空');

// ── 3. 等价重放后端 ExpandWithRequires ───────────────────────────────────
console.log('[3] 依赖递归展开');
function expand(keys) {
  const out = [];
  const seen = new Set();
  const visit = (k) => {
    if (seen.has(k)) return;
    seen.add(k);
    const e = skillByKey.get(k);
    if (!e) { bad(`展开时找不到技能 ${k}`); return; }
    out.push(e);
    for (const d of e.requires || []) visit(d);
  };
  keys.forEach(visit);
  return out;
}

// 单技能下载也要带上依赖：create-visual-test-to-kb 是已知的多依赖用例
const cvt = expand(['create-visual-test-to-kb']).map((e) => e.key);
assert(
  cvt.includes('acceptance-test-design') && cvt.includes('acceptance-scenario-orchestrator'),
  `下载 create-visual-test-to-kb 自动带上 2 个依赖（实际带上 ${cvt.length} 个：${cvt.join(', ')}）`,
);

// ── 4. 真正解压一份到临时目录，验证「装完能不能用」──────────────────────
console.log('[4] 模拟解压安装');
const workdir = mkdtempSync(join(tmpdir(), 'skill-bundle-test-'));
try {
  for (const bundle of catalog.bundles) {
    const entries = expand(bundle.includes);
    const dest = join(workdir, bundle.key);

    // 等价于后端 PackSkills：每个技能落在 {key}/ 下，解压即 ~/.claude/skills/{key}/
    for (const e of entries) {
      for (const f of e.files) {
        const target = join(dest, e.key, f.path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, f.content, 'utf8');
      }
    }
    writeFileSync(join(dest, 'INSTALL.md'), `# ${bundle.title}\n`, 'utf8');
    writeFileSync(join(dest, 'bundle.manifest.json'), JSON.stringify({ key: bundle.key }), 'utf8');

    // 4a. 每个技能目录都在，且有 SKILL.md —— 没有 SKILL.md 的目录 Claude Code 不认
    let missingSkillMd = [];
    for (const e of entries) {
      const p = join(dest, e.key, 'SKILL.md');
      if (!existsSync(p)) missingSkillMd.push(e.key);
    }
    assert(missingSkillMd.length === 0, `[${bundle.key}] ${entries.length} 个技能目录都有 SKILL.md${missingSkillMd.length ? `（缺：${missingSkillMd.join(', ')}）` : ''}`);

    // 4b. frontmatter 的 name 必须等于目录名，否则 harness 认不出技能
    const nameMismatch = [];
    for (const e of entries) {
      const md = readFileSync(join(dest, e.key, 'SKILL.md'), 'utf8');
      const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      const nameLine = m?.[1]?.match(/^name:\s*(.+?)\s*$/m)?.[1]?.replace(/^["']|["']$/g, '');
      if (nameLine !== e.key) nameMismatch.push(`${e.key}(name=${nameLine ?? '缺失'})`);
    }
    assert(nameMismatch.length === 0, `[${bundle.key}] 所有 SKILL.md 的 frontmatter name 等于目录名${nameMismatch.length ? `（不符：${nameMismatch.join(', ')}）` : ''}`);

    // 4c. 禁 emoji（CLAUDE.md 规则 0）—— 对外分发的内容尤其不能夹带
    const emoji = /[\u{1F000}-\u{1FAFF}\u{2700}-\u{27BF}\u{2600}-\u{26FF}]/u;
    const dirty = [];
    const walk = (d) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) { walk(p); continue; }
        // 脚本文件同样是对外分发内容：控制台输出里的 emoji 一样会落到客户屏幕上
        if (!/\.(md|txt|json|ya?ml|mjs|js|ts|py|sh)$/i.test(n)) continue;
        if (emoji.test(readFileSync(p, 'utf8'))) dirty.push(p.slice(dest.length + 1));
      }
    };
    walk(dest);
    assert(dirty.length === 0, `[${bundle.key}] 分发内容无 emoji${dirty.length ? `（命中：${dirty.slice(0, 5).join(', ')}）` : ''}`);

    // 4c-2. 对外展示的简介必须是中文：这段直接进市场卡片、CDS 市场栏、
    // INSTALL.md 和 sdd-init 生成的规则文件，给中文非技术用户看英文等于没写。
    const english = entries.filter((e) => {
      const d = (e.description || '').slice(0, 60);
      const en = (d.match(/[A-Za-z]/g) || []).length;
      const cn = (d.match(/[\u4e00-\u9fff]/g) || []).length;
      return en > cn * 2;
    }).map((e) => e.key);
    assert(english.length === 0, `[${bundle.key}] 对外简介均为中文${english.length ? `（仍是英文：${english.join(', ')}，请在 bundle-official-skills.mjs 的 DISPLAY_SUMMARY 补一行）` : ''}`);

    // 4d. 入口技能必须在（套装的价值全靠它把零件串起来）
    assert(
      entries.some((e) => e.key === 'sdd-init'),
      `[${bundle.key}] 含入口技能 sdd-init`,
    );

    console.log(`        ${bundle.key}: ${entries.length} 个技能, ${entries.reduce((n, e) => n + e.files.length, 0)} 个文件`);
  }
} finally {
  rmSync(workdir, { recursive: true, force: true });
}

// ── 5. 配置校验真的会拦住错误（负向用例）──────────────────────────────────
// ── 4d. 全目录禁 emoji ────────────────────────────────────────────────────
// 只扫套装成员是不够的：不在任何套装里的技能（如 ui-ux-pro-max）照样能被
// OfficialSkillsController 单独下载。守卫的覆盖面必须等于「API 实际分发的一切」，
// 否则就是靠缩小扫描范围来让自己变绿。
console.log('[4d] 全目录禁 emoji（覆盖单独分发的技能）');
{
  const emoji = /[\u{1F000}-\u{1FAFF}\u{2700}-\u{27BF}\u{2600}-\u{26FF}]/u;
  const scannable = /\.(md|txt|json|ya?ml|mjs|js|ts|py|sh)$/i;


  const dirty = [];
  let scanned = 0;
  for (const skill of catalog.skills) {
    for (const f of skill.files) {
      if (!scannable.test(f.path)) continue;
      scanned += 1;
      if (emoji.test(f.content)) dirty.push(`${skill.key}/${f.path}`);
    }
  }
  // 没有豁免清单。规则 0 对分发内容是绝对的 —— 留口子等于把「守卫」变成
  // 「守卫我记得扫的那部分」。vendored 的第三方技能同样要清干净再分发。
  assert(
    dirty.length === 0,
    `全部 ${catalog.skills.length} 个可分发技能（${scanned} 个文件）无 emoji` +
      (dirty.length ? `（命中：${dirty.slice(0, 5).join(', ')}）` : ''),
  );
}

console.log('[5] 配置校验负向用例');
const original = readFileSync(BUNDLES_FILE, 'utf8');
const cases = [
  ['引用不存在的技能', (c) => { c.bundles[0].includes.push('this-skill-does-not-exist'); }],
  ['套装 key 与技能同名', (c) => { c.bundles[0].key = 'plan-first'; }],
  ['引用未定义的角色', (c) => { c.bundles[0].roles = ['nonexistent-role']; }],
];
try {
  for (const [label, mutate] of cases) {
    const cfg = JSON.parse(original);
    mutate(cfg);
    writeFileSync(BUNDLES_FILE, JSON.stringify(cfg, null, 2), 'utf8');
    let exitCode = 0;
    try {
      execFileSync('node', [join(ROOT, 'scripts', 'bundle-official-skills.mjs')], { cwd: ROOT, stdio: 'pipe' });
    } catch (e) {
      exitCode = e.status ?? 1;
    }
    assert(exitCode !== 0, `打包脚本拦住「${label}」`);
  }
} finally {
  writeFileSync(BUNDLES_FILE, original, 'utf8');
  // 恢复正确配置并重新生成，确保本脚本不留下脏生成物
  execFileSync('node', [join(ROOT, 'scripts', 'bundle-official-skills.mjs')], { cwd: ROOT, stdio: 'pipe' });
}

console.log();
if (failed > 0) {
  console.error(`[test-official-skill-bundles] ${failed} 项失败`);
  process.exit(1);
}
console.log('[test-official-skill-bundles] 全部通过');
