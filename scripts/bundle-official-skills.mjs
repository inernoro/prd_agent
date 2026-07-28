#!/usr/bin/env node
// 把 .claude/skills/*/SKILL.md 打包成「官方技能目录」JSON，供后端虚拟注入到海鲜市场。
//
// 为什么是提交期生成、把产物放进 prd-api：
//   prd-api 的 Docker 构建上下文只有 prd-api/ 目录，仓库根的 .claude/skills/
//   不会进容器。所以在本地（能看到 .claude/skills）生成 JSON，写进
//   prd-api/src/PrdAgent.Api/OfficialSkills/，作为 EmbeddedResource 随 API 编译进镜像。
//
// 运行：node scripts/bundle-official-skills.mjs
// 产物：prd-api/src/PrdAgent.Api/OfficialSkills/official-skills.generated.json
//
// 技能内容有变 / 新增技能 / 改角色套装（scripts/skill-bundles.json）时重跑本脚本并提交产物。
//
// 产物 schema v3：
//   { version, generatedAt, count, roleLabels, skills[], bundles[] }
//   skills[i]  += roles[]（角色归属，市场按角色筛选）、requires[]（硬依赖，下载时自动带上）
//   bundles[]   角色套装：一条 curl 装齐一个角色的全部技能（key/title/roles/includes/...）
// 角色与套装的事实源是 scripts/skill-bundles.json，本脚本只做校验 + 合并。

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SKILLS_DIR = join(ROOT, '.claude', 'skills');
const BUNDLES_FILE = join(ROOT, 'scripts', 'skill-bundles.json');
const OUT_FILE = join(ROOT, 'prd-api', 'src', 'PrdAgent.Api', 'OfficialSkills', 'official-skills.generated.json');

// 单文件上限（超大文本截断防 JSON 爆）
const MAX_FILE_BYTES = 96 * 1024;
// 只打包文本文件（其余跳过；技能目前全是文本）
const TEXT_EXT = new Set(['.md', '.markdown', '.txt', '.py', '.csv', '.json', '.yml', '.yaml', '.sh', '.ts', '.tsx', '.js', '.mjs', '.gitignore']);

// ── 精选 INCLUDE 白名单（用户敲定：只放真正可移植、外部用户能跑的技能）─────────
// 不在表里的不进市场（文件保留，Claude Code 仍用）。新增可对外技能往这里加 key。
// 排除原则：绑死本仓库基础设施（CDS/cdscli/本平台 API/本仓库开发流程）的一律不放。
// 注：findmapskills 不在此列 —— 它由 OfficialSkillTemplates 特殊处理（版本号 +
// {{BASE_URL}} 占位替换），catalog 只管其余可移植技能，避免重复/降低改动风险。
const INCLUDE = new Set([
  'sdd-init',                // 骨架落地：把套装变成一套能用的工作方法（角色套装的入口技能）
  'plan-first',              // 通用先方案后动手
  'product-document-generator', // 通用产品文档生成
  'doc-writer',              // 通用七类文档模板
  'flow-trace',              // 通用端到端链路追踪（大白话版）
  'laowang',                 // 精英·米多文化人格
  'ui-ux-pro-max',           // 通用 UI/UX 设计智能
  'risk-matrix',             // 通用风险评估
  'skill-validation',        // 通用需求验证
  'human-verify',            // 通用代码人工审查方法论
  'theme-transition',        // 通用前端主题切换动效
  'remotion-scene-codegen',  // 通用 Remotion 视频场景生成
  'create-skill-file',       // 通用 SKILL.md 创建
  'find-skills',             // 通用技能发现
  'code-hygiene',            // 通用代码卫生方法论
  'conflict-resolution',     // 通用 git 冲突解决
  'acceptance-test-design',  // 通用验收测试设计
  'acceptance-scenario-orchestrator', // 通用验收场景编排
  'acceptance-checklist',    // 通用 UAT 清单
  'create-visual-test-to-kb',// 通用视觉验收取证 + 报告归档
  'task-handoff-checklist',  // 通用交接清单
]);

