import { setTimeout as delay } from 'node:timers/promises';
import { CODE_REVIEW_ENGINE_FAILURE_REASONS, CodeReviewUpstreamHttpError, reviewJsonRequest, type CodeReviewAudit } from './code-review-audit.js';
import { readCodeReviewSnapshot } from './code-review-source.js';
import type { CodeReviewFinding } from '../shared/code-review-result.js';
export type { CodeReviewFinding } from '../shared/code-review-result.js';

/** Stop local polling on CDS shutdown without cancelling the durable upstream task. */
export class CodeReviewWorkerStoppedError extends Error {}

export interface CodeReviewEngineResult {
  findings: CodeReviewFinding[];
  totalFiles: number;
  scannedFiles: number;
  skippedFiles: number;
  notes: string[];
  engineTaskId: string;
}

interface EngineTask { id: string; status: string; total_files: number; scanned_files: number; error_code?: string; error_message?: string;
  resumable?: boolean; checkpoint_version?: number; processed_files?: number; failed_files?: number; skipped_files?: number; issues_count?: number }
const MAX_FINDINGS = 100_000;
const MAX_FINDING_BYTES = 128 * 1024 * 1024;
function hasIncompleteFiles(task: EngineTask): boolean {
  const skipped = task.checkpoint_version === 1 ? task.skipped_files ?? 0 : 0;
  const failed = task.failed_files ?? 0;
  if (task.checkpoint_version === 1) {
    const counts = [task.total_files, task.scanned_files, skipped, failed, task.processed_files ?? 0];
    if (counts.some((count) => !Number.isSafeInteger(count) || count < 0)
      || task.scanned_files + skipped + failed > task.total_files || (task.processed_files ?? 0) > task.total_files) {
      throw new Error('DeepAudit 文件覆盖计数无效，未归档不完整报告');
    }
  }
  return Number(failed) > 0 || Number(task.scanned_files) + Number(skipped) < Number(task.total_files);
}

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

  private async login(signal: AbortSignal, audit: CodeReviewAudit): Promise<void> {
    if (!this.options.username || !this.options.password) throw new Error('DeepAudit 服务账号未配置');
    const form = new URLSearchParams({ username: this.options.username, password: this.options.password });
    const login = await reviewJsonRequest('deepaudit.login', `${this.base}/auth/login`,
      { method: 'POST', body: form, signal }, audit, this.fetchImpl) as { access_token?: string };
    if (!login.access_token || typeof login.access_token !== 'string') throw new Error('DeepAudit 登录未返回服务令牌');
    this.token = login.access_token;
  }

  private requester(input: { signal: AbortSignal; audit: CodeReviewAudit }) {
    return async (operation: string, path: string, init: RequestInit = {}): Promise<unknown> => {
      const attempt = () => reviewJsonRequest(operation, `${this.base}${path}`, {
        ...init, headers: { Authorization: `Bearer ${this.token}`, ...init.headers }, signal: input.signal,
      }, input.audit, this.fetchImpl);
      const attemptedToken = this.token;
      try { return await attempt(); } catch (error) {
        // An explicit token remains an administrator-owned credential. Only service logins can refresh.
        if (!(error instanceof CodeReviewUpstreamHttpError) || error.status !== 401 || this.options.token
          || !this.options.username || !this.options.password) throw error;
        if (this.token === attemptedToken) await this.login(input.signal, input.audit);
        return attempt(); // One retry, with independent audit evidence for every HTTP attempt.
      }
    };
  }

  /** Read a stopped native task without submission, resume, polling or model calls. */
  async readExisting(engineTaskId: string, input: { signal: AbortSignal; audit: CodeReviewAudit }): Promise<CodeReviewEngineResult | null> {
    if (!this.token) await this.login(input.signal, input.audit);
    const request = this.requester(input);
    const task = await request('deepaudit.read_existing_status', `/tasks/${encodeURIComponent(engineTaskId)}`) as EngineTask;
    if (!task || task.id !== engineTaskId) throw new Error('DeepAudit 返回的任务身份不匹配，未读取问题明细');
    if (!['completed', 'failed', 'cancelled'].includes(task.status)) return null;
    hasIncompleteFiles(task); // Validates checkpoint counts; partial coverage remains explicit.
    return this.readTaskResult(task, engineTaskId, request);
  }

  private async readTaskResult(task: EngineTask, engineTaskId: string,
    request: (operation: string, path: string, init?: RequestInit) => Promise<unknown>): Promise<CodeReviewEngineResult> {
    const taskPath = `/tasks/${encodeURIComponent(engineTaskId)}`;
      let rawIssues: unknown[];
      if (task.checkpoint_version === 1) {
        const expected = task.issues_count;
        if (expected !== undefined && (!Number.isInteger(expected) || expected < 0 || expected > MAX_FINDINGS)) {
          throw new Error('DeepAudit 问题总数无效或超过安全处理上限，未归档不完整报告');
        }
        rawIssues = [];
        const ids = new Set<string>();
        let bytes = 0;
        for (;;) {
          const page = await request('deepaudit.task_findings', `${taskPath}/issues?offset=${rawIssues.length}&limit=200`);
          if (!Array.isArray(page) || page.length > 200) throw new Error('DeepAudit 分页问题列表格式无效');
          bytes += Buffer.byteLength(JSON.stringify(page));
          if (rawIssues.length + page.length > MAX_FINDINGS || bytes > MAX_FINDING_BYTES) {
            throw new Error('DeepAudit 问题列表超过安全处理上限，未归档不完整报告');
          }
          for (const issue of page) {
            const id = issue && typeof issue === 'object' ? (issue as Record<string, unknown>).id : undefined;
            if (typeof id !== 'string' || !id || ids.has(id)) throw new Error('DeepAudit 分页问题编号缺失或重复，未归档不完整报告');
            ids.add(id);
          }
          rawIssues.push(...page);
          if (expected !== undefined && rawIssues.length > expected) throw new Error('DeepAudit 问题列表与总数不一致，未归档不完整报告');
          if (page.length < 200) break;
        }
        if (expected !== undefined && rawIssues.length !== expected) throw new Error('DeepAudit 问题列表与总数不一致，未归档不完整报告');
      } else {
        const legacy = await request('deepaudit.task_findings', `${taskPath}/issues`);
        if (!Array.isArray(legacy)) throw new Error('DeepAudit 问题列表格式无效');
        rawIssues = legacy;
      }
      const categories = ['bug', 'security', 'performance', 'style', 'maintainability'];
      const severities = ['critical', 'high', 'medium', 'low', 'info'];
      const findings = rawIssues.map((raw): CodeReviewFinding => {
        const issue = raw as Record<string, unknown>;
        const issueType = String(issue.issue_type ?? '').toLowerCase();
        const category = categories.includes(issueType) ? issueType as CodeReviewFinding['category']
          : /vuln|inject|xss|ssrf|secret|auth|crypto|security|traversal/.test(issueType) ? 'security' : 'bug';
        const severity = String(issue.severity ?? '').toLowerCase();
        // The ZIP scanner copies title into message; description holds the actual cause.
        const explanation = [...new Set([issue.title, issue.message, issue.description]
          .filter((value): value is string => typeof value === 'string').map((value) => value.trim()).filter(Boolean))].join('\n\n');
        return { id: typeof issue.id === 'string' ? issue.id : undefined, title: typeof issue.title === 'string' ? issue.title : undefined,
          filePath: String(issue.file_path ?? 'unknown'), line: Number.isInteger(issue.line_number) && Number(issue.line_number) > 0 ? Number(issue.line_number) : undefined,
          codeSnippet: typeof issue.code_snippet === 'string' ? issue.code_snippet : undefined,
          aiExplanation: typeof issue.ai_explanation === 'string' ? issue.ai_explanation : undefined,
          endLine: Number.isInteger(issue.end_line) && Number(issue.end_line) > 0 ? Number(issue.end_line) : undefined,
          category, severity: severities.includes(severity) ? severity as CodeReviewFinding['severity'] : 'medium',
          message: explanation || '未提供问题说明',
          suggestion: issue.suggestion ? String(issue.suggestion) : undefined, verified: false, tool: 'DeepAudit AI' };
      });
      const totalFiles = Math.max(0, Number(task.total_files) || 0);
      const scannedFiles = Math.max(0, Number(task.scanned_files) || 0);
      return { findings, totalFiles, scannedFiles, skippedFiles: Math.max(0, totalFiles - scannedFiles), engineTaskId,
        notes: ['采用 DeepAudit 静态与 AI 五维分析；未执行动态 PoC，发现均待人工复核。',
          ...(task.checkpoint_version === 1 && Number(task.skipped_files) > 0 ? [`DeepAudit 按引擎政策跳过 ${task.skipped_files} 个文件；跳过不计为分析成功，不能视为审查通过。`] : []),
          ...(scannedFiles < totalFiles ? [`DeepAudit 有 ${totalFiles - scannedFiles} 个文件未成功分析，不能视为全量通过。`] : []),
          ...(totalFiles === 0 ? ['DeepAudit 未分析任何文件，检查支持语言、排除规则和模型配置。'] : [])] };
  }

  async run(input: {
    taskId: string; zip: Buffer; signal: AbortSignal; excludePatterns: string[]; engineTaskId?: string; retryFailed?: boolean;
    onProgress: (progress: { phase: string; totalFiles: number; scannedFiles: number; engineTaskId?: string;
      processedFiles?: number; failedFiles?: number; skippedFiles?: number }) => Promise<void>;
    audit: CodeReviewAudit;
  }): Promise<CodeReviewEngineResult> {
    input.signal.throwIfAborted();
    let preparedUpload: FormData | undefined;
    if (!input.engineTaskId || input.retryFailed) {
      // Do CPU-heavy verification/enumeration before opening an upstream keepalive connection.
      // Explicit retries may need a legacy resubmission; ordinary tracking must never reparse its snapshot.
      const snapshot = await readCodeReviewSnapshot(input.zip);
      preparedUpload = new FormData();
      preparedUpload.set('file', new Blob([new Uint8Array(input.zip)], { type: 'application/zip' }), 'snapshot.zip');
      // CDS already applied boundary-based exclusions; explicit targets bypass legacy sampling.
      preparedUpload.set('scan_config', JSON.stringify({ exclude_patterns: [], max_analyze_files: 0,
        file_paths: snapshot.files.map((file) => file.name) }));
      input.signal.throwIfAborted();
    }
    if (!this.token) await this.login(input.signal, input.audit);
    const request = this.requester(input);
    let engineTaskId = input.engineTaskId;
    try {
      if (engineTaskId && input.retryFailed) {
        const existing = await request('deepaudit.retry_status', `/tasks/${encodeURIComponent(engineTaskId)}`) as EngineTask;
        if (existing.status === 'failed' || existing.status === 'cancelled'
          || (existing.status === 'completed' && hasIncompleteFiles(existing))) {
          if (existing.resumable === true) {
            const resumed = await request('deepaudit.resume_task', `/tasks/${encodeURIComponent(engineTaskId)}/resume`, { method: 'POST' }) as { task_id?: string };
            if (resumed.task_id !== engineTaskId) throw new Error('DeepAudit 续跑返回了不同的任务编号');
          } else if (existing.checkpoint_version === 1) {
            // A checkpointed scan may still have in-flight workers or an unavailable snapshot. Never replay it as legacy.
            throw new Error('DeepAudit 原生任务暂不可续跑；已保留原任务编号，请等待当前分析收尾后重试，若仍不可用请联系管理员检查固定源码快照。');
          } else {
            // Legacy scans have no file ledger. Their explicit retries keep the fixed CDS snapshot but start a new scan.
            engineTaskId = undefined;
          }
        }
      }
      if (!engineTaskId) {
        // Separate upstream project per task prevents concurrent ZIP overwrites and isolates snapshots.
        const project = await request('deepaudit.create_project', '/projects/', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: `CDS-${input.taskId}`, source_type: 'zip', description: 'CDS 固定源码快照审查' }),
        }) as { id?: string };
        if (!project.id || typeof project.id !== 'string') throw new Error('DeepAudit 未返回项目 ID');
        const form = preparedUpload!;
        form.set('project_id', project.id);
        const scan = await request('deepaudit.submit_scan', '/scan/upload-zip', { method: 'POST', body: form }) as { task_id?: string };
        if (!scan.task_id || typeof scan.task_id !== 'string') throw new Error('DeepAudit 未返回审查任务 ID');
        engineTaskId = scan.task_id;
      }
      const taskPath = `/tasks/${encodeURIComponent(engineTaskId)}`;
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
          totalFiles, scannedFiles, engineTaskId,
          processedFiles: task.processed_files, failedFiles: task.failed_files, skippedFiles: task.skipped_files });
        if (task.status === 'completed') {
          if ((task.resumable === true || task.checkpoint_version === 1) && hasIncompleteFiles(task)) {
            throw new Error(`DeepAudit 整仓审查尚未完成（已分析 ${scannedFiles}/${totalFiles} 个文件）。已完成文件的分析结果已保留，请重试继续未完成部分；当前未形成完整代码质量结论。`);
          }
          break;
        }
        if (task.status === 'failed') {
          const reason = task.error_code && Object.hasOwn(CODE_REVIEW_ENGINE_FAILURE_REASONS, task.error_code)
            ? CODE_REVIEW_ENGINE_FAILURE_REASONS[task.error_code] : CODE_REVIEW_ENGINE_FAILURE_REASONS.ANALYSIS_FAILED;
          throw new Error(`DeepAudit 审查引擎执行失败（已分析 ${scannedFiles}/${totalFiles} 个文件），未形成代码质量结论。${reason}${task.resumable === true ? '已完成文件的分析结果已保留，重试可继续未完成部分。' : ''}`);
        }
        if (task.status === 'cancelled') throw new Error(`DeepAudit 任务已取消（已分析 ${scannedFiles}/${totalFiles} 个文件），未形成代码质量结论。`);
        await delay(this.options.pollIntervalMs ?? 2000, undefined, { signal: input.signal });
      }
      return await this.readTaskResult(task, engineTaskId, request);
    } catch (error) {
      if (engineTaskId && input.signal.aborted && !(input.signal.reason instanceof CodeReviewWorkerStoppedError)) {
        // Best-effort upstream cancellation uses an independent short timeout.
        await reviewJsonRequest('deepaudit.cancel_task', `${this.base}/tasks/${encodeURIComponent(engineTaskId)}/cancel`,
          { method: 'POST', headers: { Authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(5000) }, input.audit, this.fetchImpl).catch(() => undefined);
      }
      throw error;
    }
  }
}
