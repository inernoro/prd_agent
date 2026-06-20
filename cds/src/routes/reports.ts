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
    const resolvedProjectId =
      projectId && stateService.getProject(projectId) ? stateService.getProject(projectId)!.id : null;
    const resolvedBranchId = branchId && stateService.getBranch(branchId) ? branchId : null;

    const meta = stateService.createAcceptanceReport({
      title: cleanTitle,
      format,
      content,
      projectId: resolvedProjectId,
      branchId: resolvedBranchId,
      createdBy: resolveActorFromRequest(req),
    });
    return res.status(201).json({ report: meta });
  });

  // GET /api/reports?projectId= — list metadata (newest first).
  router.get('/reports', (req: Request, res: Response) => {
    const projectId = typeof req.query.projectId === 'string' && req.query.projectId
      ? req.query.projectId
      : undefined;
    const reports = stateService.listAcceptanceReports(projectId ?? null);
    res.json({ reports });
  });

  // GET /api/reports/:id — single report metadata.
  router.get('/reports/:id', (req: Request, res: Response) => {
    const meta = stateService.getAcceptanceReport(req.params.id);
    if (!meta) return res.status(404).json({ error: 'not_found', message: '报告不存在' });
    return res.json({ report: meta });
  });

  // GET /api/reports/:id/raw — raw content, hardened against MIME-sniffing /
  // same-origin execution. See the security note at the top of this file.
  router.get('/reports/:id/raw', (req: Request, res: Response) => {
    const meta = stateService.getAcceptanceReport(req.params.id);
    if (!meta) return res.status(404).json({ error: 'not_found', message: '报告不存在' });
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
    const body = (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body))
      ? (req.body as Record<string, unknown>)
      : {};
    const title = typeof body.title === 'string' ? body.title.trim() : undefined;
    const content = typeof body.content === 'string' ? body.content : undefined;
    if (title === undefined && content === undefined) {
      return res.status(400).json({ error: 'nothing_to_update', message: '没有可更新的字段' });
    }
    if (content !== undefined && exceedsCap(content)) {
      return res.status(413).json({ error: 'content_too_large', message: `报告内容超过上限（${MAX_CONTENT_BYTES / 1024 / 1024}MB）` });
    }
    const updated = stateService.updateAcceptanceReport(req.params.id, { title, content });
    return res.json({ report: updated });
  });

  // DELETE /api/reports/:id — remove metadata + content file.
  router.delete('/reports/:id', (req: Request, res: Response) => {
    const removed = stateService.deleteAcceptanceReport(req.params.id);
    if (!removed) return res.status(404).json({ error: 'not_found', message: '报告不存在' });
    return res.json({ success: true });
  });

  return router;
}