// 友好显示名（key → 中文备注名）。缺省用 frontmatter name（多为英文 key）。
// 卡片标题展示这个，像 findmapskills 那样「英文 · 中文一句话」。
const DISPLAY_NAME = {
  'acceptance-checklist': 'acceptance-checklist · 真人验收清单',
  'acceptance-scenario-orchestrator': 'acceptance-scenario-orchestrator · 验收场景编排',
  'acceptance-test-design': 'acceptance-test-design · 验收测试设计',
  'code-hygiene': 'code-hygiene · 代码卫生体检',
  'conflict-resolution': 'conflict-resolution · Git 冲突解决',
  'create-skill-file': 'create-skill-file · 技能文件生成',
  'create-visual-test-to-kb': 'create-visual-test-to-kb · 视觉验收归档',
  'doc-writer': 'doc-writer · 七类文档模板',
  'find-skills': 'find-skills · 技能发现',
  'flow-trace': 'flow-trace · 端到端链路追踪',
  'human-verify': 'human-verify · 多视角人工验证',
  'laowang': '老王 · 米多解决问题五步法',
  'plan-first': 'plan-first · 先方案后动手',
  'product-document-generator': 'product-document-generator · 产品文档生成',
  'remotion-scene-codegen': 'remotion-scene-codegen · 视频场景代码生成',
  'risk-matrix': 'risk-matrix · MECE 风险评估',
  'sdd-init': 'sdd-init · 项目骨架落地',
  'skill-validation': 'skill-validation · 需求七维度评分',
  'task-handoff-checklist': 'task-handoff-checklist · 任务交接清单',
  'theme-transition': 'theme-transition · 主题切换水波纹动效',
  'ui-ux-pro-max': 'UI/UX Pro Max · 设计智能',
};

// ── tag 分类启发式 ────────────────────────────────────────────────────────
// 与 prd-admin/src/lib/skillGlyphRegistry.ts 的 TAG_STYLE_GROUPS 对齐：
//   工程/工具/运维 → 罗盘   创意/内容/设计 → 植物   分析/数据/报告 → 星图   精英 → 金色徽章
// 策略（用户敲定）：分不准就只打「一个」主标签（取首个命中的规则）；个别用 OVERRIDE 手工指定。
const TAG_RULES = [
  { tag: '部署', kw: ['deploy', 'cds', '部署', '灰度', '容器', 'docker', 'pipeline', '发版', 'release', 'executor', '执行器'] },
  { tag: '创意', kw: ['创意', '设计', 'ui', 'ux', '视觉', 'image', 'remotion', '视频', 'video', '涌现', 'emerge', '主题', 'theme', 'demo', '生图'] },
  { tag: '分析', kw: ['分析', '评审', 'review', 'verify', '验证', '验收', 'trace', '追踪', 'risk', '风险', 'visibility', '审查', '台账', 'ledger', '巡检', 'audit', '诊断', 'debug'] },
  { tag: '周报', kw: ['周报', 'weekly', 'report', '报告', '总结', 'summary'] },
  { tag: '文档', kw: ['文档', 'doc', 'documentation', '写作', 'readme'] },
  { tag: '需求', kw: ['需求', 'validate', 'prd', '方案', 'plan', '规划'] },
  { tag: '技能', kw: ['skill', '技能', 'marketplace', '海鲜市场', 'findmap'] },
  { tag: '运维', kw: ['运维', 'issue', '修复', 'fix', 'autofix', '熵', 'entropy', '环境', 'setup', '权限'] },
];

// 手工覆盖：key → tags（命中即用，跳过启发式）。允许多标签。
const TAG_OVERRIDE = {
  laowang: ['精英'],
  findmapskills: ['技能', '精英'],
  'acceptance-test-design': ['分析'],
  'acceptance-scenario-orchestrator': ['分析'],
  // 下面 5 条是修启发式误判（曾把 conflict-resolution 标成「周报」、risk-matrix 标成「部署」）
  'conflict-resolution': ['工具'],
  'risk-matrix': ['分析'],
  'acceptance-checklist': ['分析'],
  'create-visual-test-to-kb': ['分析'],
  'skill-validation': ['需求'],
  'sdd-init': ['需求', '精英'],
  'plan-first': ['需求'],
  'product-document-generator': ['文档'],
  'doc-writer': ['文档'],
  'flow-trace': ['分析'],
  'feature-emerge': ['创意'],
  'release-version': ['部署'],
  bridge: ['工具'],
  cds: ['部署'],
  'ui-ux-pro-max': ['创意'],
};

// 不可移植文件排除：官方包面向外部用户，不能夹带绑定本仓库数据/第三方 URL 的临时取证 driver。
const EXCLUDE_FILES_BY_SKILL = {
  'create-visual-test-to-kb': new Set([
    'scripts/sv-card-view.mjs',
    'scripts/sv-driver.mjs',
    'scripts/sv-video-check.mjs',
  ]),
};

