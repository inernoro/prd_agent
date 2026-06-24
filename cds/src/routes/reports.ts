/**
 * CDS self-hosted acceptance reports (验收报告).
 *
 * Why this exists: acceptance / visual-test reports used to be archived only
 * into an external knowledge base (知识库) that needs its own permission setup.
 * Many things have no KB. Hosting reports inside CDS means the existing CDS
 * login already gates them — no separate auth wiring. Both HTML and Markdown
 * are accepted.
 *
 * Storage: report bodies (potentially large HTML) live on disk under
 * `<dataDir>/reports/<id>.<ext>` (see StateService.getReportsBase()). Only
 * lightweight metadata is kept in state.json. The store layer
 * (state.ts: createAcceptanceReport / readAcceptanceReportContent / ...) owns
 * the file <-> metadata round-trip.
 *
 * ── Security model for HTML rendering ──
 * Uploaded HTML is UNTRUSTED. The frontend renders it inside a SANDBOXED
 * iframe WITHOUT `allow-same-origin`, so the report can never read CDS
 * cookies / session / localStorage even if it runs scripts (allow-scripts is
 * tolerated only because same-origin is denied). On top of that, the
 * `/raw` endpoint here:
 *   - serves with `X-Content-Type-Options: nosniff` so the browser cannot
 *     MIME-sniff a text/markdown payload into executable HTML;
 *   - sends a strict `Content-Security-Policy` (default-src 'none' for md,
 *     and a sandbox directive) so even a direct navigation to /raw cannot
 *     act with CDS-origin privileges;
 *   - sets `Content-Disposition: inline` + `X-Frame-Options` is intentionally
 *     omitted so our own sandboxed iframe can embed it.
 * The raw HTML is therefore never executed in the CDS origin with session
 * access — only inside the no-same-origin sandbox the frontend builds.
 */
import { Router, type Request, type Response, json as expressJson, text as expressText, raw as expressRaw } from 'express';
import type { StateService } from '../services/state.js';
import { resolveActorFromRequest } from '../services/actor-resolver.js';

/**
 * Project-scoped agent key (cdsp_) stamped on the request by the auth gate.
 * Cookie / bootstrap auth leaves this undefined (human owner — unrestricted),
 * so report access stays per the feature's "CDS 登录即可、无需单独权限" design;
 * only project-scoped keys get narrowed to their own project (PR #865 Bugbot
 * learned rule: project-scoped resource handlers must enforce project scope).
 */
function projectKeyOf(req: Request): { projectId: string; keyId: string } | undefined {
  return (req as unknown as { cdsProjectKey?: { projectId: string; keyId: string } }).cdsProjectKey;
}

/**
 * Stricter than the generic assertProjectAccess for acceptance reports: a
 * project-scoped key may ONLY touch reports whose projectId equals its own.
 * Global reports (null projectId) are owner / human-session only — a project
 * key is denied (the generic helper would allow a null target, leaking global
 * reports; see PR #865 Bugbot「project keys read global reports」). Cookie /
 * bootstrap auth (no key) is unrestricted.
 */
function reportAccessDenied(
  req: Request,
  reportProjectId: string | null | undefined,
): { status: number; body: Record<string, unknown> } | null {
  const key = projectKeyOf(req);
  if (!key) return null;
  if ((reportProjectId ?? null) === key.projectId) return null;
  return {
    status: 403,
    body: {
      error: 'project_mismatch',
      message: '这把 key 只能访问其所属项目的验收报告（全局报告仅限登录用户）',
    },
  };
}

export interface ReportsRouterDeps {
  stateService: StateService;
}

/** Hard cap on report body size (paste + upload). 10MB of UTF-8 text. */
const MAX_CONTENT_BYTES = 10 * 1024 * 1024;

type ReportFormat = 'html' | 'md';

