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
// 守卫覆盖范围：全仓所有可能生成 / 描述 preview URL 的源
// - 技能 / 规则 / CLAUDE.md 都是 AI 行为来源
// - prd-api / prd-admin / prd-desktop / prd-video / scripts / cds-source 是实际代码
// - cds/src 本身也扫（除了 SSOT 文件和已知白名单测试）
const SCAN_TARGETS = [
  path.join(REPO_ROOT, '.claude', 'skills'),
  path.join(REPO_ROOT, '.claude', 'rules'),
  path.join(REPO_ROOT, 'CLAUDE.md'),
  path.join(REPO_ROOT, 'cds', 'CLAUDE.md'),
  path.join(REPO_ROOT, 'prd-api', 'src'),
  path.join(REPO_ROOT, 'prd-admin', 'src'),
  path.join(REPO_ROOT, 'prd-desktop', 'src'),
  // Tauri Rust 源也要扫——`.rs` 已在 SCAN_EXTENSIONS，目录漏了等于无效
  path.join(REPO_ROOT, 'prd-desktop', 'src-tauri'),
  path.join(REPO_ROOT, 'prd-video', 'src'),
  path.join(REPO_ROOT, 'cds', 'src'),
  path.join(REPO_ROOT, 'cds', 'web', 'src'),
  path.join(REPO_ROOT, 'scripts'),
  path.join(REPO_ROOT, 'e2e'),
  path.join(REPO_ROOT, '.github', 'workflows'),
];

const SCAN_EXTENSIONS = ['.md', '.py', '.cs', '.ts', '.tsx', '.js', '.jsx',
                          '.rs', '.sh', '.ps1', '.yml', '.yaml'];

function walk(target: string, out: string[] = []): string[] {
  if (!fs.existsSync(target)) return out;
  const stat = fs.statSync(target);
  if (stat.isFile()) {
    if (SCAN_EXTENSIONS.some((ext) => target.endsWith(ext))) out.push(target);
    return out;
  }
  for (const name of fs.readdirSync(target)) {
    // 跳过明显的产物 / 依赖目录
    if (['node_modules', 'dist', 'bin', 'obj', '.git', 'build', 'web-legacy'].includes(name)) continue;
    walk(path.join(target, name), out);
  }
  return out;
}

function collectFiles(): string[] {
  const out: string[] = [];
  for (const t of SCAN_TARGETS) walk(t, out);
  return out;
}

// 已知合法引用（讨论 v1/v2 历史 / SSOT 自身）—— **整文件豁免**仅保留真正
// 无法用 line-level marker 处理的：实际公式实现（如 cdscli.py 的 v3 SSOT 用了
// Python f-string `{slug}`，与 v1 形态字面冲突，必须整文件豁免）。
// 其它解释类文档改用 inline `guard-allow: preview-url-drift` 标记跳过单行，
// 这样未来谁在这些文件里塞回 v1 公式仍会被守卫抓到。
const ALLOW_LIST = [
  // SSOT 自身（TypeScript v3 计算函数；C# 容器内 fallback 实现，由 parity 测试守护）
  'cds/src/services/preview-slug.ts',
  'prd-api/src/PrdAgent.Infrastructure/Services/ClaudeSidecar/ClaudeSidecarRouter.cs',
  // cdscli.py 内嵌 v3 SSOT，f-string `{slug}` 会被正则抓但属合法实现
  '.claude/skills/cds/cli/cdscli.py',
];

// Line-level 豁免标记：行尾含此字符串就跳过守卫（用于反面案例 / 历史解释）。
// 提供这个 mechanism 是为了避免整文件豁免——单点豁免范围最小，未来回归即抓。
const LINE_ALLOW_MARKER = 'guard-allow: preview-url-drift';

describe('preview URL drift guard', () => {
  it('skills 不得用 v1 公式 `${X}.miduo.org` 拼预览域（除允许清单）', () => {
    const files = collectFiles();
    // 真正的 v1 拼接形态：`https://${单占位符}.miduo.org`（占位符后直接接 .miduo.org，
    // 中间没有 `-${另一占位符}` 拼接）。必须**显式带占位符** `${X}` / `{X}` / `$X`
    // 才算 v1，字面量 URL（如 `https://prd-agent.miduo.org` / `https://my-branch.miduo.org`）
    // 不算 —— 它们可能是 v3 SSOT 的展示样例或固定服务地址。
    //
    // 三种占位符形态都要抓（之前漏过 bash 无大括号风格 `$BRANCH_ID`，Codex P2 抓出）：
    //   1. `${IDENT}` — bash 带大括号 / shell 参数展开
    //   2. `{ident}`  — Python f-string / Jinja 模板 / 文档占位 `{branch-slug}`
    //   3. `$IDENT`   — bash 无大括号变量引用（IDENT 必须 [A-Za-z_]开头，`.` 终止）
    //
    // 占位符字符集要包含 `-` 才能吃下文档常见的 `{branch-slug}` / `{branch-id}`。
    const v1Pattern = /https?:\/\/[`'"]?(?:\$\{[A-Za-z0-9_-]+\}|\$[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z0-9_-]+\})\.miduo\.org/;
    // CDS admin / 静态服务子域不算 preview URL，加白名单防误伤
    const STATIC_HOSTS = ['cds.miduo.org', 'i.miduo.org', 'api.miduo.org'];
    const offenders: { file: string; line: number; text: string }[] = [];
    for (const f of files) {
      const rel = path.relative(REPO_ROOT, f);
      if (ALLOW_LIST.includes(rel)) continue;
      const lines = fs.readFileSync(f, 'utf8').split('\n');
      lines.forEach((line, idx) => {
        if (!v1Pattern.test(line)) return;
        // 已知静态子域跳过
        if (STATIC_HOSTS.some((h) => line.includes(h))) return;
        // 行级豁免：源文件用 `guard-allow: preview-url-drift` 标记反面案例 / 历史引用
        if (line.includes(LINE_ALLOW_MARKER)) return;
        offenders.push({ file: rel, line: idx + 1, text: line.trim() });
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
    const files = collectFiles();
    // 只匹配「真正在赋值」的代码行，跳过 markdown 注释 / blockquote / shell comment
    // 触发条件：必须形如 `XXX=$(...tr '/' '-'...)` 或 `XXX | tr '/' '-'`。
    // 引号可选——bash 允许 `tr / -` 不带引号（`/` 和 `-` 都不是 shell 元字符），
    // 这种形态如果不抓守卫等于没用（Codex P2 抓出此 gap）。
    const assignPattern = /^[^#>]*?(\w+\s*=\s*[\$\(]|\|\s*)tr\s+['"]?\/['"]?\s+['"]?-['"]?/;
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
