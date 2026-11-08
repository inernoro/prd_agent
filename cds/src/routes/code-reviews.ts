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
import { REVIEW_SEVERITIES } from '../shared/code-review-result.js';

interface ReviewRequest extends Request, HumanAuthContext {
  cdsProjectKey?: { projectId: string; keyId: string };
  cdsAccess?: Parameters<typeof assertProjectAccess>[0]['cdsAccess'];
}
const MAX_ZIP = 100 * 1024 * 1024;
const MAX_REPORT = 10 * 1024 * 1024;
async function body(req: Request, maxFileBytes = MAX_ZIP): Promise<{ fields: Record<string, unknown>; file?: Buffer; filename?: string }> {
  if (!req.is('multipart/form-data')) return { fields: req.body || {} };
  const data = await new Response(new Uint8Array(req.body as Buffer), { headers: { 'content-type': req.get('content-type')! } }).formData();
  const fields: Record<string, unknown> = {};
  let file: Buffer | undefined, filename: string | undefined;
  for (const [key, value] of data.entries()) {
    if (typeof value === 'string') { if (Object.hasOwn(fields, key)) throw new CodeReviewError(400, '表单字段不能重复'); fields[key] = value; }
    else {
      if (file || key !== 'file') throw new CodeReviewError(400, '请只上传一个 file 文件');
      if (value.size > maxFileBytes) throw new CodeReviewError(400, '上传文件超过此入口的大小上限');
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
  const parseReport = [raw({ type: 'multipart/form-data', limit: MAX_REPORT + 1024 * 1024 }), json({ limit: '12mb' })];
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
    if (previous?.engineBaseUrl !== settings.engineBaseUrl || previous?.engineProjectId !== settings.engineProjectId
      || previous?.engineBranchId !== settings.engineBranchId || previous?.engineServiceId !== settings.engineServiceId) {
      if (service.list().some((task) => !['completed', 'failed', 'cancelled'].includes(task.status))) {
        throw new CodeReviewError(409, '存在未结束的审查任务，请完成或取消后再切换审查引擎');
      }
      service.assertEngineSwitchOwnership();
    }
    await state.setCodeReviewSettings(settings);
    void service.pump();
    return res.json(settingsSummary());
  }));
  router.get('/code-reviews/capabilities', handler((_req, res) => res.json(service.capabilities())));
  router.get('/code-reviews/branches', handler((req, res) => {
    const projectId = project(req, req.query.projectId);
    return res.json({ branches: state.getBranchesForProject(projectId).filter(branch => !branch.deleting && !branch.mirror)
      .map(branch => ({ id: branch.id, branch: branch.branch, status: branch.status })) });
  }));
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
    if (sourceType !== 'github' && sourceType !== 'zip' && sourceType !== 'cds') throw new CodeReviewError(400, '请选择上传源码或 CDS 项目分支');
    if (sourceType !== 'zip' && file) throw new CodeReviewError(400, '仓库来源不能同时上传 ZIP');
    const task = await service.submit({ projectId, sourceType, zip: file, filename, branchId: typeof fields.branchId === 'string' ? fields.branchId : undefined,
      title: typeof fields.title === 'string' ? fields.title : undefined,
      githubUrl: typeof fields.githubUrl === 'string' ? fields.githubUrl : undefined,
      ref: fields.ref as string | undefined, excludePatterns: fields.excludePatterns as string[] | undefined,
      email: typeof fields.email === 'string' ? fields.email.trim() || undefined : undefined,
      idempotencyKey: typeof fields.idempotencyKey === 'string' ? fields.idempotencyKey : req.get('idempotency-key'),
      createdBy: resolveActorFromRequest(req) });
    return res.status(202).json({ task: publicCodeReviewTask(task) });
  }));
  // Imported reports use the same project gate and storage as generated reports.
  router.post('/code-reviews/reports', ...parseReport, handler(async (req, res) => {
    let unlock!: () => void;
    const previous = importing;
    importing = new Promise<void>((resolve) => { unlock = resolve; });
    await previous;
    try {
    const { fields, file, filename } = await body(req, MAX_REPORT);
    const projectId = project(req, fields.projectId);
    const format = fields.format || (filename?.toLowerCase().endsWith('.md') ? 'md' : filename?.toLowerCase().endsWith('.html') ? 'html' : undefined);
    if (format !== 'md' && format !== 'html') throw new CodeReviewError(400, '仅支持 HTML 或 Markdown 报告');
    if (file && file.length > MAX_REPORT) throw new CodeReviewError(400, '报告正文上限 10MiB');
    const content = file ? file.toString('utf8') : fields.content;
    const title = typeof fields.title === 'string' ? fields.title.trim().slice(0, 200) : '';
    if (!title || typeof content !== 'string' || !content.trim() || Buffer.byteLength(content) > MAX_REPORT) throw new CodeReviewError(400, '报告标题和正文必填，正文上限 10MiB');
    const contentHash = createHash('sha256').update(content).digest('hex');
    const rawKey = typeof fields.idempotencyKey === 'string' ? fields.idempotencyKey : req.get('idempotency-key');
    const key = rawKey?.trim() ? createHash('sha256').update(rawKey.trim()).digest('hex') : undefined;
    const requestHash = createHash('sha256').update(JSON.stringify([format, title, contentHash])).digest('hex');
    const receipt = key ? { key, requestHash } : undefined;
    const prior = key ? service.list(projectId).find(task => task.reportImportReceipts?.some(item => item.key === key)) : undefined;
    if (prior) {
      if (prior.reportImportReceipts!.find(item => item.key === key)!.requestHash !== requestHash) {
        throw new CodeReviewError(409, '同一幂等键已用于不同报告，请核对原上传内容');
      }
      const report = prior.reportId ? state.getAcceptanceReport(prior.reportId) : undefined;
      if (!report || report.projectId !== projectId) throw new CodeReviewError(409, '原上传报告不可读取，请先核对原记录');
      return res.json({ report, task: publicCodeReviewTask(prior) });
    }
    const existing = state.listAcceptanceReports(projectId).find((r) => r.reportType === 'code-review' && r.contentHash === contentHash);
    if (existing) {
      if (receipt) {
        const task = existing.reviewTaskId ? state.getCodeReviewTask(existing.reviewTaskId) : undefined;
        if (!task || task.projectId !== projectId) throw new CodeReviewError(409, '原报告任务记录缺失，请先核对原记录');
        await state.putCodeReviewTask({ ...task, reportImportReceipts: [...(task.reportImportReceipts || []), receipt] });
      }
      return res.json({ report: existing });
    }
    const id = randomUUID().replace(/-/g, '');
    const report = await state.createAcceptanceReportAsync({ title: `代码审查报告 · ${title} · ${new Date().toISOString().slice(0, 10)}`,
      projectId, format, content, reportType: 'code-review', reviewTaskId: id, contentHash, createdBy: resolveActorFromRequest(req) });
    const now = new Date().toISOString();
    const task: CodeReviewTask = { id, projectId, title, sourceType: 'report', sourceName: filename || title,
      excludePatterns: [], status: 'completed', phase: '已上传审查报告', progress: { totalFiles: 0, scannedFiles: 0 },
      delivery: { status: 'not_requested' }, ownerScope: service.deps.ownerScope, reportId: report.id,
      createdBy: resolveActorFromRequest(req), createdAt: now, updatedAt: now,
      reportImportReceipts: receipt ? [receipt] : undefined };
    await state.putCodeReviewTask(task);
    return res.status(201).json({ report, task: publicCodeReviewTask(task) });
    } finally { unlock(); }
  }));
  router.get('/code-reviews/:id', handler(async (req, res) => {
    const task = taskFor(req);
    if (req.query.includeResult !== '1') return res.json({ task: publicCodeReviewTask(task) });
    const offset = req.query.offset === undefined ? 0 : Number(req.query.offset);
    const limit = req.query.limit === undefined ? 50 : Number(req.query.limit);
    const severity = req.query.severity;
    const query = req.query.q;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100
      || severity !== undefined && (typeof severity !== 'string' || !(REVIEW_SEVERITIES as readonly string[]).includes(severity))
      || query !== undefined && (typeof query !== 'string' || query.length > 300)) throw new CodeReviewError(400, '结果筛选或分页参数无效');
    return res.json({ task: publicCodeReviewTask(task), ...await service.result(task.id, { offset, limit, severity: severity as string | undefined, query: query as string | undefined }) });
  }));
  router.get('/code-reviews/:id/audit', handler(async (req, res) => {
    const task = taskFor(req); const before = req.query.before === undefined ? undefined : Number(req.query.before);
    if (before !== undefined && (!Number.isSafeInteger(before) || before < 1)) throw new CodeReviewError(400, '审计分页参数无效');
    if (req.query.cursor !== undefined && (typeof req.query.cursor !== 'string' || !req.query.cursor)) throw new CodeReviewError(400, '审计分页游标无效');
    return res.json(await service.auditPage(task.id, before, req.query.cursor as string | undefined));
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
    if (report && report.projectId !== task.projectId) throw new CodeReviewError(404, '报告尚未归档');
    const content = report ? await state.readAcceptanceReportContentAsync(report.id) : await service.exportPartialResult(task.id);
    if (!content) throw new CodeReviewError(404, '报告正文不可读取');
    const format = report?.format || 'md';
    res.type(format === 'md' ? 'text/markdown' : 'text/html');
    res.setHeader('Content-Disposition', `attachment; filename="code-review-${task.id}${report ? '' : '-partial'}.${format}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    return res.send(content);
  }));
  return router;
}