/**
 * Infer the report format from an explicit value, a filename extension, or a
 * content-type. Returns undefined when none yields a known format so the
 * caller can reject with 400.
 */
function inferFormat(
  explicit: string | undefined,
  filename: string | undefined,
  contentType: string | undefined,
): ReportFormat | undefined {
  const norm = (explicit || '').trim().toLowerCase();
  if (norm === 'html' || norm === 'htm') return 'html';
  if (norm === 'md' || norm === 'markdown') return 'md';
  if (norm) return undefined; // explicit but unknown -> reject

  const name = (filename || '').toLowerCase();
  if (name.endsWith('.html') || name.endsWith('.htm')) return 'html';
  if (name.endsWith('.md') || name.endsWith('.markdown')) return 'md';

  const ct = (contentType || '').toLowerCase();
  if (ct.includes('text/html')) return 'html';
  if (ct.includes('markdown')) return 'md';

  return undefined;
}

interface ParsedUpload {
  title?: string;
  format?: string;
  content?: string;
  projectId?: string | null;
  branchId?: string | null;
  filename?: string;
}

/**
 * Minimal multipart/form-data parser for the upload path. Handles the small,
 * well-formed bodies the dashboard sends (a few text fields + one file). It is
 * NOT a general-purpose parser — it tolerates only the shapes the frontend
 * produces. Falls back to returning {} on anything it cannot parse so the
 * caller surfaces a clean 400.
 */
function parseMultipart(buf: Buffer, contentType: string): ParsedUpload {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const boundary = (m?.[1] || m?.[2] || '').trim();
  if (!boundary) return {};
  const delimiter = `--${boundary}`;
  const text = buf.toString('latin1'); // byte-preserving split; decode parts as utf8 later
  const parts = text.split(delimiter);
  const out: ParsedUpload = {};
  for (const part of parts) {
    if (!part || part === '--\r\n' || part === '--' || part.trim() === '') continue;
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;
    const rawHeaders = part.slice(0, headerEnd);
    // Strip the trailing CRLF that precedes the next delimiter.
    let body = part.slice(headerEnd + 4);
    if (body.endsWith('\r\n')) body = body.slice(0, -2);
    const nameMatch = /name="([^"]*)"/i.exec(rawHeaders);
    const filenameMatch = /filename="([^"]*)"/i.exec(rawHeaders);
    const fieldName = nameMatch?.[1];
    if (!fieldName) continue;
    const value = Buffer.from(body, 'latin1').toString('utf8');
    if (filenameMatch) {
      out.content = value;
      out.filename = filenameMatch[1];
    } else if (fieldName === 'title') {
      out.title = value;
    } else if (fieldName === 'format') {
      out.format = value;
    } else if (fieldName === 'projectId') {
      out.projectId = value || null;
    } else if (fieldName === 'branchId') {
      out.branchId = value || null;
    } else if (fieldName === 'content' && out.content === undefined) {
      out.content = value;
    }
  }
  return out;
}

function exceedsCap(content: string): boolean {
  return Buffer.byteLength(content, 'utf8') > MAX_CONTENT_BYTES;
}

