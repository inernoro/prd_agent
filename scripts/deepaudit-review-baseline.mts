#!/usr/bin/env -S pnpm exec tsx
/** Reproducible static baseline. Reads Git blobs only, never executes target-project scripts. */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { buildZip } from '../cds/src/utils/zip.js';
import { validateCodeReviewZip } from '../cds/src/services/code-review-source.js';
import { runCodeReviewStaticAnalysis } from '../cds/src/services/code-review-static.js';

const repo = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const revision = process.argv[2] || 'HEAD';
const sha = execFileSync('git', ['rev-parse', '--verify', `${revision}^{commit}`], { cwd: repo, encoding: 'utf8' }).trim();
const output = path.resolve(process.argv[3] || `/workspace/scratch/deepaudit-baseline/${sha}`);
const tree = execFileSync('git', ['ls-tree', '-rlz', sha], { cwd: repo, maxBuffer: 16 * 1024 * 1024 }).toString('utf8').split('\0').filter(Boolean);
const roots = new Set(['prd-api', 'prd-admin', 'prd-desktop', 'llmgw', 'cds', 'scripts', 'deploy', 'e2e', '.github']);
const excluded = new Set(['node_modules', 'thirdparty', 'vendor', 'dist', 'build', 'bin', 'obj', 'target', '.git', '.cds', '__pycache__']);
const extension = /\.(?:js|ts|tsx|jsx|py|java|go|rs|cpp|c|h|cc|hh|cs|php|rb|kt|swift|sql|sh|json|yml|yaml)$/i;
let skipped = 0;
const files: Array<{ name: string; hash: string; size: number }> = [];
for (const row of tree) {
  const match = /^(\d+) blob ([a-f0-9]+)\s+(\d+)\t([\s\S]+)$/.exec(row);
  if (!match) { skipped++; continue; }
  const [, mode, hash, bytes, name] = match;
  const parts = name.split('/');
  if (!['100644', '100755'].includes(mode) || !roots.has(parts[0]) || parts.some((part) => excluded.has(part))
    || parts.at(-1)!.startsWith('.env') || !extension.test(name) || Number(bytes) > 200 * 1024) { skipped++; continue; }
  files.push({ name, hash, size: Number(bytes) });
}
const blobs = execFileSync('git', ['cat-file', '--batch'], { cwd: repo, input: files.map((file) => file.hash).join('\n') + '\n', maxBuffer: 100 * 1024 * 1024 });
let offset = 0;
const entries = files.map((file) => {
  const newline = blobs.indexOf(10, offset);
  const header = blobs.subarray(offset, newline).toString('utf8');
  if (!header.endsWith(` blob ${file.size}`)) throw new Error('Git blob response does not match inventory');
  offset = newline + 1;
  const data = blobs.subarray(offset, offset + file.size); offset += file.size + 1;
  return { name: file.name, data };
});
const snapshot = await validateCodeReviewZip(buildZip(entries));
const result: Awaited<ReturnType<typeof runCodeReviewStaticAnalysis>> = { findings: [], notes: [] };
for (const root of roots) {
  const moduleEntries = entries.filter((entry) => entry.name.startsWith(`${root}/`)).map((entry) => ({ ...entry, name: entry.name.slice(root.length + 1) }));
  if (!moduleEntries.length) continue;
  const moduleResult = await runCodeReviewStaticAnalysis({ zip: buildZip(moduleEntries), signal: AbortSignal.timeout(90_000) });
  result.findings.push(...moduleResult.findings.map((finding) => ({ ...finding, filePath: `${root}/${finding.filePath}` })));
  result.notes.push(...moduleResult.notes.map((note) => `${root}：${note}`));
}
const sourceHash = createHash('sha256').update(snapshot.zip).digest('hex');
const findings = [...result.findings].sort((a, b) => a.filePath.localeCompare(b.filePath) || (a.line || 0) - (b.line || 0));
const fixtureHits = findings.filter((finding) => /\.test\.[jt]sx?$|\/__tests__\/|\/scripts\//.test(finding.filePath)).length;
const moduleCounts = new Map<string, number>();
for (const finding of findings) { const module = finding.filePath.split('/')[0]; moduleCounts.set(module, (moduleCounts.get(module) || 0) + 1); }
const clean = (value: string) => value.replace(/[&<>]/g, (s) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[s]!)).replace(/([\[\]`])/g, '\\$1');
const report = ['# 当前项目代码审查报告（静态基线）', '',
  '**结论：综合审查尚未完成。** 本次只执行固定 Semgrep 规则；DeepAudit AI 五维分析尚待审查引擎部署和模型配置。', '',
  `固定规则共有 ${findings.length} 项命中，其中 ${fixtureHits} 项位于测试或回归工具；这些命中不直接等同于已确认的业务漏洞。`, '',
  `仓库：inernoro/prd_agent`, `固定提交：${sha}`, `源码快照 SHA-256：${sourceHash}`, '',
  '## 覆盖与限制', '', `读取 ${snapshot.totalFiles} 个合格自研源码/配置文件；排除 ${skipped + snapshot.skippedFiles} 个非目标、第三方、构建、过大或不支持文件。`,
  '自研范围：prd-api、prd-admin、prd-desktop、llmgw、cds、scripts、deploy、e2e、.github。',
  ...result.notes.map((note) => `- ${clean(note)}`),
  '- 安全与 Bug：仅检查固定规则覆盖的模式。性能、风格、可维护性及其他语言的全面分析未执行。',
  '- 所有发现均待复核；没有命中不表示不存在缺陷。未执行动态 PoC 或目标项目脚本。', '',
  '## 模块发现', '', ...[...moduleCounts].map(([module, count]) => `- ${clean(module)}：${count} 项`), '',
  '## 问题明细', '', ...findings.flatMap((finding, index) => [
    `### ${index + 1}. [${finding.severity}] ${clean(finding.filePath)}:${finding.line || 1}`, '',
    clean(finding.message), '', `工具：${clean(finding.tool)}；状态：待人工复核`, '',
  ]), '## 后续验收', '', '完成 DeepAudit Fork、同提交镜像发布和 CDS 部署后，针对同一固定提交补齐 AI 五维分析，并归档完整审查报告。', '',
].join('\n');
await fs.mkdir(output, { recursive: true });
await fs.writeFile(path.join(output, 'report.md'), report, { mode: 0o600 });
await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ sha, sourceHash, selectedFiles: snapshot.totalFiles,
  excludedFiles: skipped + snapshot.skippedFiles, findings, notes: result.notes, analysisMode: 'static-only' }, null, 2), { mode: 0o600 });
process.stdout.write(JSON.stringify({ sha, selectedFiles: snapshot.totalFiles, findings: findings.length, output }) + '\n');
