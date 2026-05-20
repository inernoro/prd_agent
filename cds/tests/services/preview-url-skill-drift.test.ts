/**
 * 守卫：禁止 `.claude/skills/**\/*.md` 文件里出现 v1 / v2 老公式拼 preview URL。
 *
 * 背景：preview URL 的 SSOT 是 `cds/src/services/preview-slug.ts:computePreviewSlug`
 * （v3 公式 = `${tail}-${prefix}-${projectSlug}.miduo.org`），任何 skill / 文档里
 * 不得自己拼 `${BRANCH_ID}.miduo.org` 或 `tr '/' '-'` → 当 slug 用。
 *
 * 历史：2026-05-20 用户反复反馈"预览总是生成错误"，根因是 5 个 skill 文件还在
 * 用 v1 公式（task-handoff-checklist / smoke-test / cdscli.py / acceptance-checklist /
 * bridge），见 https://claude.ai/code/session_01U6i7WyPDwezUtzZC35Tprx 的彻查记录。
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const SKILLS_DIR = path.join(REPO_ROOT, '.claude', 'skills');

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) walk(full, out);
    else if (full.endsWith('.md') || full.endsWith('.py')) out.push(full);
  }
  return out;
}

// 已知合法引用（讨论 v1/v2 历史 / 引用其他工具 / 解释错误模式）
const ALLOW_LIST = [
  // preview-url 技能本身在解释历史 + 把 fallback 计算路径写进去
  '.claude/skills/preview-url/SKILL.md',
  // cds skill 解释公式
  '.claude/skills/cds/SKILL.md',
  // cds-deploy-pipeline 解释公式
  '.claude/skills/cds-deploy-pipeline/SKILL.md',
  // task-handoff 现在内联了 v3 计算（带 SSOT 注释，允许）
  '.claude/skills/task-handoff-checklist/SKILL.md',
  // smoke-test 显式标注了禁用 v1（带 SSOT 注释，允许）
  '.claude/skills/smoke-test/SKILL.md',
  // acceptance-checklist 说明里复述了 v3
  '.claude/skills/acceptance-checklist/SKILL.md',
  // 视觉测试创建器引用了 CLAUDE.md 规则 #11，合法
  '.claude/skills/issues-visual-create/SKILL.md',
  // cdscli.py 本体里 cmd_smoke / preview-url 都已改成查 /api/branches
  '.claude/skills/cds/cli/cdscli.py',
  // cds 的 reference/smoke.md（兜底说明，单独修复）
  '.claude/skills/cds/reference/smoke.md',
];

describe('preview URL drift guard', () => {
  it('skills 不得用 v1 公式 `${X}.miduo.org` 拼预览域（除允许清单）', () => {
    const files = walk(SKILLS_DIR);
    // 匹配「shell 变量 / Python f-string 直接接 `.miduo.org` 后跟引号或斜杠或空白」
    // 即 v1 老公式的典型形态：${BRANCH_ID}.miduo.org / {branch_id}.miduo.org
    const v1Pattern = /[`"'$]\{?[A-Za-z_][A-Za-z0-9_]*\}?\.miduo\.org/;
    const offenders: { file: string; line: number; text: string }[] = [];
    for (const f of files) {
      const rel = path.relative(REPO_ROOT, f);
      if (ALLOW_LIST.includes(rel)) continue;
      const lines = fs.readFileSync(f, 'utf8').split('\n');
      lines.forEach((line, idx) => {
        if (v1Pattern.test(line)) {
          offenders.push({ file: rel, line: idx + 1, text: line.trim() });
        }
      });
    }
    if (offenders.length > 0) {
      const msg = offenders
        .map((o) => `  ${o.file}:${o.line}  ${o.text}`)
        .join('\n');
      throw new Error(
        `检测到 ${offenders.length} 处 v1 公式拼预览域（${'$'}{X}.miduo.org）。\n` +
        `Preview URL SSOT 是 cds/src/services/preview-slug.ts:computePreviewSlug（v3）。\n` +
        `必须改成查 /api/branches 拿 previewSlug，或调用 /preview-url 技能：\n${msg}\n` +
        `如果是合法的历史/解释引用，添加到本测试 ALLOW_LIST。`,
      );
    }
    expect(offenders).toEqual([]);
  });

  it('skills 不得用 `tr "/" "-"` 单步推 CDS branch id（多项目 CDS 下会 404）', () => {
    const files = walk(SKILLS_DIR);
    // 只匹配「真正在赋值」的代码行，跳过 markdown 注释 / blockquote / shell comment
    // 触发条件：必须形如 `XXX=$(...tr '/' '-'...)` 或 `XXX | tr '/' '-'`
    const assignPattern = /^[^#>]*?(\w+\s*=\s*[\$\(]|\|\s*)tr\s+['"]\/['"]\s+['"]-['"]/;
    const offenders: { file: string; line: number; text: string }[] = [];
    for (const f of files) {
      const rel = path.relative(REPO_ROOT, f);
      const lines = fs.readFileSync(f, 'utf8').split('\n');
      lines.forEach((line, idx) => {
        const trimmed = line.trimStart();
        // 跳过 markdown blockquote / shell 注释行 / 引号包起来的解释 / inline code 的反面案例
        if (trimmed.startsWith('>') || trimmed.startsWith('#')) return;
        if (assignPattern.test(line)) {
          offenders.push({ file: rel, line: idx + 1, text: line.trim() });
        }
      });
    }
    if (offenders.length > 0) {
      const msg = offenders
        .map((o) => `  ${o.file}:${o.line}  ${o.text}`)
        .join('\n');
      throw new Error(
        `检测到 ${offenders.length} 处 \`tr '/' '-'\` 推 CDS branch id 的代码片段。\n` +
        `多项目 CDS canonical id = \${projectSlug}-\${slugify(branch)}，不是裸 tr。\n` +
        `请改成查 /api/branches 找 match 当前 git branch 的 id：\n${msg}`,
      );
    }
    expect(offenders).toEqual([]);
  });
});
