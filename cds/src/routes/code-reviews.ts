import { Router, json, raw, type Request, type Response } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import type { StateService } from '../services/state.js';
import { CodeReviewService, CodeReviewError } from '../services/code-review.js';
import { publicCodeReviewTask, type CodeReviewTask } from '../shared/code-review.js';
import { assertProjectAccess } from './projects.js';
import { canHumanAccessProject } from '../services/human-project-access.js';
import { resolveActorFromRequest } from '../services/actor-resolver.js';
import { maskSecrets } from '../services/secret-masker.js';
import { assertUnscopedAdmin } from '../services/unscoped-admin-guard.js';
import { isHumanSystemOwner, type HumanAuthContext } from '../services/human-auth.js';
import { validateCodeReviewSettings } from '../services/code-review-settings.js';

interface ReviewRequest extends Request, HumanAuthContext {
  cdsProjectKey?: { projectId: string; keyId: string };
  cdsAccess?: Parameters<typeof assertProjectAccess>[0]['cdsAccess'];
}
const MAX_ZIP = 100 * 1024 * 1024;
const MAX_REPORT = 10 * 1024 * 1024;
async function body(req: Request): Promise<{ fields: Record<string, unknown>; file?: Buffer; filename?: string }> {
  if (!req.is('multipart/form-data')) return { fields: req.body || {} };
  const data = await new Response(new Uint8Array(req.body as Buffer), { headers: { 'content-type': req.get('content-type')! } }).formData();
  const fields: Record<string, unknown> = {};
  let file: Buffer | undefined, filename: string | undefined;
  for (const [key, value] of data.entries()) {
    if (typeof value === 'string') { if (Object.hasOwn(fields, key)) throw new CodeReviewError(400, '表单字段不能重复'); fields[key] = value; }
    else {
      if (file || key !== 'file') throw new CodeReviewError(400, '请只上传一个 file 文件');
      file = Buffer.from(await value.arrayBuffer()); filename = value.name;
    }
  }
  if (typeof fields.excludePatterns === 'string') {
    try { fields.excludePatterns = JSON.parse(fields.excludePatterns); } catch { throw new CodeReviewError(400, '排除目录必须是 JSON 数组'); }
  }
  return { fields, file, filename };
}

