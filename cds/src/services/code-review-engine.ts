import { setTimeout as delay } from 'node:timers/promises';
import { reviewJsonRequest, type CodeReviewAudit } from './code-review-audit.js';

export interface CodeReviewFinding {
  filePath: string;
  line?: number;
  category: 'bug' | 'security' | 'performance' | 'style' | 'maintainability';
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  message: string;
  suggestion?: string;
  verified: false;
  tool: string;
}
export interface CodeReviewEngineResult {
  findings: CodeReviewFinding[];
  totalFiles: number;
  scannedFiles: number;
  skippedFiles: number;
  notes: string[];
  engineTaskId: string;
}

interface EngineTask { id: string; status: string; total_files: number; scanned_files: number }

/** DeepAudit v3 five-dimension ZIP scanner. Does not call the Agent/PoC sandbox API. */
export class CodeReviewEngine {
  private token?: string;
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: {
    baseUrl: string; username?: string; password?: string; token?: string; fetchImpl?: typeof fetch; pollIntervalMs?: number;
  }) {
    const url = new URL(options.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('DeepAudit 服务地址无效');
    }
    this.base = options.baseUrl.replace(/\/$/, '').replace(/\/api\/v1$/, '') + '/api/v1';
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async run(input: {
    taskId: string; zip: Buffer; signal: AbortSignal; excludePatterns: string[]; engineTaskId?: string;
    onProgress: (progress: { phase: string; totalFiles: number; scannedFiles: number; engineTaskId?: string }) => Promise<void>;
    audit: CodeReviewAudit;
  }): Promise<CodeReviewEngineResult> {
    input.signal.throwIfAborted();
    if (!this.token) {
      if (!this.options.username || !this.options.password) throw new Error('DeepAudit 服务账号未配置');
      const form = new URLSearchParams({ username: this.options.username, password: this.options.password });
      const login = await reviewJsonRequest('deepaudit.login', `${this.base}/auth/login`,
        { method: 'POST', body: form, signal: input.signal }, input.audit, this.fetchImpl) as { access_token?: string };
      if (!login.access_token || typeof login.access_token !== 'string') throw new Error('DeepAudit 登录未返回服务令牌');
      this.token = login.access_token;
    }
    const headers = { Authorization: `Bearer ${this.token}` };
    const request = (operation: string, path: string, init: RequestInit = {}) => reviewJsonRequest(operation, `${this.base}${path}`,
      { ...init, headers: { ...headers, ...init.headers }, signal: input.signal }, input.audit, this.fetchImpl);
    let engineTaskId = input.engineTaskId;
    if (!engineTaskId) {
      // Separate upstream project per task prevents concurrent ZIP overwrites and isolates snapshots.
      const project = await request('deepaudit.create_project', '/projects/', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `CDS-${input.taskId}`, source_type: 'zip', description: 'CDS 固定源码快照审查' }),
      }) as { id?: string };
      if (!project.id || typeof project.id !== 'string') throw new Error('DeepAudit 未返回项目 ID');
      const form = new FormData();
      form.set('project_id', project.id);
      form.set('file', new Blob([new Uint8Array(input.zip)], { type: 'application/zip' }), 'snapshot.zip');
      form.set('scan_config', JSON.stringify({ exclude_patterns: input.excludePatterns }));
      const scan = await request('deepaudit.submit_scan', '/scan/upload-zip', { method: 'POST', body: form }) as { task_id?: string };
      if (!scan.task_id || typeof scan.task_id !== 'string') throw new Error('DeepAudit 未返回审查任务 ID');
      engineTaskId = scan.task_id;
    }
    const taskPath = `/tasks/${encodeURIComponent(engineTaskId)}`;
    try {
      await input.onProgress({ phase: 'DeepAudit 已接收源码，等待分析', totalFiles: 0, scannedFiles: 0, engineTaskId });
      let task: EngineTask;
      for (;;) {
        input.signal.throwIfAborted();
        task = await request('deepaudit.task_status', taskPath) as EngineTask;
        if (!task || !['pending', 'queued', 'running', 'completed', 'failed', 'cancelled'].includes(task.status)) {
          throw new Error('DeepAudit 返回了未知任务状态');
        }
        const totalFiles = Math.max(0, Number(task.total_files) || 0);
        const scannedFiles = Math.max(0, Number(task.scanned_files) || 0);
        await input.onProgress({ phase: task.status === 'completed' ? 'DeepAudit 分析结束' : 'DeepAudit 正在分析源码',
          totalFiles, scannedFiles, engineTaskId });
        if (task.status === 'completed') break;
        if (task.status === 'failed' || task.status === 'cancelled') throw new Error(`DeepAudit 任务${task.status === 'failed' ? '失败' : '已取消'}`);
        await delay(this.options.pollIntervalMs ?? 2000, undefined, { signal: input.signal });
      }
      const rawIssues = await request('deepaudit.task_findings', `${taskPath}/issues`);
      if (!Array.isArray(rawIssues)) throw new Error('DeepAudit 问题列表格式无效');
      const categories = ['bug', 'security', 'performance', 'style', 'maintainability'];
      const severities = ['critical', 'high', 'medium', 'low', 'info'];
      const findings = rawIssues.map((raw): CodeReviewFinding => {
        const issue = raw as Record<string, unknown>;
        const issueType = String(issue.issue_type ?? '').toLowerCase();
        const category = categories.includes(issueType) ? issueType as CodeReviewFinding['category']
          : /vuln|inject|xss|ssrf|secret|auth|crypto|security|traversal/.test(issueType) ? 'security' : 'bug';
        const severity = String(issue.severity ?? '').toLowerCase();
        return { filePath: String(issue.file_path ?? 'unknown'), line: Number.isInteger(issue.line_number) && Number(issue.line_number) > 0 ? Number(issue.line_number) : undefined,
          category, severity: severities.includes(severity) ? severity as CodeReviewFinding['severity'] : 'medium',
          message: String(issue.message || issue.description || issue.title || '未提供问题说明'),
          suggestion: issue.suggestion ? String(issue.suggestion) : undefined, verified: false, tool: 'DeepAudit AI' };
      });
      const totalFiles = Math.max(0, Number(task.total_files) || 0);
      const scannedFiles = Math.max(0, Number(task.scanned_files) || 0);
      return { findings, totalFiles, scannedFiles, skippedFiles: Math.max(0, totalFiles - scannedFiles), engineTaskId,
        notes: ['采用 DeepAudit 静态与 AI 五维分析；未执行动态 PoC，发现均待人工复核。',
          ...(scannedFiles < totalFiles ? [`DeepAudit 有 ${totalFiles - scannedFiles} 个文件未成功分析，不能视为全量通过。`] : []),
          ...(totalFiles === 0 ? ['DeepAudit 未分析任何文件，检查支持语言、排除规则和模型配置。'] : [])] };
    } catch (error) {
      if (input.signal.aborted) {
        // Best-effort upstream cancellation uses an independent short timeout.
        await reviewJsonRequest('deepaudit.cancel_task', `${this.base}${taskPath}/cancel`,
          { method: 'POST', headers, signal: AbortSignal.timeout(5000) }, input.audit, this.fetchImpl).catch(() => undefined);
      }
      throw error;
    }
  }
}