export function createReportsRouter(deps: ReportsRouterDeps): Router {
  const router = Router();
  const { stateService } = deps;

  // Body parsers scoped to this router so the global express.json 100kb limit
  // does not clip large report uploads. JSON for the paste path, text for
  // raw text bodies, raw (Buffer) for multipart uploads.
  const jsonParser = expressJson({ limit: '12mb' });
  const textParser = expressText({ limit: '12mb', type: ['text/*', 'application/markdown'] });
  const rawParser = expressRaw({ limit: '12mb', type: 'multipart/form-data' });

  // POST /api/reports — create a report (paste JSON OR multipart upload).
  router.post('/reports', rawParser, jsonParser, textParser, (req: Request, res: Response) => {
    const contentType = String(req.headers['content-type'] || '');
    let title: string | undefined;
    let formatHint: string | undefined;
    let content: string | undefined;
    let projectId: string | null | undefined;
    let branchId: string | null | undefined;
    let folderId: string | null | undefined;
    let filename: string | undefined;

    if (contentType.includes('multipart/form-data')) {
      const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
      const parsed = parseMultipart(buf, contentType);
      title = parsed.title;
      formatHint = parsed.format;
      content = parsed.content;
      projectId = parsed.projectId;
      branchId = parsed.branchId;
      filename = parsed.filename;
    } else if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
      const body = req.body as Record<string, unknown>;
      title = typeof body.title === 'string' ? body.title : undefined;
      formatHint = typeof body.format === 'string' ? body.format : undefined;
      content = typeof body.content === 'string' ? body.content : undefined;
      projectId = typeof body.projectId === 'string' ? body.projectId : null;
      branchId = typeof body.branchId === 'string' ? body.branchId : null;
      folderId = typeof body.folderId === 'string' ? body.folderId : null;
    } else if (typeof req.body === 'string') {
      content = req.body;
    }

    const cleanTitle = (title || '').trim();
    if (!cleanTitle) {
      return res.status(400).json({ error: 'missing_title', message: '请填写报告标题' });
    }
    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'missing_content', message: '报告内容为空（请粘贴内容或上传文件）' });
    }
    if (exceedsCap(content)) {
      return res.status(413).json({ error: 'content_too_large', message: `报告内容超过上限（${MAX_CONTENT_BYTES / 1024 / 1024}MB）` });
    }

    const format = inferFormat(formatHint, filename, contentType);
    if (!format) {
      return res.status(400).json({
        error: 'unknown_format',
        message: '无法识别报告格式，请选择 HTML 或 Markdown（或上传 .html / .md 文件）',
      });
    }

    // Validate optional associations against known state so dangling ids do
    // not silently attach. Unknown ids are dropped (treated as null) rather
    // than rejected — the report itself is still valuable.
    const key = projectKeyOf(req);
    let resolvedProjectId =
      projectId && stateService.getProject(projectId) ? stateService.getProject(projectId)!.id : null;
    if (key) {
      // 项目级 key 一律把报告归到自己的项目：杜绝建出本 key 之后列不出来的全局/孤儿
      // 报告，也不许挂到别的项目（PR #865 Bugbot「orphan creates」+「read global」）。
      resolvedProjectId = key.projectId;
    }
    // 关联分支必须属于报告所属项目，避免跨项目挂分支（PR #865 Bugbot「branch ignores
    // scope」）。全局报告(null projectId，仅 owner 可建)可挂任意已存在分支。
    let resolvedBranchId: string | null = null;
    if (branchId) {
      const br = stateService.getBranch(branchId);
      if (br && (resolvedProjectId === null || (br.projectId ?? 'default') === (resolvedProjectId ?? 'default'))) {
        resolvedBranchId = branchId;
      }
    }

    // 文件夹必须存在且与报告同属一个项目作用域，否则忽略（state 层也会再校验一次）。
    let resolvedFolderId: string | null = null;
    if (folderId) {
      const folder = stateService.getReportFolder(folderId);
      if (folder && (folder.projectId ?? null) === resolvedProjectId) resolvedFolderId = folder.id;
    }

    const meta = stateService.createAcceptanceReport({
      title: cleanTitle,
      format,
      content,
      projectId: resolvedProjectId,
      branchId: resolvedBranchId,
      folderId: resolvedFolderId,
      createdBy: resolveActorFromRequest(req),
    });
    return res.status(201).json({ report: meta });
  });

  // GET /api/reports?projectId= — list metadata (newest first).
  router.get('/reports', (req: Request, res: Response) => {
    let projectId = typeof req.query.projectId === 'string' && req.query.projectId
      ? req.query.projectId
      : undefined;
    // 项目级 key 只能看自己项目的报告（忽略其传入的 projectId 越权查询）；
    // cookie/bootstrap（人类 owner）不受限，照旧看全部。
    const key = projectKeyOf(req);
    if (key) projectId = key.projectId;
    // folderId 过滤：'<id>' 仅该文件夹；'none' 仅未归类；缺省不过滤。
    let folderFilter: string | null | undefined;
    if (typeof req.query.folderId === 'string') {
      folderFilter = req.query.folderId === 'none' ? null : req.query.folderId;
    }
    const reports = stateService.listAcceptanceReports(projectId ?? null, folderFilter);
    res.json({ reports });
  });

  // GET /api/reports/:id — single report metadata.
  router.get('/reports/:id', (req: Request, res: Response) => {
    const meta = stateService.getAcceptanceReport(req.params.id);
    if (!meta) return res.status(404).json({ error: 'not_found', message: '报告不存在' });
    const mismatch = reportAccessDenied(req, meta.projectId);
    if (mismatch) return res.status(mismatch.status).json(mismatch.body);
    return res.json({ report: meta });
  });

  // GET /api/reports/:id/raw — raw content, hardened against MIME-sniffing /
  // same-origin execution. See the security note at the top of this file.
  router.get('/reports/:id/raw', (req: Request, res: Response) => {
    const meta = stateService.getAcceptanceReport(req.params.id);
    if (!meta) return res.status(404).json({ error: 'not_found', message: '报告不存在' });
    const mismatch = reportAccessDenied(req, meta.projectId);
    if (mismatch) return res.status(mismatch.status).json(mismatch.body);
    const content = stateService.readAcceptanceReportContent(meta.id);
    if (content === undefined) {
      return res.status(404).json({ error: 'content_missing', message: '报告内容文件已丢失' });
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    if (meta.format === 'html') {
      // Sandbox directive forces a unique origin + denies same-origin even on
      // direct navigation. The frontend additionally embeds this in a
      // sandbox="allow-scripts" iframe (no allow-same-origin).
      res.setHeader('Content-Security-Policy', "sandbox allow-scripts; default-src 'self' data: blob: https:; img-src * data: blob:; style-src 'unsafe-inline' *; script-src 'unsafe-inline' 'unsafe-eval' *; frame-ancestors 'self'");
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
    } else {
      // Markdown is served as plain text so a browser cannot render it as
      // HTML; the frontend converts + sanitizes it before rendering.
      res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'self'");
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    }
    res.setHeader('Content-Disposition', 'inline');
    return res.send(content);
  });

  // PATCH /api/reports/:id — rename and/or replace content.
  router.patch('/reports/:id', jsonParser, textParser, (req: Request, res: Response) => {
    const existing = stateService.getAcceptanceReport(req.params.id);
    if (!existing) return res.status(404).json({ error: 'not_found', message: '报告不存在' });
    const mismatch = reportAccessDenied(req, existing.projectId);
    if (mismatch) return res.status(mismatch.status).json(mismatch.body);
    const body = (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body))
      ? (req.body as Record<string, unknown>)
      : {};
    const title = typeof body.title === 'string' ? body.title.trim() : undefined;
    const content = typeof body.content === 'string' ? body.content : undefined;
    // folderId: 字符串=移入该文件夹；null / 'none' / '' = 移出文件夹；缺省=不改动。
    const hasFolder = Object.prototype.hasOwnProperty.call(body, 'folderId');
    if (title === undefined && content === undefined && !hasFolder) {
      return res.status(400).json({ error: 'nothing_to_update', message: '没有可更新的字段' });
    }
    if (content !== undefined && exceedsCap(content)) {
      return res.status(413).json({ error: 'content_too_large', message: `报告内容超过上限（${MAX_CONTENT_BYTES / 1024 / 1024}MB）` });
    }
    let updated = existing;
    if (title !== undefined || content !== undefined) {
      updated = stateService.updateAcceptanceReport(req.params.id, { title, content }) ?? existing;
    }
    if (hasFolder) {
      const raw = body.folderId;
      const next = typeof raw === 'string' && raw && raw !== 'none' ? raw : null;
      const moved = stateService.setReportFolder(req.params.id, next);
      if (!moved) return res.status(400).json({ error: 'invalid_folder', message: '目标文件夹不存在或与报告项目不一致' });
      updated = moved;
    }
    return res.json({ report: updated });
  });

  // DELETE /api/reports/:id — remove metadata + content file.
  router.delete('/reports/:id', (req: Request, res: Response) => {
    const meta = stateService.getAcceptanceReport(req.params.id);
    if (!meta) return res.status(404).json({ error: 'not_found', message: '报告不存在' });
    const mismatch = reportAccessDenied(req, meta.projectId);
    if (mismatch) return res.status(mismatch.status).json(mismatch.body);
    const removed = stateService.deleteAcceptanceReport(req.params.id);
    if (!removed) return res.status(404).json({ error: 'not_found', message: '报告不存在' });
    return res.json({ success: true });
  });

  // ── 验收报告文件夹（项目级分类）─────────────────────────────────────────
  // 项目级 key 只能管自己项目的文件夹（沿用 reportAccessDenied 的作用域口径）；
  // cookie / bootstrap（人类 owner）可管全部，含全局（CDS 自身）文件夹。

  // GET /api/report-folders?projectId= — 列出某项目（或全局）下的文件夹。
  router.get('/report-folders', (req: Request, res: Response) => {
    let projectId = typeof req.query.projectId === 'string' && req.query.projectId ? req.query.projectId : null;
    const key = projectKeyOf(req);
    if (key) projectId = key.projectId;
    return res.json({ folders: stateService.listReportFolders(projectId) });
  });

  // POST /api/report-folders — 新建文件夹 { name, projectId? }。
  router.post('/report-folders', jsonParser, (req: Request, res: Response) => {
    const body = (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body))
      ? (req.body as Record<string, unknown>) : {};
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return res.status(400).json({ error: 'missing_name', message: '请填写文件夹名称' });
    let projectId = typeof body.projectId === 'string' && body.projectId ? body.projectId : null;
    const key = projectKeyOf(req);
    if (key) projectId = key.projectId;
    // 校验项目存在（null=全局，允许）。
    if (projectId && !stateService.getProject(projectId)) {
      return res.status(400).json({ error: 'unknown_project', message: '关联项目不存在' });
    }
    const folder = stateService.createReportFolder({ name, projectId });
    return res.status(201).json({ folder });
  });

  // PATCH /api/report-folders/:id — 重命名 { name }。
  router.patch('/report-folders/:id', jsonParser, (req: Request, res: Response) => {
    const folder = stateService.getReportFolder(req.params.id);
    if (!folder) return res.status(404).json({ error: 'not_found', message: '文件夹不存在' });
    const mismatch = reportAccessDenied(req, folder.projectId);
    if (mismatch) return res.status(mismatch.status).json(mismatch.body);
    const body = (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body))
      ? (req.body as Record<string, unknown>) : {};
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return res.status(400).json({ error: 'missing_name', message: '请填写文件夹名称' });
    return res.json({ folder: stateService.renameReportFolder(req.params.id, name) });
  });

  // DELETE /api/report-folders/:id — 删除文件夹（内部报告改为未归类，不删内容）。
  router.delete('/report-folders/:id', (req: Request, res: Response) => {
    const folder = stateService.getReportFolder(req.params.id);
    if (!folder) return res.status(404).json({ error: 'not_found', message: '文件夹不存在' });
    const mismatch = reportAccessDenied(req, folder.projectId);
    if (mismatch) return res.status(mismatch.status).json(mismatch.body);
    stateService.deleteReportFolder(req.params.id);
    return res.json({ success: true });
  });

  return router;
}
