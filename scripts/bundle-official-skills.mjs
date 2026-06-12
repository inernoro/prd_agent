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
// 技能内容有变 / 新增技能时重跑本脚本并提交产物。

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SKILLS_DIR = join(ROOT, '.claude', 'skills');
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
  'acceptance-checklist',    // 通用 UAT 清单
  'create-visual-test-to-kb',// 通用视觉验收取证 + 报告归档
  'task-handoff-checklist',  // 通用交接清单
]);

// 友好显示名（key → 中文备注名）。缺省用 frontmatter name（多为英文 key）。
// 卡片标题展示这个，像 findmapskills 那样「英文 · 中文一句话」。
const DISPLAY_NAME = {
  'acceptance-checklist': 'acceptance-checklist · 真人验收清单',
  'code-hygiene': 'code-hygiene · 代码卫生体检',
  'conflict-resolution': 'conflict-resolution · Git 冲突解决',
  'create-skill-file': 'create-skill-file · 技能文件生成',
  'create-visual-test-to-kb': 'create-visual-test-to-kb · 视觉验收归档',
  'find-skills': 'find-skills · 技能发现',
  'human-verify': 'human-verify · 多视角人工验证',
  'laowang': '老王 · 米多解决问题五步法',
  'remotion-scene-codegen': 'remotion-scene-codegen · 视频场景代码生成',
  'risk-matrix': 'risk-matrix · MECE 风险评估',
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
  'feature-emerge': ['创意'],
  'release-version': ['部署'],
  bridge: ['工具'],
  cds: ['部署'],
  'ui-ux-pro-max': ['创意'],
};

// 递归收集技能目录下的全部文本文件（用于打包完整 zip，而非只 SKILL.md）
function collectFiles(skillDir) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) { walk(full); continue; }
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
      out.push({ path: relative(skillDir, full).split('\\').join('/'), content, truncated });
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

  const skills = [];
  for (const key of dirs) {
    const skillDir = join(SKILLS_DIR, key);
    const files = collectFiles(skillDir);
    const md = readFileSync(join(skillDir, 'SKILL.md'), 'utf8');
    const { name, description, version } = parseFrontmatter(md);
    const title = DISPLAY_NAME[key] || name || key;
    skills.push({
      key,
      title,
      version: version || null,
      description: shortDesc(description, title),
      tags: deriveTags(key, name, description),
      files, // 完整目录（含 SKILL.md + reference/ + scripts/ 等文本文件）
    });
  }

  const out = {
    version: 2,
    generatedAt: new Date().toISOString(),
    count: skills.length,
    skills,
  };
  writeFileSync(OUT_FILE, JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.log(`[bundle-official-skills] 写出 ${skills.length} 个官方技能 → ${OUT_FILE}`);
  for (const s of skills) {
    const trunc = s.files.filter((f) => f.truncated).length;
    console.log(`  ${s.key.padEnd(24)} [${s.tags.join(', ')}]  ${s.files.length} 文件${trunc ? ` (${trunc} 截断)` : ''}  ${s.title}`);
  }
}

main();
