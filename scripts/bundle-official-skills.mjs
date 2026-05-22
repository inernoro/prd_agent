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
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SKILLS_DIR = join(ROOT, '.claude', 'skills');
const OUT_FILE = join(ROOT, 'prd-api', 'src', 'PrdAgent.Api', 'OfficialSkills', 'official-skills.generated.json');

// SKILL.md 内容上限（防止个别超长技能把 JSON 撑爆；预览/摘要够用）
const MAX_SKILL_MD = 16000;

// ── tag 分类启发式 ────────────────────────────────────────────────────────
// 与 prd-admin/src/lib/skillGlyphRegistry.ts 的 TAG_STYLE_GROUPS 对齐：
//   工程/工具/运维 → 罗盘   创意/内容/设计 → 植物   分析/数据/报告 → 星图
// 命中关键字给一个「类别 tag」，决定卡片图标形态 + 风格。命不中给 "工具" 兜底。
const TAG_RULES = [
  { tag: '部署', kw: ['deploy', 'cds', '部署', '灰度', '容器', 'docker', 'pipeline', '环境', 'executor', '执行器'] },
  { tag: '运维', kw: ['运维', '巡检', 'issue', '修复', 'fix', 'autofix', 'audit', '诊断', 'debug', '熵'] },
  { tag: '分析', kw: ['分析', '评审', 'review', 'verify', '验证', '验收', 'trace', '追踪', 'risk', '风险', 'visibility', '审查', '台账', 'ledger'] },
  { tag: '周报', kw: ['周报', 'weekly', 'report', '报告', '总结', 'summary'] },
  { tag: '文档', kw: ['文档', 'doc', 'documentation', '写作', 'readme'] },
  { tag: '创意', kw: ['创意', '设计', 'ui', 'ux', '视觉', '图', 'image', 'remotion', '视频', 'video', '涌现', 'emerge', '主题', 'theme', 'demo'] },
  { tag: '需求', kw: ['需求', 'validate', 'prd', '方案', 'plan', '规划'] },
  { tag: '技能', kw: ['skill', '技能', 'marketplace', '海鲜市场', 'findmap'] },
];

function parseFrontmatter(md) {
  // 取首个 --- ... --- 块里的 name / description（description 可能是多行 > 折叠）
  const lines = md.split('\n');
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  if (lines[i]?.trim() !== '---') return { name: null, description: null };
  i++;
  let name = null;
  let description = null;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '---') break;
    const mName = line.match(/^name:\s*(.+?)\s*$/);
    if (mName && !name) { name = mName[1].replace(/^["']|["']$/g, ''); continue; }
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
  return { name, description };
}

function deriveTags(key, name, description) {
  const hay = `${key} ${name ?? ''} ${description ?? ''}`.toLowerCase();
  const tags = [];
  for (const rule of TAG_RULES) {
    if (rule.kw.some((k) => hay.includes(k))) tags.push(rule.tag);
  }
  if (tags.length === 0) tags.push('工具');
  // 去重 + 最多 3 个（卡片只展示前 3）
  return [...new Set(tags)].slice(0, 3);
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
  const dirs = readdirSync(SKILLS_DIR).filter((d) => {
    const p = join(SKILLS_DIR, d);
    return statSync(p).isDirectory() && existsSync(join(p, 'SKILL.md'));
  }).sort();

  const skills = [];
  for (const key of dirs) {
    const mdPath = join(SKILLS_DIR, key, 'SKILL.md');
    let md = readFileSync(mdPath, 'utf8');
    const { name, description } = parseFrontmatter(md);
    if (md.length > MAX_SKILL_MD) md = md.slice(0, MAX_SKILL_MD) + '\n\n…(内容已截断，完整版见仓库 .claude/skills)';
    const title = name || key;
    skills.push({
      key,
      title,
      description: shortDesc(description, title),
      tags: deriveTags(key, name, description),
      skillMd: md,
    });
  }

  const out = {
    version: 1,
    generatedAt: new Date().toISOString(),
    count: skills.length,
    skills,
  };
  writeFileSync(OUT_FILE, JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.log(`[bundle-official-skills] 写出 ${skills.length} 个官方技能 → ${OUT_FILE}`);
  // 打印 tag 分配速览，方便人工校对
  for (const s of skills) console.log(`  ${s.key.padEnd(26)} [${s.tags.join(', ')}]  ${s.title}`);
}

main();