// 递归收集技能目录下的全部文本文件（用于打包完整 zip，而非只 SKILL.md）
function collectFiles(skillDir, skillKey) {
  const out = [];
  const excluded = EXCLUDE_FILES_BY_SKILL[skillKey] || new Set();
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) { walk(full); continue; }
      const rel = relative(skillDir, full).split('\\').join('/');
      if (excluded.has(rel)) continue;
      const dot = name.lastIndexOf('.');
      const ext = dot === -1 ? '' : name.slice(dot).toLowerCase();
      // .gitignore 这种无扩展名特殊处理
      const isText = TEXT_EXT.has(ext) || name === '.gitignore';
      if (!isText) continue;
      let content = readFileSync(full, 'utf8');
      let truncated = false;
      if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) {
        content = content.slice(0, MAX_FILE_BYTES) + '\n\n…(已截断，完整版见仓库)';
        truncated = true;
      }
      out.push({ path: rel, content, truncated });
    }
  };
  walk(skillDir);
  // SKILL.md 排最前，其余字母序
  out.sort((a, b) => (a.path === 'SKILL.md' ? -1 : b.path === 'SKILL.md' ? 1 : a.path.localeCompare(b.path)));
  return out;
}

function parseFrontmatter(md) {
  // 取首个 --- ... --- 块里的 name / version / description（description 可能是多行 > 折叠）
  const lines = md.split('\n');
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  if (lines[i]?.trim() !== '---') return { name: null, version: null, description: null };
  i++;
  let name = null;
  let version = null;
  let description = null;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '---') break;
    const mName = line.match(/^name:\s*(.+?)\s*$/);
    if (mName && !name) { name = mName[1].replace(/^["']|["']$/g, ''); continue; }
    const mVersion = line.match(/^version:\s*(.+?)\s*$/);
    if (mVersion && !version) { version = mVersion[1].replace(/^["']|["']$/g, ''); continue; }
    const mDesc = line.match(/^description:\s*(.*)$/);
    if (mDesc && description === null) {
      let val = mDesc[1].trim();
      if (val === '>' || val === '|' || val === '>-' || val === '|-') {
        // 折叠标量：收集后续缩进行
        const buf = [];
        for (let j = i + 1; j < lines.length; j++) {
          if (lines[j].trim() === '---') break;
          if (/^\s+\S/.test(lines[j]) || lines[j].trim() === '') buf.push(lines[j].trim());
          else break;
        }
        val = buf.join(' ').trim();
      } else {
        val = val.replace(/^["']|["']$/g, '');
      }
      description = val;
    }
  }
  return { name, version, description };
}

function deriveTags(key, name, description) {
  if (TAG_OVERRIDE[key]) return TAG_OVERRIDE[key];
  const hay = `${key} ${name ?? ''} ${description ?? ''}`.toLowerCase();
  // 分不准就只打一个：取首个命中的规则（TAG_RULES 顺序即优先级）
  for (const rule of TAG_RULES) {
    if (rule.kw.some((k) => hay.includes(k))) return [rule.tag];
  }
  return ['工具'];
}

function shortDesc(description, fallbackName) {
  if (!description) return `官方技能 · ${fallbackName}`;
  const oneLine = description.replace(/\s+/g, ' ').trim();
  return oneLine.length > 200 ? oneLine.slice(0, 197) + '…' : oneLine;
}

/**
 * 读取角色/套装事实源，并对齐技能白名单做强校验。
 * 校验失败直接 exit(1) —— 生成物是要编进镜像的，宁可现在红，不要上线后 404。
 */
function loadBundleConfig(skillKeys) {
  if (!existsSync(BUNDLES_FILE)) {
    console.warn(`[bundle-official-skills] 警告：找不到 ${BUNDLES_FILE}，本次不产出角色与套装`);
    return { roleLabels: {}, skillRoles: {}, skillRequires: {}, bundles: [] };
  }
  const cfg = JSON.parse(readFileSync(BUNDLES_FILE, 'utf8'));
  const roleLabels = cfg.roleLabels || {};
  const skillRoles = cfg.skillRoles || {};
  const skillRequires = cfg.skillRequires || {};
  const bundles = cfg.bundles || [];
  const known = new Set(skillKeys);
  const errors = [];

  const checkRoles = (roles, where) => {
    for (const r of roles || []) {
      if (!roleLabels[r]) errors.push(`${where} 引用了未定义的角色 "${r}"（请在 roleLabels 补一行）`);
    }
  };

  for (const [key, roles] of Object.entries(skillRoles)) {
    if (!known.has(key)) errors.push(`skillRoles 引用了未上架的技能 "${key}"（不在 INCLUDE 白名单或目录不存在）`);
    checkRoles(roles, `skillRoles["${key}"]`);
  }
  for (const [key, reqs] of Object.entries(skillRequires)) {
    if (!known.has(key)) errors.push(`skillRequires 引用了未上架的技能 "${key}"`);
    for (const r of reqs) {
      if (!known.has(r)) errors.push(`skillRequires["${key}"] 依赖了未上架的技能 "${r}"`);
      if (r === key) errors.push(`skillRequires["${key}"] 依赖了自己`);
    }
  }

  const bundleKeys = new Set();
  for (const b of bundles) {
    if (!b.key) { errors.push('bundles 里有条目缺 key'); continue; }
    // 套装 key 与技能 key 共用 official-{key} 命名空间，撞了会让下载路由指错东西
    if (known.has(b.key)) errors.push(`套装 key "${b.key}" 与技能同名，会撞 official-{key} 下载路径`);
    if (bundleKeys.has(b.key)) errors.push(`套装 key "${b.key}" 重复`);
    bundleKeys.add(b.key);
    if (!b.includes?.length) errors.push(`套装 "${b.key}" 的 includes 为空`);
    for (const k of b.includes || []) {
      if (!known.has(k)) errors.push(`套装 "${b.key}" 引用了未上架的技能 "${k}"`);
    }
    checkRoles(b.roles, `套装 "${b.key}"`);
  }

  if (errors.length) {
    console.error('[bundle-official-skills] scripts/skill-bundles.json 校验失败：');
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  return { roleLabels, skillRoles, skillRequires, bundles };
}

function main() {
  if (!existsSync(SKILLS_DIR)) {
    console.error(`[bundle-official-skills] 找不到 ${SKILLS_DIR}`);
    process.exit(1);
  }
  // 只打包 INCLUDE 白名单里、且目录真实存在 + 有 SKILL.md 的技能
  const dirs = [...INCLUDE].filter((d) => {
    const p = join(SKILLS_DIR, d);
    return existsSync(p) && statSync(p).isDirectory() && existsSync(join(p, 'SKILL.md'));
  }).sort();

  const missing = [...INCLUDE].filter((d) => !dirs.includes(d));
  if (missing.length) console.warn(`[bundle-official-skills] 警告：INCLUDE 里这些技能目录不存在，已跳过: ${missing.join(', ')}`);

  const { roleLabels, skillRoles, skillRequires, bundles } = loadBundleConfig(dirs);

  const skills = [];
  for (const key of dirs) {
    const skillDir = join(SKILLS_DIR, key);
    const files = collectFiles(skillDir, key);
    const md = readFileSync(join(skillDir, 'SKILL.md'), 'utf8');
    const { name, description, version } = parseFrontmatter(md);
    const title = DISPLAY_NAME[key] || name || key;
    skills.push({
      key,
      title,
      version: version || null,
      description: shortDesc(description, title),
      tags: deriveTags(key, name, description),
      roles: skillRoles[key] || [],
      requires: skillRequires[key] || [],
      files, // 完整目录（含 SKILL.md + reference/ + scripts/ 等文本文件）
    });
  }

  const out = {
    version: 3,
    generatedAt: new Date().toISOString(),
    count: skills.length,
    roleLabels,
    skills,
    bundles: bundles.map((b) => ({
      key: b.key,
      title: b.title || b.key,
      version: b.version || null,
      description: shortDesc(b.description, b.title || b.key),
      tags: b.tags || ['套装'],
      roles: b.roles || [],
      includes: b.includes,
      firstStep: b.firstStep || null,
    })),
  };
  writeFileSync(OUT_FILE, JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.log(`[bundle-official-skills] 写出 ${skills.length} 个官方技能 + ${out.bundles.length} 个角色套装 → ${OUT_FILE}`);
  for (const s of skills) {
    const trunc = s.files.filter((f) => f.truncated).length;
    const roles = s.roles.length ? ` <${s.roles.join('/')}>` : ' <无角色>';
    console.log(`  ${s.key.padEnd(28)} [${s.tags.join(', ')}]${roles}  ${s.files.length} 文件${trunc ? ` (${trunc} 截断)` : ''}  ${s.title}`);
  }
  for (const b of out.bundles) {
    console.log(`  套装 ${b.key.padEnd(23)} <${b.roles.join('/')}>  ${b.includes.length} 个技能  ${b.title}`);
  }
  const orphan = skills.filter((s) => !s.roles.length).map((s) => s.key);
  if (orphan.length) {
    console.warn(`[bundle-official-skills] 提示：这些技能没有角色归属，按角色筛选时看不到：${orphan.join(', ')}`);
  }
}

main();
