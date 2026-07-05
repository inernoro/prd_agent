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
import { createHash } from 'node:crypto';
import type { StateService } from '../services/state.js';
import type { GitHubAppClient } from '../services/github-app-client.js';
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
  /** E4 验收回写 PR：可选 GitHub App 客户端（未配置时回写端点返回 503）。 */
  githubApp?: GitHubAppClient;
}

/** 验收结论 → GitHub check-run conclusion。 */
const VERDICT_CONCLUSION: Record<'pass' | 'conditional' | 'fail', 'success' | 'neutral' | 'failure'> = {
  pass: 'success',
  conditional: 'neutral',
  fail: 'failure',
};
const VERDICT_CN: Record<'pass' | 'conditional' | 'fail', string> = {
  pass: '通过',
  conditional: '有条件通过',
  fail: '不通过',
};

/** 从请求推断 CDS 对外可达基地址（PR 评论里的链接要绝对路径）。 */
function publicBaseFromReq(req: Request): string {
  const envBase = (process.env.CDS_PUBLIC_BASE_URL || '').trim().replace(/\/$/, '');
  if (envBase) return envBase;
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers['host'] || '').split(',')[0].trim();
  return host ? `${proto}://${host}` : '';
}

/** Hard cap on report body size (paste + upload). 10MB of UTF-8 text. */
const MAX_CONTENT_BYTES = 10 * 1024 * 1024;

/** Matches inline base64 image data URIs (HTML `src="data:..."` or Markdown
 *  `![](data:...)` — we operate on the data-URI substring, syntax-agnostic). */
const DATA_IMG_RE = /data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,([A-Za-z0-9+/=\s]+)/g;
const MIME_EXT: Record<string, string> = {
  png: 'png', jpeg: 'jpg', jpg: 'jpg', gif: 'gif', webp: 'webp', 'svg+xml': 'svg',
};

/**
 * Ingest-time normalization: pull inline `data:image/*;base64,...` images out of
 * a report body, store them content-addressed via the state layer, and rewrite
 * each occurrence to an absolute `<base>/api/reports/assets/<sha256>.<ext>` URL
 * (relative when `base` is empty). Returns the rewritten content + count.
 *
 * Why: reports historically embedded screenshots as base64, bloating the body
 * and carrying base64 into any downstream knowledge base that pulls the report
 * (which forbids inline base64). Extracting once, at the source, means CDS
 * reports never store base64 again — CDS's disk-backed asset store is its own
 * object storage, no external bucket required.
 */
function normalizeInlineImages(
  content: string,
  base: string,
  stateService: StateService,
): { content: string; extracted: number } {
  let extracted = 0;
  const out = content.replace(DATA_IMG_RE, (whole: string, mime: string, b64: string) => {
    const clean = b64.replace(/\s+/g, '');
    if (!clean) return whole;
    let buf: Buffer;
    try {
      buf = Buffer.from(clean, 'base64');
    } catch {
      return whole;
    }
    if (!buf.length) return whole;
    const ext = MIME_EXT[mime.toLowerCase()] || 'png';
    const hash = createHash('sha256').update(buf).digest('hex');
    const name = `${hash}.${ext}`;
    stateService.writeReportAsset(name, buf);
    extracted += 1;
    const rel = `/api/reports/assets/${name}`;
    return base ? `${base}${rel}` : rel;
  });
  return { content: out, extracted };
}

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
  folderId?: string | null;
  folderPath?: string;
  filename?: string;
  // E1 部署上下文 + 验收元数据（multipart 走字符串字段，POST 时再规整类型）。
  verdict?: string;
  tier?: string;
  defectCounts?: string;
  commitSha?: string;
  branch?: string;
  prNumber?: string;
  deployMode?: string;
}

const VERDICTS = ['pass', 'conditional', 'fail'] as const;

/** 规整 verdict 字符串到合法枚举，否则返回 null。 */
function normVerdict(v: unknown): 'pass' | 'conditional' | 'fail' | null {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return (VERDICTS as readonly string[]).includes(s) ? (s as 'pass' | 'conditional' | 'fail') : null;
}

