import type { CodeReviewTask } from '../shared/code-review.js';
import { REVIEW_SEVERITIES, type CodeReviewFinding, type CodeReviewResult, type CodeReviewResultPage } from '../shared/code-review-result.js';

/** Only decode our own archived Markdown. Uploaded documents remain original documents. */
export function archivedCodeReviewResult(task: CodeReviewTask, markdown: string): CodeReviewResult | null {
  if (task.sourceType === 'report' || !markdown.startsWith('# 代码审查报告\n') || !markdown.includes(`\n任务：${task.id}\n`)) return null;
  const unescape = (value: string): string => value.replace(/\\([\[\]`])/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const findings: CodeReviewFinding[] = [];
  const pattern = /^### \d+\. \[(critical|high|medium|low|info)\] (bug|security|performance|style|maintainability)\n\n位置：([^\n]+)；工具：([^\n]+)；状态：待验证\n\n([\s\S]*?)\n\n修复建议：([\s\S]*?)(?=\n\n### |\n\n## 审查边界|(?![\s\S]))/gm;
  for (const match of markdown.matchAll(pattern)) {
    const position = /^(.*):(\d+)$/.exec(unescape(match[3]));
    findings.push({ severity: match[1] as CodeReviewFinding['severity'], category: match[2] as CodeReviewFinding['category'],
      filePath: position ? position[1] : unescape(match[3]), line: position ? Number(position[2]) : undefined,
      message: unescape(match[5]), suggestion: unescape(match[6].trim()), tool: unescape(match[4]), verified: false });
  }
  const expected = /共发现 (\d+) 项待核实问题/.exec(markdown);
  if (!expected || Number(expected[1]) !== findings.length) return null;
  return { version: 1, taskId: task.id, projectId: task.projectId, sourceHash: task.sourceHash, commitSha: task.commitSha,
    origin: 'archived-markdown', findings, notes: ['从 CDS 原始归档还原已有字段；历史归档未保存的源码片段与 AI 解释不予补写。', '所有发现均未做运行期验证。'] };
}

export function pageCodeReviewResult(task: CodeReviewTask, result: CodeReviewResult, options: { offset?: number; limit?: number; severity?: string; query?: string }): CodeReviewResultPage {
  const summary = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  const all = result.findings.map((finding, index) => { summary[finding.severity]++; return { ...finding, index }; });
  const query = options.query?.trim().toLocaleLowerCase();
  const filtered = all.filter(f => (!options.severity || options.severity === f.severity)
    && (!query || [f.title, f.message, f.filePath, f.suggestion].some(v => v?.toLocaleLowerCase().includes(query))));
  const offset = options.offset ?? 0, limit = options.limit ?? 50;
  const total = task.progress.totalFiles, scanned = task.progress.scannedFiles;
  const valid = Number.isSafeInteger(total) && total > 0 && Number.isSafeInteger(scanned) && scanned >= 0 && scanned <= total;
  return { version: 1, taskId: result.taskId, projectId: result.projectId, sourceHash: result.sourceHash, commitSha: result.commitSha,
    origin: result.origin, notes: result.notes, summary,
    coverage: { totalFiles: total, scannedFiles: scanned, unfinishedFiles: valid ? total - scanned : 0,
      inputSkippedFiles: task.inputSkippedFiles || 0, complete: valid && scanned === total && task.status === 'completed' },
    findings: filtered.slice(offset, offset + limit), page: { offset, limit, total: filtered.length, nextOffset: offset + limit < filtered.length ? offset + limit : null } };
}

export function sortCodeReviewFindings(findings: CodeReviewFinding[]): CodeReviewFinding[] {
  return [...findings].sort((a, b) => REVIEW_SEVERITIES.indexOf(a.severity) - REVIEW_SEVERITIES.indexOf(b.severity));
}
