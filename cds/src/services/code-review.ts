import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import type { StateService } from './state.js';
import type { CodeReviewTask, CodeReviewEngineBinding } from '../shared/code-review.js';
import type { CodeReviewInputs } from './code-review-inputs.js';
import type { CodeReviewMail } from './code-review-mail.js';
import { CodeReviewEngine, CodeReviewWorkerStoppedError, type CodeReviewEngineResult } from './code-review-engine.js';
import { validateCodeReviewZip, fetchCodeReviewGithubSnapshot, parseCodeReviewGithubUrl } from './code-review-source.js';
import { maskSecretsInObject, maskSecrets } from './secret-masker.js';
import { CDS_AGENT_CAPABILITY_DEFINITIONS } from '../shared/agent-mission-registry.js';
import { runCodeReviewStaticAnalysis } from './code-review-static.js';
import { currentCodeReviewEngineBinding, resolveCodeReviewEngineConfig } from './code-review-settings.js';
import { CodeReviewUpstreamHttpError } from './code-review-audit.js';
import type { CodeReviewResult } from '../shared/code-review-result.js';
import { archivedCodeReviewResult, pageCodeReviewResult, sortCodeReviewFindings } from './code-review-result.js';

export class CodeReviewError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const terminal = new Set(['completed', 'failed', 'cancelled']);
function boundedTimeout(name: string, fallback: number, min: number, max: number): number {
  const configured = Number(process.env[name]);
  return Number.isFinite(configured) && configured > 0 ? Math.min(max, Math.max(min, configured)) : fallback;
}
function isTransportFailure(error: unknown): boolean {
  for (let current = error, depth = 0; current && typeof current === 'object' && depth < 4; depth++) {
    if (current instanceof CodeReviewUpstreamHttpError) return [502, 503, 504].includes(current.status);
    if (current instanceof TypeError && current.message === 'fetch failed') return true;
    const { code, cause } = current as { code?: unknown; cause?: unknown };
    if (typeof code === 'string' && ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'].includes(code)) return true;
    current = cause;
  }
  return false;
}
const clean = (value: unknown) => {
  let message = maskSecrets(String(value));
  for (const key of ['CDS_DEEPAUDIT_TOKEN', 'CDS_DEEPAUDIT_PASSWORD', 'CDS_REVIEW_SMTP_PASSWORD']) {
    const secret = process.env[key]; if (secret) message = message.split(secret).join('[凭据已脱敏]');
  }
  return message.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[邮箱已脱敏]').slice(0, 1000);
};
const text = (value: string) => value.replace(/[&<>]/g, (v) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[v]!)).replace(/([\[\]`])/g, '\\$1');

export interface CodeReviewDeps {
  state: StateService;
  inputs: CodeReviewInputs;
  mail: CodeReviewMail;
  engine?: Pick<CodeReviewEngine, 'run'> & Partial<Pick<CodeReviewEngine, 'readExisting'>>;
  publicBaseUrl: string;
  ownerScope: string;
  githubToken?: (projectId: string, githubUrl: string) => Promise<string | undefined>;
  cdsSnapshot?: (input: { projectId: string; branchId: string; branchName: string; excludePatterns: string[]; signal: AbortSignal }) => Promise<{
    zip: Buffer; commitSha: string; sourceName: string; skippedFiles: number;
  }>;
  autoStart?: boolean;
  resolveEngine?: (origin?: CodeReviewEngineBinding) => (Pick<CodeReviewEngine, 'run'> & Partial<Pick<CodeReviewEngine, 'readExisting'>>) | undefined;
}
export interface SubmitCodeReview {
  projectId: string;
  sourceType: 'github' | 'zip' | 'cds';
  branchId?: string;
  githubUrl?: string;
  ref?: string;
  zip?: Buffer;
  filename?: string;
  excludePatterns?: string[];
  email?: string;
  idempotencyKey?: string;
  createdBy: string;
  title?: string;
}

/** Persistent orchestration; one task at a time per deployment, never run repository scripts. */
export class CodeReviewService {
  private readonly auditCursorKey = randomBytes(32);
  // Immutable chain positions let original numeric-before clients continue without changing their request shape.
  private readonly auditLegacyContinuations = new Map<string, string>();
  private readonly auditAppends = new Map<string, Promise<void>>();
  private active = new Map<string, AbortController>();
  private pumping = false;
  private stopped = false;
  private started = false;
  private submissions = Promise.resolve();
  private engineProbeTimer?: ReturnType<typeof setTimeout>;
  private dispatchNotBefore = 0;
  private readingResults = new Map<string, Promise<CodeReviewResult | null>>();
  private resultReadControllers = new Map<string, AbortController>();
  private resultReadFailures = new Map<string, number>();
  private hotResult?: { key: string; result: CodeReviewResult };
  constructor(readonly deps: CodeReviewDeps) {}
  private engine(origin?: CodeReviewEngineBinding) {
    if (this.deps.engine) return this.deps.engine;
    if (this.deps.resolveEngine) return this.deps.resolveEngine(origin);
    const config = resolveCodeReviewEngineConfig(this.deps.state, process.env, origin);
    return config ? new CodeReviewEngine(config) : undefined;
  }
  assertEngineSwitchOwnership(): void {
    if (this.list().some(task => ['failed', 'cancelled'].includes(task.status) && task.engineTaskId
      && !task.engineBinding && task.ownerScope !== this.deps.ownerScope)) {
      throw new CodeReviewError(409, '其他实例的历史审查断点尚未绑定原引擎，请先在原实例核对');
    }
  }
  capabilities() {
    return { engineConfigured: Boolean(this.engine()), mailConfigured: this.deps.mail.configured(), storageConfigured: this.deps.inputs.configured(), conditionalRetry: true,
      tools: CDS_AGENT_CAPABILITY_DEFINITIONS.find((capability) => capability.id === 'code-reviews')?.mcpTools || [] };
  }
  list(projectId?: string) { return this.deps.state.listCodeReviewTasks(projectId); }
  get(id: string) {
    const task = this.deps.state.getCodeReviewTask(id);
    if (!task) throw new CodeReviewError(404, '审查任务不存在');
    return task;
  }
  /** Read existing evidence only; never creates, retries or resumes an analysis task. */
  async result(id: string, options: { offset?: number; limit?: number; severity?: string; query?: string } = {}) {
    const task = this.get(id);
    let result: CodeReviewResult | null = null;
    if (task.resultKey) {
      result = this.hotResult?.key === task.resultKey ? this.hotResult.result
        : JSON.parse((await this.deps.inputs.get(task.resultKey)).toString('utf8')) as CodeReviewResult;
      if (result.version !== 1 || result.taskId !== task.id || result.projectId !== task.projectId || !Array.isArray(result.findings)) {
        throw new CodeReviewError(502, '结果记录无法读取，请重试或查看原始报告');
      }
      this.hotResult = { key: task.resultKey, result };
    } else if (task.reportId && task.sourceType !== 'report') {
      const meta = this.deps.state.getAcceptanceReport(task.reportId);
      if (meta?.projectId === task.projectId && meta.format === 'md') {
        const content = await this.deps.state.readAcceptanceReportContentAsync(meta.id);
        if (content) result = archivedCodeReviewResult(task, content);
      }
    }
    if (!result && task.sourceType !== 'report' && task.engineTaskId && terminal.has(task.status)) {
      const engine = this.engine(task.engineBinding);
      if (engine?.readExisting && !this.stopped) {
        let reading = this.readingResults.get(id);
        const failedAt = this.resultReadFailures.get(id);
        if (!reading && (failedAt === undefined || Date.now() - failedAt >= 15_000)) {
          const controller = new AbortController();
          const engineTaskId = task.engineTaskId;
          this.resultReadControllers.set(id, controller);
          this.resultReadFailures.delete(id);
          reading = (async () => {
            const upstream = await engine.readExisting!(engineTaskId, {
              signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15 * 60_000)]), audit: event => this.audit(id, event),
            });
            if (!upstream || controller.signal.aborted || this.stopped) return null;
            const saved: CodeReviewResult = { version: 1, taskId: id, projectId: task.projectId, sourceHash: task.sourceHash,
              commitSha: task.commitSha, origin: 'analysis', findings: sortCodeReviewFindings(upstream.findings),
              notes: [...upstream.notes, '读取已停止任务的既有结果，未重新执行分析。任务失败或取消状态保持原样。'] };
            const key = await this.deps.inputs.put(`${id}-existing-result-v1`, task.projectId, Buffer.from(JSON.stringify(saved)));
            const current = this.get(id);
            if (current.engineTaskId === engineTaskId && terminal.has(current.status) && !current.resultKey && !controller.signal.aborted && !this.stopped) {
              // Cancellation can arrive before the last in-flight files finish. Read-only
              // recovery must report the native checkpoint counts, while preserving status.
              if (Number.isSafeInteger(upstream.totalFiles) && upstream.totalFiles >= 0
                && Number.isSafeInteger(upstream.scannedFiles) && upstream.scannedFiles >= 0
                && upstream.scannedFiles <= upstream.totalFiles
                && (current.progress.totalFiles === 0 || upstream.totalFiles === current.progress.totalFiles)
                && upstream.scannedFiles >= current.progress.scannedFiles) {
                current.progress = { totalFiles: upstream.totalFiles, scannedFiles: upstream.scannedFiles };
              }
              current.resultKey = key;
              current.findingsSummary = {};
              for (const finding of saved.findings) current.findingsSummary[finding.severity] = (current.findingsSummary[finding.severity] || 0) + 1;
              await this.deps.state.putCodeReviewTask(current);
              this.hotResult = { key, result: saved };
            }
            return saved;
          })();
          this.readingResults.set(id, reading);
          // Cold imports can exceed an HTTP/MCP request deadline. Keep one read-only
          // import running and let clients poll; never leave a rejected promise unobserved.
          void reading.catch(() => { if (!controller.signal.aborted) this.resultReadFailures.set(id, Date.now()); }).finally(() => {
            this.readingResults.delete(id); this.resultReadControllers.delete(id);
          });
        }
      }
    }
    const url = new URL('/code-reviews', this.deps.publicBaseUrl);
    url.searchParams.set('project', task.projectId); url.searchParams.set('task', id);
    if (task.reportId) url.searchParams.set('report', '1');
    const resultLoading = !result && this.readingResults.has(id);
    return { result: result ? pageCodeReviewResult(task, result, options) : null, resultLoading, reportUrl: url.href,
      downloadUrl: task.reportId || result ? new URL(`/api/code-reviews/${encodeURIComponent(id)}/report/download`, this.deps.publicBaseUrl).href : null,
      resultUnavailableReason: result ? undefined : resultLoading
        ? '正在整理引擎中的已有问题，完成后自动显示，不会重新执行审查。'
        : this.resultReadFailures.has(id) ? '已有问题暂时未能整理完成，请稍后重新读取。审查任务状态保持不变。' : task.sourceType === 'report'
        ? '这是导入的原始报告，请阅读原文。未将文档声明当作实际扫描结果。'
        : task.reportId ? '历史报告未保存可完整还原的问题数据，请阅读原始报告。' : '本次审查尚无已保存的问题明细，请查看当前进度。' };
  }
  async exportPartialResult(id: string): Promise<string> {
    const read = await this.result(id);
    const task = this.get(id);
    if (!read.result || !task.resultKey) throw new CodeReviewError(404, '报告尚未归档，也没有可下载的已保存结果');
    const result = JSON.parse((await this.deps.inputs.get(task.resultKey)).toString('utf8')) as CodeReviewResult;
    if (result.taskId !== id || result.projectId !== task.projectId) throw new CodeReviewError(502, '结果记录无法读取，请重试');
    return ['# 部分代码审查结果', '', '本次审查尚未完成。以下为已保存的分析发现，不代表全仓通过，也未改变任务状态或生成完成报告。', '',
      renderCodeReviewReport(task, { findings: result.findings, totalFiles: task.progress.totalFiles, scannedFiles: task.progress.scannedFiles,
        skippedFiles: task.inputSkippedFiles || 0, notes: result.notes, engineTaskId: task.engineTaskId || '' })].join('\n');
  }
  private async save(task: CodeReviewTask) {
    const current = this.deps.state.getCodeReviewTask(task.id);
    if (current?.status === 'cancelled' && !['cancelled', 'queued'].includes(task.status)) throw new CodeReviewError(409, '任务已取消');
    task.updatedAt = new Date().toISOString();
    await this.deps.state.putCodeReviewTask(task);
  }
  private assertOwned(task: CodeReviewTask) {
    if (task.ownerScope !== this.deps.ownerScope) throw new CodeReviewError(409, '请在创建该任务的 CDS 实例操作');
  }
  async submit(input: SubmitCodeReview): Promise<CodeReviewTask> {
    let release!: () => void;
    const previous = this.submissions;
    this.submissions = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await this.submitLocked(input); } finally { release(); }
  }
  private async submitLocked(input: SubmitCodeReview): Promise<CodeReviewTask> {
    if (!this.engine()) throw new CodeReviewError(503, 'DeepAudit 尚未配置，请联系管理员接入审查引擎');
    if (!this.deps.inputs.configured()) throw new CodeReviewError(503, '尚未配置审查源码的持久化对象存储');
    if (!this.deps.state.getProject(input.projectId)) throw new CodeReviewError(404, '项目不存在');
    if (input.email && (!/^[^\s@<>\r\n]+@[^\s@<>\r\n]+\.[^\s@<>\r\n]+$/.test(input.email) || input.email.length > 254)) throw new CodeReviewError(400, '收件邮箱格式不正确');
    if (input.email && !this.deps.mail.configured()) throw new CodeReviewError(503, '邮件通道未配置，请选择仅报告中心');
    if (input.excludePatterns && (!Array.isArray(input.excludePatterns) || input.excludePatterns.length > 100 || input.excludePatterns.some((p) => typeof p !== 'string' || p.length > 200))) throw new CodeReviewError(400, '排除目录格式不正确');
    if (input.ref && (typeof input.ref !== 'string' || input.ref.length > 255 || /[\r\n\0]/.test(input.ref))) throw new CodeReviewError(400, '仓库版本格式不正确');
    const branch = input.sourceType === 'cds' ? this.deps.state.getBranch(input.branchId || '') : undefined;
    if (input.sourceType !== 'cds' && input.branchId) throw new CodeReviewError(400, '只有 CDS 来源接受分支 ID');
    if (input.sourceType === 'cds') {
      if (!branch || branch.projectId !== input.projectId) throw new CodeReviewError(403, '所选分支不属于当前项目');
      if (branch.deleting || branch.mirror) throw new CodeReviewError(409, '所选分支正在删除或属于其他实例，请重新选择');
      if (!this.deps.cdsSnapshot) throw new CodeReviewError(503, '当前实例尚未配置 CDS 分支源码读取');
      if (input.zip || input.githubUrl || input.ref) throw new CodeReviewError(400, 'CDS 分支来源只接受当前项目的分支 ID');
    } else if (input.sourceType === 'github') {
      try { parseCodeReviewGithubUrl(input.githubUrl || ''); } catch (error) { throw new CodeReviewError(400, (error as Error).message); }
    } else if (input.sourceType !== 'zip' || !input.zip?.length) throw new CodeReviewError(400, '请上传 ZIP 源码包');
    const idempotencyKey = createHash('sha256').update(JSON.stringify({ projectId: input.projectId, sourceType: input.sourceType,
      githubUrl: input.githubUrl, ref: input.ref, branchId: input.branchId, hash: input.zip ? createHash('sha256').update(input.zip).digest('hex') : undefined,
      exclude: input.excludePatterns || [], email: input.email || '', key: input.idempotencyKey || '' })).digest('hex');
    // Without an explicit key, only deduplicate in-flight work; finished reviews can be requested again.
    const existing = this.list(input.projectId).find((t) => t.idempotencyKey === idempotencyKey && t.ownerScope === this.deps.ownerScope
      && (input.idempotencyKey || !terminal.has(t.status)));
    if (existing) return existing;
    const now = new Date().toISOString();
    const task: CodeReviewTask = { id: randomUUID().replace(/-/g, ''), projectId: input.projectId, title: input.title?.trim().slice(0, 300) || '代码审查报告',
      sourceType: input.sourceType, sourceName: branch ? `CDS · ${branch.branch}` : input.sourceType === 'github' ? input.githubUrl! : (input.filename || 'source.zip').slice(0, 200),
      branchId: branch?.id, branchName: branch?.branch,
      githubUrl: input.githubUrl, ref: input.ref, excludePatterns: input.excludePatterns || [], status: 'queued', phase: '等待审查',
      progress: { totalFiles: 0, scannedFiles: 0 }, delivery: { status: input.email ? 'pending' : 'not_requested', email: input.email },
      createdBy: input.createdBy, createdAt: now, updatedAt: now, ownerScope: this.deps.ownerScope, idempotencyKey };
    if (input.zip) {
      const validated = await validateCodeReviewZip(input.zip, task.excludePatterns).catch((error: Error) => { throw new CodeReviewError(400, error.message); });
      task.sourceHash = createHash('sha256').update(input.zip).digest('hex');
      task.progress.totalFiles = validated.totalFiles;
      task.inputSkippedFiles = validated.skippedFiles;
      task.inputKey = await this.deps.inputs.put(task.id, task.projectId, validated.zip);
    }
    await this.save(task);
    if (this.deps.autoStart !== false) void this.pump();
    return task;
  }
  async start() {
    if (this.started) return;
    this.started = true;
    for (const task of this.list().filter((t) => t.ownerScope === this.deps.ownerScope)) {
      if (task.delivery.status === 'sending') {
        task.delivery.status = 'failed'; task.delivery.error = '发送期间实例重启，投递结果未知，请核对邮箱后重试';
        await this.save(task);
      } else if (task.status === 'completed' && task.reportId && task.delivery.status === 'pending') {
        task.delivery.status = 'failed'; task.delivery.error = '报告已归档，但投递尚未开始，请手动重试邮件';
        await this.save(task);
      }
      if (!terminal.has(task.status) && task.status !== 'queued' && !task.engineTaskId) {
        task.status = 'failed'; task.phase = '审查中断'; task.error = '实例重启时未取得引擎任务编号，请重试';
        await this.save(task);
      }
    }
    void this.pump();
  }
  stop() {
    this.stopped = true;
    if (this.engineProbeTimer) clearTimeout(this.engineProbeTimer);
    this.engineProbeTimer = undefined;
    for (const controller of this.active.values()) controller.abort(new CodeReviewWorkerStoppedError('CDS 实例停止跟踪'));
    for (const controller of this.resultReadControllers.values()) controller.abort(new CodeReviewWorkerStoppedError('CDS 实例停止读取已有结果'));
  }
  async cancel(id: string) {
    const task = this.get(id); this.assertOwned(task);
    if (terminal.has(task.status) || task.status === 'archiving') throw new CodeReviewError(409, '任务已结束或正在归档');
    task.status = 'cancelled'; task.phase = '已取消';
    await this.save(task);
    this.active.get(id)?.abort();
    return task;
  }
  async retry(id: string, expectedUpdatedAt?: string) {
    const task = this.get(id); this.assertOwned(task);
    if (expectedUpdatedAt !== undefined && (task.status !== 'failed' || task.updatedAt !== expectedUpdatedAt)) {
      throw new CodeReviewError(409, '任务状态已变化，未执行条件重试，请刷新后查看');
    }
    if (!['failed', 'cancelled'].includes(task.status) || this.active.has(id)) throw new CodeReviewError(409, '仅可重试已停止的失败或取消任务');
    if (task.reportId) throw new CodeReviewError(409, '报告已归档，请单独重试邮件投递');
    task.status = 'queued'; task.phase = '等待重试'; task.error = undefined;
    task.resultKey = undefined; task.findingsSummary = undefined;
    if (this.hotResult?.result.taskId === id) this.hotResult = undefined;
    this.resultReadFailures.delete(id);
    this.resultReadControllers.get(id)?.abort(new CodeReviewWorkerStoppedError('审查任务已由用户重试'));
    task.engineRetryRequested = Boolean(task.engineTaskId && !task.engineCompleted);
    if (!task.engineTaskId) task.progress.scannedFiles = 0;
    // No await separates the conditional check from StateService's synchronous in-memory replacement before flush.
    await this.save(task); if (this.deps.autoStart !== false) void this.pump(); return task;
  }
  private async audit(id: string, value: unknown) {
    const safe = maskSecretsInObject(value) as Record<string, unknown>;
    let release!: () => void;
    const previous = this.auditAppends.get(id);
    const appended = new Promise<void>(resolve => { release = resolve; });
    this.auditAppends.set(id, appended);
    await previous;
    try {
      // Cancellation and existing-result reads can overlap; serialize the whole linked append per task.
      const task = this.get(id);
      const sequence = (task.auditCount || 0) + 1;
      const key = await this.deps.inputs.put(`${id}-audit-${randomUUID()}`, task.projectId,
        Buffer.from(JSON.stringify({ sequence, event: safe, previousKey: task.auditHeadKey })));
      const current = this.get(id);
      current.auditHeadKey = key; current.auditCount = sequence;
      current.audit = [...(current.audit || []), safe].slice(-20);
      await this.save(current);
    } finally {
      release();
      if (this.auditAppends.get(id) === appended) this.auditAppends.delete(id);
    }
  }
  async auditPage(id: string, before?: number, cursor?: string) {
    const task = this.get(id);
    const events: unknown[] = [];
    let key = task.auditHeadKey;
    if (cursor !== undefined) {
      try {
        if (!/^[A-Za-z0-9_-]{48,4096}$/.test(cursor)) throw new Error('invalid cursor');
        const bytes = Buffer.from(cursor, 'base64url');
        const decipher = createDecipheriv('aes-256-gcm', this.auditCursorKey, bytes.subarray(0, 12));
        decipher.setAuthTag(bytes.subarray(12, 28));
        const value = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'));
        if (value.taskId !== id || value.projectId !== task.projectId || typeof value.key !== 'string' || !value.key
          || !Number.isSafeInteger(value.before) || value.before < 1 || before !== undefined && before !== value.before) throw new Error('scope mismatch');
        key = value.key; before = value.before;
      } catch { throw new CodeReviewError(400, '审计分页游标无效或已失效，请从第一页重新读取'); }
    } else if (before !== undefined) {
      key = this.auditLegacyContinuations.get(JSON.stringify([id, task.projectId, before])) ?? key;
    }
    let examined = 0;
    let nextBefore = before;
    while (key && examined++ < 4000) {
      const item = JSON.parse((await this.deps.inputs.get(key)).toString('utf8')) as { sequence: number; event: unknown; previousKey?: string };
      if (!Number.isSafeInteger(item.sequence) || item.sequence < 1) throw new CodeReviewError(500, '审计证据序号无效，请核对原记录');
      key = item.previousKey;
      if (before && item.sequence >= before) continue;
      events.push(item.event);
      nextBefore = item.sequence;
      if (events.length >= 100) break;
    }
    let nextCursor: string | undefined;
    if (key) {
      if (nextBefore !== undefined) {
        const hint = JSON.stringify([id, task.projectId, nextBefore]);
        this.auditLegacyContinuations.delete(hint);
        this.auditLegacyContinuations.set(hint, key);
        // Hints are disposable, not evidence: after eviction/restart a deep seek resumes the bounded walk.
        if (this.auditLegacyContinuations.size > 256) {
          this.auditLegacyContinuations.delete(this.auditLegacyContinuations.keys().next().value!);
        }
      }
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.auditCursorKey, iv);
      const payload = Buffer.from(JSON.stringify({ taskId: id, projectId: task.projectId, key, before: nextBefore }));
      const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
      nextCursor = Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
    }
    return { events, nextBefore: key ? nextBefore : undefined, nextCursor };
  }
  async pump(): Promise<void> {
    if (this.pumping || this.stopped) return;
    if (this.engineProbeTimer) clearTimeout(this.engineProbeTimer);
    this.engineProbeTimer = undefined;
    this.pumping = true;
    try {
      for (;;) {
        if (this.stopped) return;
        // Keep insertion order when submissions share a millisecond; reverse() inverts those ties.
        const next = this.list().sort((a, b) => a.createdAt.localeCompare(b.createdAt))
          .find((t) => t.ownerScope === this.deps.ownerScope && !terminal.has(t.status));
        if (!next) return;
        const cooldownMs = this.dispatchNotBefore - Date.now();
        if (cooldownMs > 0) { this.probeAfter(cooldownMs); return; }
        // A branch update can temporarily remove its runtime between tasks. Keep those tasks intact.
        const origin = next.engineTaskId ? next.engineBinding || currentCodeReviewEngineBinding(this.deps.state)
          : currentCodeReviewEngineBinding(this.deps.state);
        const engine = this.engine(origin);
        if (!engine) {
          this.probeAfter(5000);
          return;
        }
        await this.execute(next.id, engine, origin);
      }
    } finally { this.pumping = false; }
  }
  private probeAfter(delayMs: number) {
    this.engineProbeTimer = setTimeout(() => { this.engineProbeTimer = undefined; void this.pump(); }, delayMs);
    this.engineProbeTimer.unref();
  }
  private async execute(id: string, engine: Pick<CodeReviewEngine, 'run'>, origin?: CodeReviewEngineBinding) {
    const controller = new AbortController(); this.active.set(id, controller);
    const hour = 60 * 60 * 1000;
    const maxDuration = boundedTimeout('CDS_CODE_REVIEW_MAX_DURATION_MS', 7 * 24 * hour, hour, 14 * 24 * hour);
    const idleDuration = boundedTimeout('CDS_CODE_REVIEW_IDLE_TIMEOUT_MS', 30 * 60 * 1000, 60_000, 6 * hour);
    const timeout = setTimeout(() => controller.abort(new Error('审查达到配置的最长执行时间，未完成部分请重试')), maxDuration);
    timeout.unref();
    let idleTimeout: ReturnType<typeof setTimeout>;
    const refreshIdle = () => {
      if (idleTimeout) clearTimeout(idleTimeout);
      idleTimeout = setTimeout(() => controller.abort(new Error('审查长时间没有文件分析进展，未完成部分请重试')), idleDuration);
      idleTimeout.unref();
    };
    refreshIdle();
    try {
      let task = this.get(id);
      task.status = 'preparing'; task.phase = '准备固定源码快照'; await this.save(task);
      if (!task.inputKey) {
        const snapshot = task.sourceType === 'cds' ? await this.deps.cdsSnapshot!({ projectId: task.projectId,
          branchId: task.branchId!, branchName: task.branchName!, excludePatterns: task.excludePatterns, signal: controller.signal })
          : await fetchCodeReviewGithubSnapshot({ githubUrl: task.githubUrl!, ref: task.ref,
          token: await this.deps.githubToken?.(task.projectId, task.githubUrl!), signal: controller.signal,
          audit: async (e) => this.audit(id, e) });
        const validated = await validateCodeReviewZip(snapshot.zip, task.excludePatterns, task.sourceType !== 'cds');
        const sourceHash = createHash('sha256').update(snapshot.zip).digest('hex');
        if (task.sourceType === 'cds') await this.audit(id, { operation: 'cds.branch_snapshot', outcome: 'success',
          branchId: task.branchId, branchName: task.branchName, commitSha: snapshot.commitSha, sourceHash });
        task = this.get(id); this.checkActive(task, controller.signal);
        task.commitSha = snapshot.commitSha; task.sourceHash = sourceHash;
        task.sourceName = snapshot.sourceName; task.progress.totalFiles = validated.totalFiles;
        task.inputSkippedFiles = validated.skippedFiles + ('skippedFiles' in snapshot && typeof snapshot.skippedFiles === 'number' ? snapshot.skippedFiles : 0);
        task.inputKey = await this.deps.inputs.put(id, task.projectId, validated.zip);
        await this.save(task);
      }
      const zip = await this.deps.inputs.get(task.inputKey!);
      const selectedFiles = task.progress.totalFiles;
      let lastCounts = [-1, -1, -1, -1, -1], lastEngineTaskId: string | undefined;
      const result = await engine.run({ taskId: id, zip, signal: controller.signal, excludePatterns: task.excludePatterns,
        engineTaskId: task.engineTaskId, retryFailed: task.engineRetryRequested,
        onProgress: async (p) => {
          const current = this.get(id); this.checkActive(current, controller.signal);
          // Failed/skipped files also represent completed work; repeated HTTP polls do not.
          const counts = [p.scannedFiles, p.totalFiles, p.processedFiles ?? -1, p.failedFiles ?? -1, p.skippedFiles ?? -1];
          if (counts.some((count, index) => count > lastCounts[index]) || (p.engineTaskId && p.engineTaskId !== lastEngineTaskId)) refreshIdle();
          lastCounts = counts.map((count, index) => Math.max(count, lastCounts[index]));
          if (p.engineTaskId) lastEngineTaskId = p.engineTaskId;
          current.engineRetryRequested = undefined; // One explicit retry request is consumed once tracking starts.
          const newEngineTask = p.engineTaskId && current.engineTaskId && p.engineTaskId !== current.engineTaskId;
          current.status = 'running'; current.phase = p.phase; current.progress = { totalFiles: Math.max(current.progress.totalFiles, p.totalFiles),
            scannedFiles: newEngineTask ? p.scannedFiles : Math.max(current.progress.scannedFiles, p.scannedFiles) };
          if (p.engineTaskId) {
            // A legacy ID can be announced before its first GET. Never infer its origin from that announcement.
            if (origin && (current.engineBinding || current.engineTaskId !== p.engineTaskId || p.engineIdentityConfirmed)) current.engineBinding = origin;
            current.engineTaskId = p.engineTaskId;
          }
          await this.save(current);
        }, audit: async (e) => this.audit(id, e) });
      task = this.get(id); this.checkActive(task, controller.signal);
      task.engineTaskId = result.engineTaskId;
      task.engineBinding = origin;
      if (selectedFiles > 0 && result.scannedFiles === 0) {
        task.engineCompleted = false; // A manual retry must start a new analysis, not reuse the empty result.
        task.engineTaskId = undefined;
        task.engineBinding = undefined;
        await this.save(task);
        throw new CodeReviewError(502, `审查引擎未成功分析任何文件（已分析 0/${selectedFiles} 个文件），未形成代码质量结论。请联系管理员检查模型服务与引擎日志后重试。`);
      }
      task.engineCompleted = true; task.engineRetryRequested = undefined;
      task.phase = '汇总静态检查与 AI 分析'; await this.save(task);
      const staticResult = await runCodeReviewStaticAnalysis({ zip, signal: controller.signal });
      result.findings.push(...staticResult.findings); result.notes.push(...staticResult.notes);
      if (result.totalFiles < selectedFiles) result.notes.push(`提交了 ${selectedFiles} 个合格源码文件，引擎仅选择 ${result.totalFiles} 个；未覆盖部分不能视为审查通过。`);
      result.totalFiles = Math.max(result.totalFiles, selectedFiles);
      result.skippedFiles = (task.inputSkippedFiles || 0) + Math.max(0, result.totalFiles - result.scannedFiles);
      task.engineTaskId = result.engineTaskId; task.status = 'archiving'; task.phase = '正在归档报告'; await this.save(task);
      const structured: CodeReviewResult = { version: 1, taskId: id, projectId: task.projectId, sourceHash: task.sourceHash,
        commitSha: task.commitSha, origin: 'analysis', findings: sortCodeReviewFindings(result.findings), notes: result.notes };
      task.resultKey = await this.deps.inputs.put(`${id}-result-v1`, task.projectId, Buffer.from(JSON.stringify(structured)));
      await this.save(task);
      const found = this.deps.state.listAcceptanceReports(task.projectId).find((r) => r.reviewTaskId === id);
      const report = found || await this.deps.state.createAcceptanceReportAsync({
        title: `代码审查报告 · ${task.sourceName}${task.commitSha ? `@${task.commitSha.slice(0, 8)}` : ''} · ${new Date().toISOString().slice(0, 10)}`,
        format: 'md', content: renderCodeReviewReport(task, result), reportType: 'code-review', reviewTaskId: id,
        projectId: task.projectId, branch: task.branchName, commitSha: task.commitSha, createdBy: task.createdBy,
        contentHash: task.sourceHash, sourceId: `code-review:${id}`,
      });
      task = this.get(id); this.checkActive(task, controller.signal);
      task.reportId = report.id; task.status = 'completed';
      task.phase = result.scannedFiles < result.totalFiles ? '部分文件未完成分析，报告已归档' : '审查完成，报告已归档';
      task.progress = { totalFiles: result.totalFiles, scannedFiles: result.scannedFiles };
      task.findingsSummary = {};
      for (const finding of result.findings) task.findingsSummary[finding.severity] = (task.findingsSummary[finding.severity] || 0) + 1;
      await this.save(task);
      if (task.delivery.status === 'pending') await this.deliver(id);
    } catch (error) {
      const task = this.get(id);
      if (this.stopped) return; // persisted upstream id lets the next process resume safely
      if (task.status !== 'cancelled') {
        const failure = controller.signal.aborted ? controller.signal.reason : error;
        task.status = 'failed'; task.phase = '审查失败'; task.error = clean(failure instanceof Error ? failure.message : failure); await this.save(task);
        // A stale serving-runtime URL can still be marked running during replacement. Avoid draining its queue.
        if (!controller.signal.aborted && isTransportFailure(error)) this.dispatchNotBefore = Date.now() + 30_000;
      }
    } finally { clearTimeout(timeout); clearTimeout(idleTimeout!); this.active.delete(id); }
  }
  private checkActive(task: CodeReviewTask, signal: AbortSignal) {
    signal.throwIfAborted();
    if (task.status === 'cancelled') throw new Error('审查已取消');
  }
  async deliver(id: string) {
    let task = this.get(id); this.assertOwned(task);
    if (task.status !== 'completed' || !task.reportId || !task.delivery.email) throw new CodeReviewError(409, '任务尚未归档或未选择邮件');
    if (!['pending', 'failed'].includes(task.delivery.status)) throw new CodeReviewError(409, '邮件已发送或正在发送');
    task.delivery.status = 'sending'; task.delivery.error = undefined; task.delivery.attempts = (task.delivery.attempts || 0) + 1;
    await this.save(task);
    try {
      const markdown = await this.deps.state.readAcceptanceReportContentAsync(task.reportId);
      if (!markdown) throw new Error('报告正文不可读取');
      const url = new URL('/code-reviews', this.deps.publicBaseUrl);
      url.searchParams.set('project', task.projectId); url.searchParams.set('task', id);
      await this.deps.mail.send({ to: task.delivery.email!, title: '代码审查报告', url: url.href, markdown, taskId: id, audit: async (event) => this.audit(id, event) });
      task = this.get(id); task.delivery.status = 'sent';
    } catch (error) { task = this.get(id); task.delivery.status = 'failed'; task.delivery.error = clean((error as Error).message); }
    await this.save(task); return task;
  }
}

export function renderCodeReviewReport(task: CodeReviewTask, result: CodeReviewEngineResult): string {
  const priorities: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  const findings = [...result.findings].sort((a, b) => priorities[a.severity] - priorities[b.severity]);
  const categories = { bug: 'Bug', security: '安全', performance: '性能', style: '风格', maintainability: '可维护性' };
  const modules = new Map<string, number>();
  for (const finding of findings) {
    const module = finding.filePath.includes('/') ? finding.filePath.split('/')[0] : '根目录';
    modules.set(module, (modules.get(module) || 0) + 1);
  }
  return [ '# 代码审查报告', '', `对象：${text(task.sourceName)}`, `任务：${task.id}`, `提交：${task.commitSha || 'ZIP 上传，无 Git 提交信息'}`,
    `源码 SHA-256：${task.sourceHash || '未知'}`, '',
    '## 审查结论', '', `共发现 ${findings.length} 项待核实问题。审查覆盖 ${result.scannedFiles}/${result.totalFiles} 个文件，跳过 ${result.skippedFiles} 个文件。`,
    '本报告采用静态与 AI 分析，未执行项目代码或动态 PoC；没有发现问题不代表不存在缺陷。', '',
    '## 五维分布', '', ...Object.entries(categories).map(([key, label]) => `- ${label}：${findings.filter((f) => f.category === key).length} 项发现`), '',
    '## 模块明细', '', ...[...modules].map(([module, count]) => `- ${text(module)}：${count} 项发现`), '',
    '## 检查覆盖', '', '维度：Bug、安全、性能、风格、可维护性。',
    ...result.notes.map((note) => `- ${text(note)}`), '', '## 问题与修复优先级', '',
    ...findings.flatMap((f, i) => [`### ${i + 1}. [${f.severity}] ${text(f.category)}`, '',
      `位置：${text(f.filePath)}${f.line ? `:${f.line}` : ''}；工具：${text(f.tool)}；状态：待验证`, '',
      text(f.message), '', `修复建议：${text(f.suggestion || '结合业务语义核实后修复')}`, '']),
    '## 审查边界', '', '排除项：依赖、第三方副本、构建产物、版本库和敏感配置。',
    `自定义排除：${task.excludePatterns.map(text).join('、') || '无'}`, '',
    '本报告独立于功能验收和发布门禁，不作为功能测试通过的证据。', '',
  ].join('\n');
}