/** 规整 defectCounts：接受对象或 JSON 字符串，过滤为 { [string]: number }，否则 null。 */
function normDefectCounts(v: unknown): Record<string, number> | null {
  let obj: unknown = v;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return null;
    try { obj = JSON.parse(s); } catch { return null; }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const out: Record<string, number> = {};
  for (const [k, val] of Object.entries(obj as Record<string, unknown>)) {
    const n = typeof val === 'number' ? val : Number(val);
    if (Number.isFinite(n)) out[k] = n;
  }
  return Object.keys(out).length ? out : null;
}

/** 规整 prNumber：接受数字或数字字符串，否则 null。 */
function normPrNumber(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** 短文本字段规整（commitSha / branch / tier / deployMode）：trim 后空则 null，限长防滥用。 */
function normShort(v: unknown, max = 200): string | null {
  const s = typeof v === 'string' ? v.trim() : '';
  return s ? s.slice(0, max) : null;
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
    } else if (fieldName === 'folderId') {
      out.folderId = value || null;
    } else if (fieldName === 'folderPath') {
      out.folderPath = value;
    } else if (fieldName === 'verdict') {
      out.verdict = value;
    } else if (fieldName === 'tier') {
      out.tier = value;
    } else if (fieldName === 'defectCounts') {
      out.defectCounts = value;
    } else if (fieldName === 'commitSha') {
      out.commitSha = value;
    } else if (fieldName === 'branch') {
      out.branch = value;
    } else if (fieldName === 'prNumber') {
      out.prNumber = value;
    } else if (fieldName === 'deployMode') {
      out.deployMode = value;
    } else if (fieldName === 'content' && out.content === undefined) {
      out.content = value;
    }
  }
  return out;
}

function exceedsCap(content: string): boolean {
  return Buffer.byteLength(content, 'utf8') > MAX_CONTENT_BYTES;
}

/**
 * Serve a report body with the hardened headers described in the security note
 * at the top of this file (nosniff + sandbox CSP so the raw HTML can never run
 * with CDS-origin privileges, even on direct navigation). Shared by the
 * login-gated `/raw` endpoint and the public anonymous-share `/r/:token` route.
 */