export function createCodeReviewsRouter({ state, service }: { state: StateService; service: CodeReviewService }): Router {
  const router = Router();
  router.use('/code-reviews', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  let importing = Promise.resolve();
  const parse = [raw({ type: 'multipart/form-data', limit: MAX_ZIP + 1024 * 1024 }), json({ limit: '12mb' })];
  const access = (req: ReviewRequest, projectId: string) => {
    const denied = assertProjectAccess(req, projectId);
    if (denied || !canHumanAccessProject(req, state, projectId)) throw new CodeReviewError(403, '无权访问该项目的代码审查');
    if (!state.getProject(projectId)) throw new CodeReviewError(404, '项目不存在');
  };
  const project = (req: ReviewRequest, value: unknown): string => {
    const id = typeof value === 'string' && value ? value : req.cdsProjectKey?.projectId;
    if (!id) throw new CodeReviewError(400, '请选择所属项目');
    access(req, id); return id;
  };
  const taskFor = (req: ReviewRequest) => { const task = service.get(req.params.id); access(req, task.projectId); return task; };
  const handler = (fn: (req: ReviewRequest, res: Response) => Promise<unknown> | unknown) => (req: Request, res: Response) => {
    Promise.resolve().then(() => fn(req, res)).catch((error) => {
      const status = error instanceof CodeReviewError ? error.status : 500;
      res.status(status).json({ error: status === 500 ? 'review_error' : 'invalid_review_request', message: maskSecrets((error as Error).message).slice(0, 1000) });
    });
  };
  const settingsAdmin = (req: ReviewRequest) => {
    const denied = assertUnscopedAdmin(req);
    if (denied || (req.cdsUser && !isHumanSystemOwner(req))) throw new CodeReviewError(403, '仅限系统管理员配置审查引擎');
  };
  const settingsSummary = () => ({ ...state.getCodeReviewSettings(), engineConfigured: service.capabilities().engineConfigured });
  router.get('/code-reviews/settings', handler((req, res) => {
    settingsAdmin(req);
    return res.json(settingsSummary());
  }));
  router.put('/code-reviews/settings', json({ limit: '8kb' }), handler(async (req, res) => {
    settingsAdmin(req);
    let settings;
    try { settings = validateCodeReviewSettings(state, req.body); }
    catch (error) { throw new CodeReviewError(400, (error as Error).message); }
    const previous = state.getCodeReviewSettings();
    if ((previous?.engineBaseUrl !== settings.engineBaseUrl || previous?.engineProjectId !== settings.engineProjectId
      || previous?.engineBranchId !== settings.engineBranchId || previous?.engineServiceId !== settings.engineServiceId)
      && service.list().some((task) => !['completed', 'failed', 'cancelled'].includes(task.status))) {
      throw new CodeReviewError(409, '存在未结束的审查任务，请完成或取消后再切换审查引擎');
    }
    await state.setCodeReviewSettings(settings);
    void service.pump();
    return res.json(settingsSummary());
  }));
  router.get('/code-reviews/capabilities', handler((_req, res) => res.json(service.capabilities())));
  router.get('/code-reviews', handler((req, res) => {
    if (req.query.projectId !== undefined) project(req, req.query.projectId);
    const tasks = service.list(typeof req.query.projectId === 'string' ? req.query.projectId : req.cdsProjectKey?.projectId)
      .filter((task) => !assertProjectAccess(req, task.projectId) && canHumanAccessProject(req, state, task.projectId));
    return res.json({ tasks: tasks.map(publicCodeReviewTask) });
  }));
  router.post('/code-reviews', ...parse, handler(async (req, res) => {
    const { fields, file, filename } = await body(req);
    const projectId = project(req, fields.projectId);
    if (file && (file.length > MAX_ZIP || !filename?.toLowerCase().endsWith('.zip'))) throw new CodeReviewError(400, '仅支持 100MiB 以内的 ZIP 文件');
    const sourceType = fields.sourceType;
    if (sourceType !== 'github' && sourceType !== 'zip') throw new CodeReviewError(400, '请选择 ZIP 或 GitHub 来源');
    if (sourceType === 'github' && file) throw new CodeReviewError(400, 'GitHub 来源不能同时上传 ZIP');
    const task = await service.submit({ projectId, sourceType, zip: file, filename,
      title: typeof fields.title === 'string' ? fields.title : undefined,
      githubUrl: typeof fields.githubUrl === 'string' ? fields.githubUrl : undefined,
      ref: fields.ref as string | undefined, excludePatterns: fields.excludePatterns as string[] | undefined,
      email: typeof fields.email === 'string' ? fields.email.trim() || undefined : undefined,
      idempotencyKey: typeof fields.idempotencyKey === 'string' ? fields.idempotencyKey : req.get('idempotency-key'),
      createdBy: resolveActorFromRequest(req) });
    return res.status(202).json({ task: publicCodeReviewTask(task) });
  }));
  // Imported reports use the same project gate and storage as generated reports.
  router.post('/code-reviews/reports', ...parse, handler(async (req, res) => {
    let unlock!: () => void;
    const previous = importing;
    importing = new Promise<void>((resolve) => { unlock = resolve; });
    await previous;
    try {
    const { fields, file, filename } = await body(req);
    const projectId = project(req, fields.projectId);
    const format = fields.format || (filename?.toLowerCase().endsWith('.md') ? 'md' : filename?.toLowerCase().endsWith('.html') ? 'html' : undefined);
    if (format !== 'md' && format !== 'html') throw new CodeReviewError(400, '仅支持 HTML 或 Markdown 报告');
    const content = file ? file.toString('utf8') : fields.content;
    const title = typeof fields.title === 'string' ? fields.title.trim().slice(0, 200) : '';
    if (!title || typeof content !== 'string' || !content.trim() || Buffer.byteLength(content) > MAX_REPORT) throw new CodeReviewError(400, '报告标题和正文必填，正文上限 10MiB');
    const contentHash = createHash('sha256').update(content).digest('hex');
    const existing = state.listAcceptanceReports(projectId).find((r) => r.reportType === 'code-review' && r.contentHash === contentHash);
    if (existing) return res.json({ report: existing });
    const id = randomUUID().replace(/-/g, '');
    const report = await state.createAcceptanceReportAsync({ title: `代码审查报告 · ${title} · ${new Date().toISOString().slice(0, 10)}`,
      projectId, format, content, reportType: 'code-review', reviewTaskId: id, contentHash, createdBy: resolveActorFromRequest(req) });
    const now = new Date().toISOString();
    const task: CodeReviewTask = { id, projectId, title, sourceType: 'report', sourceName: filename || title,
      excludePatterns: [], status: 'completed', phase: '已上传审查报告', progress: { totalFiles: 0, scannedFiles: 0 },
      delivery: { status: 'not_requested' }, ownerScope: service.deps.ownerScope, reportId: report.id,
      createdBy: resolveActorFromRequest(req), createdAt: now, updatedAt: now };
    await state.putCodeReviewTask(task);
    return res.status(201).json({ report, task: publicCodeReviewTask(task) });
    } finally { unlock(); }
  }));
  router.get('/code-reviews/:id', handler((req, res) => res.json({ task: publicCodeReviewTask(taskFor(req)) })));
  router.get('/code-reviews/:id/audit', handler(async (req, res) => {
    const task = taskFor(req); const before = Number(req.query.before) || undefined;
    if (before && (!Number.isSafeInteger(before) || before < 1)) throw new CodeReviewError(400, '审计分页参数无效');
    return res.json(await service.auditPage(task.id, before));
  }));
  for (const [action, run] of [
    ['cancel', (id: string) => service.cancel(id)], ['retry', (id: string) => service.retry(id)], ['delivery/retry', (id: string) => service.deliver(id)],
  ] as const) router.post(`/code-reviews/:id/${action}`, handler(async (req, res) => {
    const task = taskFor(req);
    const result = action === 'retry' ? await service.retry(task.id, req.get('X-CDS-Review-Expected-Updated-At')) : await run(task.id);
    return res.json({ task: publicCodeReviewTask(result) });
  }));
  router.get('/code-reviews/:id/report', handler(async (req, res) => {
    const task = taskFor(req);
    const report = task.reportId ? state.getAcceptanceReport(task.reportId) : undefined;
    if (!report || report.projectId !== task.projectId) throw new CodeReviewError(404, '报告尚未归档');
    const content = await state.readAcceptanceReportContentAsync(report.id);
    if (!content) throw new CodeReviewError(404, '报告正文不可读取');
    return res.json({ report, content });
  }));
  router.get('/code-reviews/:id/report/download', handler(async (req, res) => {
    const task = taskFor(req);
    const report = task.reportId ? state.getAcceptanceReport(task.reportId) : undefined;
    if (!report || report.projectId !== task.projectId) throw new CodeReviewError(404, '报告尚未归档');
    const content = await state.readAcceptanceReportContentAsync(report.id);
    if (!content) throw new CodeReviewError(404, '报告正文不可读取');
    res.type(report.format === 'md' ? 'text/markdown' : 'text/html');
    res.setHeader('Content-Disposition', `attachment; filename="code-review-${task.id}.${report.format}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    return res.send(content);
  }));
  return router;
}