function sendReportContent(res: Response, format: ReportFormat, content: string): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  if (format === 'html') {
    res.setHeader('Content-Security-Policy', "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox; default-src 'self' data: blob: https:; img-src * data: blob:; style-src 'unsafe-inline' *; script-src 'unsafe-inline' 'unsafe-eval' *; frame-ancestors 'self'");
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
  } else {
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'self'");
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  }
  res.setHeader('Content-Disposition', 'inline');
  res.send(content);
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
    let folderPath: string | undefined;
    let filename: string | undefined;
    // E1 部署上下文 + 验收元数据（原始值，下面统一规整类型）。
    let rawVerdict: unknown;
    let rawTier: unknown;
    let rawDefectCounts: unknown;
    let rawCommitSha: unknown;
    let rawBranch: unknown;
    let rawPrNumber: unknown;
    let rawDeployMode: unknown;

    if (contentType.includes('multipart/form-data')) {
      const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
      const parsed = parseMultipart(buf, contentType);
      title = parsed.title;
      formatHint = parsed.format;
      content = parsed.content;
      projectId = parsed.projectId;
      branchId = parsed.branchId;
      folderId = parsed.folderId;
      folderPath = parsed.folderPath;
      filename = parsed.filename;
      rawVerdict = parsed.verdict;
      rawTier = parsed.tier;
      rawDefectCounts = parsed.defectCounts;
      rawCommitSha = parsed.commitSha;
      rawBranch = parsed.branch;
      rawPrNumber = parsed.prNumber;
      rawDeployMode = parsed.deployMode;
    } else if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
      const body = req.body as Record<string, unknown>;
      title = typeof body.title === 'string' ? body.title : undefined;
      formatHint = typeof body.format === 'string' ? body.format : undefined;
      content = typeof body.content === 'string' ? body.content : undefined;
      projectId = typeof body.projectId === 'string' ? body.projectId : null;
      branchId = typeof body.branchId === 'string' ? body.branchId : null;
      folderId = typeof body.folderId === 'string' ? body.folderId : null;
      folderPath = typeof body.folderPath === 'string' ? body.folderPath : undefined;
      rawVerdict = body.verdict;
      rawTier = body.tier;
      rawDefectCounts = body.defectCounts;
      rawCommitSha = body.commitSha;
      rawBranch = body.branch;
      rawPrNumber = body.prNumber;
      rawDeployMode = body.deployMode;
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

    // 文件夹归属（硬性要求 2026-06-26：项目 = 根目录，技能自取子文件夹路径）：
    //   1) 显式 folderId 优先（必须同项目）；
    //   2) 否则 folderPath（"/"分隔，如「视觉创作/2026-06-22」）→ 在该项目下 find-or-create
    //      多层嵌套文件夹链，报告落到叶子。技能(cdscli/visual-test)用项目 key 提交时，只要带
    //      一个功能名/路径，报告就自动归到「项目 → 功能 → …」下，不再全堆在项目顶层。
    //   3) 都没有 → 未归类（旧报告/无路径报告留在未归类，不迁移）。
    let resolvedFolderId: string | null = null;
    if (folderId) {
      const folder = stateService.getReportFolder(folderId);
      if (folder && (folder.projectId ?? null) === resolvedProjectId) resolvedFolderId = folder.id;
    } else if (folderPath && folderPath.trim()) {
      resolvedFolderId = stateService.findOrCreateFolderPath(resolvedProjectId, folderPath);
    }

    // E1：分支已解析时，若调用方未显式给 branch/commitSha/deployMode，从分支状态补全，
    // 让「这份验收对应哪次部署」即使调用方偷懒也尽量可追溯。
    let resolvedBranch = normShort(rawBranch);
    let resolvedCommitSha = normShort(rawCommitSha, 64);
    let resolvedDeployMode = normShort(rawDeployMode, 40);
    if (resolvedBranchId) {
      const br = stateService.getBranch(resolvedBranchId);
      if (br) {
        if (!resolvedBranch) resolvedBranch = normShort(br.branch);
        if (!resolvedCommitSha) resolvedCommitSha = normShort(br.ciTargetSha || br.githubCommitSha, 64);
      }
    }

    // 入库前归一化：把内联 base64 图片抽出、内容寻址存盘、正文改写为 HTTPS 资源链接，
    // 让 CDS 报告正文永不再携带 base64（下游知识库拉取时也就不会出现 base64）。
    const { content: normalizedContent } = normalizeInlineImages(content, publicBaseFromReq(req), stateService);

    const meta = stateService.createAcceptanceReport({
      title: cleanTitle,
      format,
      content: normalizedContent,
      projectId: resolvedProjectId,
      branchId: resolvedBranchId,
      folderId: resolvedFolderId,
      verdict: normVerdict(rawVerdict),
      tier: normShort(rawTier, 80),
      defectCounts: normDefectCounts(rawDefectCounts),
      commitSha: resolvedCommitSha,
      branch: resolvedBranch,
      prNumber: normPrNumber(rawPrNumber),
      deployMode: resolvedDeployMode,
      createdBy: resolveActorFromRequest(req),
    });
    return res.status(201).json({ report: meta });
  });

  // GET /api/reports?projectId= — list metadata (newest first).
  router.get('/reports', (req: Request, res: Response) => {
    let projectId = typeof req.query.projectId === 'string' && req.query.projectId
      ? req.query.projectId
      : undefined;
    // 把传入的 projectId 规范成真实项目 id：cdscli / config 可能传 slug(如 prd-agent)，
    // 而列表按存储的 projectId 精确过滤；不规范化则 slug 永远命中空集，create(已 resolve
    // slug)成功了 list 却空(Cursor Bugbot Medium)。
    if (projectId) projectId = stateService.getProject(projectId)?.id ?? projectId;
    // 项目级 key 只能看自己项目的报告（忽略其传入的 projectId 越权查询）；
    // cookie/bootstrap（人类 owner）不受限，照旧看全部。
    const key = projectKeyOf(req);
    if (key) projectId = key.projectId;
    // folderId 过滤：'<id>' 仅该文件夹；'none' 仅未归类；缺省不过滤。
    let folderFilter: string | null | undefined;
    if (typeof req.query.folderId === 'string') {
      folderFilter = req.query.folderId === 'none' ? null : req.query.folderId;
    }
    // updatedSince：ISO 时间戳，增量消费（MAP / peer-sync 拉取）只取 updatedAt 更新的。
    const updatedSince = typeof req.query.updatedSince === 'string' && req.query.updatedSince
      ? req.query.updatedSince
      : undefined;
    const reports = stateService
      .listAcceptanceReports(projectId ?? null, folderFilter, updatedSince)
      // 响应附带 projectSlug，便于跨系统（MAP）按项目归类展示，免二次查项目表。
      .map((r) => ({ ...r, projectSlug: r.projectId ? stateService.getProject(r.projectId)?.slug ?? null : null }));
    res.json({ reports });
  });

  // GET /api/reports/assets/:name — 内容寻址的报告图片资源（PNG/JPG/...）。
  // 公开只读：name 是 sha256(内容)+扩展名，不可枚举；正文里的截图通过它加载，跨源
  // （如 MAP 知识库）渲染报告时也能直接取到图片。内容寻址永不变，长缓存。
  // 注册在 `/reports/:id` 之前，避免被单段参数路由误吞。
  router.get('/reports/assets/:name', (req: Request, res: Response) => {
    const asset = stateService.readReportAsset(req.params.name);
    if (!asset) return res.status(404).json({ error: 'not_found', message: '资源不存在' });
    res.setHeader('Content-Type', asset.contentType);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    return res.end(asset.data);
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
    return sendReportContent(res, meta.format, content);
  });

  // ── E6 匿名分享：为登录用户提供「生成/撤销只读公开链接」──
  // POST /api/reports/:id/share — 生成（幂等返回已有）分享 token。
  router.post('/reports/:id/share', (req: Request, res: Response) => {
    const meta = stateService.getAcceptanceReport(req.params.id);
    if (!meta) return res.status(404).json({ error: 'not_found', message: '报告不存在' });
    const mismatch = reportAccessDenied(req, meta.projectId);
    if (mismatch) return res.status(mismatch.status).json(mismatch.body);
    const updated = stateService.enableReportShare(meta.id);
    if (!updated) return res.status(404).json({ error: 'not_found', message: '报告不存在' });
    return res.json({ report: updated, shareUrl: `/r/${updated.shareToken}` });
  });

  // DELETE /api/reports/:id/share — 撤销分享 token（链接立即失效）。
  router.delete('/reports/:id/share', (req: Request, res: Response) => {
    const meta = stateService.getAcceptanceReport(req.params.id);
    if (!meta) return res.status(404).json({ error: 'not_found', message: '报告不存在' });
    const mismatch = reportAccessDenied(req, meta.projectId);
    if (mismatch) return res.status(mismatch.status).json(mismatch.body);
    const updated = stateService.disableReportShare(meta.id);
    if (!updated) return res.status(404).json({ error: 'not_found', message: '报告不存在' });
    return res.json({ report: updated });
  });

  // ── E4 验收回写 PR：把 verdict 作为 PR 评论 + GitHub check-run 推回 ──
  // POST /api/reports/:id/push-to-pr — 需要报告带 verdict + prNumber，且所属项目已 link GitHub。
  router.post('/reports/:id/push-to-pr', jsonParser, async (req: Request, res: Response) => {
    const meta = stateService.getAcceptanceReport(req.params.id);
    if (!meta) return res.status(404).json({ error: 'not_found', message: '报告不存在' });
    const mismatch = reportAccessDenied(req, meta.projectId);
    if (mismatch) return res.status(mismatch.status).json(mismatch.body);
    if (!deps.githubApp) {
      return res.status(503).json({ error: 'github_not_configured', message: '本 CDS 未配置 GitHub App，无法回写 PR' });
    }
    if (!meta.verdict) {
      return res.status(400).json({ error: 'missing_verdict', message: '报告没有验收结论(verdict)，无法回写 PR' });
    }
    if (!meta.prNumber) {
      return res.status(400).json({ error: 'missing_pr', message: '报告未关联 PR 编号(创建时带 --pr 或 prNumber)' });
    }
    const project = meta.projectId ? stateService.getProject(meta.projectId) : undefined;
    const repoFull = project?.githubRepoFullName;
    const installationId = project?.githubInstallationId;
    if (!project || !repoFull || !installationId) {
      return res.status(400).json({ error: 'project_not_linked', message: '报告所属项目未关联 GitHub 仓库/安装，无法回写 PR' });
    }
    const [owner, repo] = repoFull.split('/');
    if (!owner || !repo) {
      return res.status(400).json({ error: 'bad_repo', message: `项目的 githubRepoFullName 非法：${repoFull}` });
    }

    const base = publicBaseFromReq(req);
    const deeplink = base
      ? `${base}/reports?${meta.projectId ? `project=${encodeURIComponent(meta.projectId)}&` : ''}${meta.folderId ? `folder=${encodeURIComponent(meta.folderId)}&` : ''}report=${encodeURIComponent(meta.id)}`
      : '';
    const shareLink = base && meta.shareToken ? `${base}/r/${meta.shareToken}` : '';
    const vCn = VERDICT_CN[meta.verdict];

    // 评论正文（markdown）。HTML 注释标记便于以后识别/去重 CDS 验收评论。
    const lines: string[] = [];
    lines.push('<!-- cds-acceptance-report -->');
    lines.push(`### CDS 验收：${vCn}`);
    lines.push('');
    lines.push(`**${meta.title}**`);
    lines.push('');
    if (meta.tier) lines.push(`- 档位：${meta.tier}`);
    if (meta.defectCounts && Object.keys(meta.defectCounts).length) {
      lines.push(`- 缺陷：${Object.entries(meta.defectCounts).map(([k, v]) => `${k}=${v}`).join('  ')}`);
    }
    const deployBits = [meta.branch, meta.commitSha ? meta.commitSha.slice(0, 7) : '', meta.deployMode].filter(Boolean);
    if (deployBits.length) lines.push(`- 部署：${deployBits.join(' · ')}`);
    if (deeplink) lines.push(`- 报告：[在 CDS 查看](${deeplink})${shareLink ? ` · [公开链接](${shareLink})` : ''}`);
    lines.push('');
    lines.push('<sub>由 CDS 验收中心回写</sub>');
    const body = lines.join('\n');

    const result: { commentUrl?: string; checkRun?: { id: number; htmlUrl: string }; warnings: string[] } = { warnings: [] };
    // 1) PR 评论（主路径）。
    try {
      const c = await deps.githubApp.createIssueComment(installationId, owner, repo, meta.prNumber, body);
      result.commentUrl = c.htmlUrl;
    } catch (e) {
      result.warnings.push(`PR 评论失败：${(e as Error).message.slice(0, 200)}`);
    }
    // 2) check-run（差异化：PR Checks 面板出现「验收绿/红」）。需要 commitSha。
    if (meta.commitSha) {
      try {
        const cr = await deps.githubApp.createCheckRun(installationId, owner, repo, {
          name: 'CDS 验收',
          headSha: meta.commitSha,
          status: 'completed',
          conclusion: VERDICT_CONCLUSION[meta.verdict],
          detailsUrl: deeplink || undefined,
          externalId: meta.id,
          completedAt: new Date().toISOString(),
          output: { title: `CDS 验收：${vCn}`, summary: `${meta.title}${meta.tier ? `（${meta.tier}）` : ''}` },
        });
        result.checkRun = cr;
      } catch (e) {
        result.warnings.push(`check-run 创建失败：${(e as Error).message.slice(0, 200)}`);
      }
    } else {
      result.warnings.push('报告无 commitSha，跳过 check-run（仅发 PR 评论）');
    }

    if (!result.commentUrl && !result.checkRun) {
      return res.status(502).json({ error: 'push_failed', message: '回写 PR 失败', warnings: result.warnings });
    }
    return res.json({ ok: true, prNumber: meta.prNumber, repo: repoFull, ...result });
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
    // 验收元数据可单独 PATCH（看板改判定 / E4 回写后补 prNumber 等）。
    // hasOwnProperty 区分「显式传 null 清空」与「缺省不动」。
    const metaUpdates: Parameters<typeof stateService.updateAcceptanceReport>[1] = {};
    if (Object.prototype.hasOwnProperty.call(body, 'verdict')) metaUpdates.verdict = normVerdict(body.verdict);
    if (Object.prototype.hasOwnProperty.call(body, 'tier')) metaUpdates.tier = normShort(body.tier, 80);
    if (Object.prototype.hasOwnProperty.call(body, 'defectCounts')) metaUpdates.defectCounts = normDefectCounts(body.defectCounts);
    if (Object.prototype.hasOwnProperty.call(body, 'commitSha')) metaUpdates.commitSha = normShort(body.commitSha, 64);
    if (Object.prototype.hasOwnProperty.call(body, 'branch')) metaUpdates.branch = normShort(body.branch);
    if (Object.prototype.hasOwnProperty.call(body, 'prNumber')) metaUpdates.prNumber = normPrNumber(body.prNumber);
    if (Object.prototype.hasOwnProperty.call(body, 'deployMode')) metaUpdates.deployMode = normShort(body.deployMode, 40);
    const hasMeta = Object.keys(metaUpdates).length > 0;
    // folderId: 字符串=移入该文件夹；null / 'none' / '' = 移出文件夹；缺省=不改动。
    const hasFolder = Object.prototype.hasOwnProperty.call(body, 'folderId');
    if (title === undefined && content === undefined && !hasFolder && !hasMeta) {
      return res.status(400).json({ error: 'nothing_to_update', message: '没有可更新的字段' });
    }
    if (content !== undefined && exceedsCap(content)) {
      return res.status(413).json({ error: 'content_too_large', message: `报告内容超过上限（${MAX_CONTENT_BYTES / 1024 / 1024}MB）` });
    }
    // 先校验 folder 再改内容（Codex P2）：否则非法/跨项目 folderId 会在内容已落盘后才回 400，
    // 调用方看到失败却已被部分修改，重试或「以为被拒」的编辑都会污染数据。校验口径与
    // setReportFolder 一致（存在 + 同项目作用域），通过后才执行内容更新与移动。
    const nextFolder = hasFolder
      ? (typeof body.folderId === 'string' && body.folderId && body.folderId !== 'none' ? body.folderId : null)
      : undefined;
    if (nextFolder) {
      const folder = stateService.getReportFolder(nextFolder);
      if (!folder || (folder.projectId || null) !== (existing.projectId || null)) {
        return res.status(400).json({ error: 'invalid_folder', message: '目标文件夹不存在或与报告项目不一致' });
      }
    }
    let updated = existing;
    if (title !== undefined || content !== undefined || hasMeta) {
      updated = stateService.updateAcceptanceReport(req.params.id, { title, content, ...metaUpdates }) ?? existing;
    }
    if (hasFolder) {
      const moved = stateService.setReportFolder(req.params.id, nextFolder ?? null);
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

  // GET /api/report-folders?projectId= — 列出文件夹。
  // 语义与 GET /api/reports 对齐：缺省 projectId = 全部项目（供全局视图「按项目分组」展示
  // 各项目的文件夹树，否则只回 CDS 自身的文件夹、项目分组永远只有一组）；显式 projectId =
  // 仅该项目；项目级 key 一律锁到自己项目。
  router.get('/report-folders', (req: Request, res: Response) => {
    const key = projectKeyOf(req);
    if (key) return res.json({ folders: stateService.listReportFolders(key.projectId) });
    const raw = typeof req.query.projectId === 'string' && req.query.projectId ? req.query.projectId : undefined;
    // slug → 真实项目 id 规范化（同 GET /api/reports，否则传 slug 命中空集，Cursor Bugbot Medium）。
    const projectId = raw ? stateService.getProject(raw)?.id ?? raw : undefined;
    return res.json({ folders: stateService.listReportFolders(projectId) });
  });

  // POST /api/report-folders — 新建文件夹 { name, projectId?, parentId? }。
  // parentId 支持嵌套（项目 = 根，技能自取多层子文件夹）；父必须同项目，否则视为根级。
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
    const parentId = typeof body.parentId === 'string' && body.parentId ? body.parentId : null;
    const folder = stateService.createReportFolder({ name, projectId, parentId });
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

/**
 * E6 公开分享路由（**不经登录网关**，由 token 本身鉴权）。挂在顶层 `/r`，
 * 服务端在 server.ts 的认证白名单里放行 `/r/`。token 不可枚举（128-bit 随机），
 * 撤销即 404。内容仍走 sandbox CSP（唯一 origin，禁 same-origin），与 `/raw` 同源安全模型。
 */
export function createPublicReportShareRouter(deps: ReportsRouterDeps): Router {
  const router = Router();
  const { stateService } = deps;

  router.get('/:token', (req: Request, res: Response) => {
    const meta = stateService.getReportByShareToken(req.params.token);
    if (!meta || !meta.shareToken) {
      // 不区分「token 错」与「已撤销」，统一 404，避免 token 探测。
      return res.status(404).type('text/plain; charset=utf-8').send('链接不存在或已失效');
    }
    const content = stateService.readAcceptanceReportContent(meta.id);
    if (content === undefined) {
      return res.status(404).type('text/plain; charset=utf-8').send('报告内容文件已丢失');
    }
    return sendReportContent(res, meta.format, content);
  });

  return router;
}
