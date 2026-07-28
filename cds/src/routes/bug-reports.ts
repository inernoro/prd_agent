/**
 * 快捷提 bug 端点（系统级，2026-07-27）。
 *
 *   POST /api/bug-reports   提交一条缺陷反馈（前端 Ctrl+B 面板）
 *   GET  /api/bug-reports   列出最近的缺陷反馈（默认 50 条）
 *
 * 投递策略（两条路，绝不假装成功）：
 *   1. 配置了 MAP 缺陷系统凭据（CDS_BUG_REPORT_MAP_BASE_URL + CDS_BUG_REPORT_MAP_TOKEN）
 *      → 由**服务端**带凭据转发到 MAP `POST /api/defect-agent/defects`，再调 submit。
 *      凭据只存在服务端，前端永远拿不到（前端只调本服务这个端点）。
 *   2. 未配置或转发失败 → 落到本服务自己的存储（`<dataDir>/bug-reports/`），
 *      响应里 delivery='local' + degradeReason，前端如实告知「已记录到本地待办，
 *      未同步到缺陷系统」。
 *
 * 存储：元数据 append 到 records.jsonl（单进程 append-only，够用且无需改 state 结构），
 * 截图落 attachments/ 目录，避免把 base64 塞进 state.json。
 */

import express, { Router, type NextFunction, type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** 与前端 BugReportCore 对齐的严重程度取值。 */
export type BugSeverity = 'critical' | 'major' | 'minor' | 'trivial';

const SEVERITIES: BugSeverity[] = ['critical', 'major', 'minor', 'trivial'];

export interface BugReportAttachmentInput {
  name?: unknown;
  mimeType?: unknown;
  size?: unknown;
  dataBase64?: unknown;
}

export interface BugReportPayloadInput {
  source?: unknown;
  title?: unknown;
  description?: unknown;
  severity?: unknown;
  environment?: unknown;
  content?: unknown;
  attachments?: unknown;
}

/** 归一化后的提交内容。 */
export interface NormalizedBugReport {
  source: string;
  title: string;
  description: string;
  severity: BugSeverity;
  content: string;
  environment: Record<string, string>;
  attachments: Array<{ name: string; mimeType: string; size: number; dataBase64: string }>;
}

/** 单个附件上限 5 MB，总量上限 12 MB —— 与前端 MAX_ATTACHMENT_BYTES 对齐。 */
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 12 * 1024 * 1024;
const MAX_ATTACHMENT_COUNT = 4;

/**
 * 本路由自己的 JSON body 上限。必须大于「12MB 附件解码上限」经 base64 膨胀（4/3 倍，
 * 约 16MB）再加 JSON 包装的体积，否则合法请求会在 body-parser 阶段就被拒。
 * 全局解析器（默认 100kb）已在 server.ts 对 /api/bug-reports 跳过。
 */
export const BUG_REPORT_BODY_LIMIT = '24mb';

/** 本地留存的保留条数上限（超出从最旧的整条丢弃）。 */
export const BUG_REPORT_MAX_RECORDS = 200;
/** 本地留存的附件总量上限（磁盘硬顶；超出时总是先削当前占用最大的项目）。 */
export const BUG_REPORT_MAX_ATTACHMENT_BYTES = 256 * 1024 * 1024;
/**
 * 单个项目的附件上限。没有它，全局配额就是个公共池：一个项目猛提缺陷即可把别的
 * 项目的截图挤没，而项目级 Key 就能触发（Codex PR #1273 P1）。
 */
export const BUG_REPORT_MAX_ATTACHMENT_BYTES_PER_PROJECT = 64 * 1024 * 1024;

/** 转发缺陷系统的总预算（create + submit 合计），与前端「超过 10 秒转本地留存」文案一致。 */
export const FORWARD_TOTAL_BUDGET_MS = 10_000;

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/**
 * 校验并归一化请求体。返回 { error } 表示拒绝（400），返回 { report } 表示通过。
 * 导出供单测直接断言，不必起 HTTP。
 */
export function normalizeBugReport(
  body: BugReportPayloadInput,
): { error: string } | { report: NormalizedBugReport } {
  const description = asString(body.description).trim();
  if (!description) return { error: '请填写问题描述' };

  const severity = asString(body.severity) as BugSeverity;
  if (!SEVERITIES.includes(severity)) return { error: '严重程度取值非法' };

  const rawAttachments = Array.isArray(body.attachments) ? body.attachments : [];
  if (rawAttachments.length > MAX_ATTACHMENT_COUNT) {
    return { error: `附件最多 ${MAX_ATTACHMENT_COUNT} 个` };
  }
  const attachments: NormalizedBugReport['attachments'] = [];
  let total = 0;
  for (const raw of rawAttachments as BugReportAttachmentInput[]) {
    const dataBase64 = asString(raw?.dataBase64);
    if (!dataBase64) continue;
    const size = Math.ceil((dataBase64.length * 3) / 4);
    if (size > MAX_ATTACHMENT_BYTES) return { error: '单个附件超过 5 MB' };
    total += size;
    if (total > MAX_TOTAL_ATTACHMENT_BYTES) return { error: '附件总大小超过 12 MB' };
    attachments.push({
      name: asString(raw?.name, 'attachment').slice(0, 120),
      mimeType: asString(raw?.mimeType, 'application/octet-stream').slice(0, 120),
      size: typeof raw?.size === 'number' && raw.size > 0 ? raw.size : size,
      dataBase64,
    });
  }

  const environment: Record<string, string> = {};
  const rawEnv = body.environment;
  if (rawEnv && typeof rawEnv === 'object') {
    for (const [key, value] of Object.entries(rawEnv as Record<string, unknown>)) {
      if (typeof value === 'string' && value) environment[key.slice(0, 40)] = value.slice(0, 500);
    }
  }

  const title = asString(body.title).trim() || description.split('\n')[0]!.trim().slice(0, 100) || '未命名缺陷';

  return {
    report: {
      source: asString(body.source, 'cds').slice(0, 40),
      title,
      description,
      severity,
      content: asString(body.content).trim() || description,
      environment,
      attachments,
    },
  };
}

/** MAP 缺陷系统转发配置。 */
export interface BugReportForwardConfig {
  /** MAP 基址，例如 https://map.example.com（不含 /api）。 */
  baseUrl: string;
  /** 服务端持有的凭据，前端永不可见。 */
  token: string;
  /** 可选：默认指派人（MAP userId）。 */
  assigneeUserId?: string;
}

/**
 * 从环境变量解析转发配置。缺任何一项都返回 null（= 走本地留存路径）。
 * 导出供单测断言「未配置时必须退化」。
 */
export function resolveForwardConfig(
  env: NodeJS.ProcessEnv = process.env,
): BugReportForwardConfig | null {
  const baseUrl = (env.CDS_BUG_REPORT_MAP_BASE_URL || '').trim().replace(/\/+$/, '');
  const token = (env.CDS_BUG_REPORT_MAP_TOKEN || '').trim();
  if (!baseUrl || !token) return null;
  const assigneeUserId = (env.CDS_BUG_REPORT_MAP_ASSIGNEE || '').trim();
  return { baseUrl, token, assigneeUserId: assigneeUserId || undefined };
}

/** 组装 MAP `POST /api/defect-agent/defects` 的请求体。 */
export function buildMapDefectBody(
  report: NormalizedBugReport,
  config: BugReportForwardConfig,
): Record<string, unknown> {
  return {
    title: report.title,
    content: report.content,
    severity: report.severity,
    ...(config.assigneeUserId ? { assigneeUserId: config.assigneeUserId } : {}),
  };
}

export type FetchLike = (input: string, init?: {
  method?: string;
  headers?: Record<string, string>;
  // 附件走 multipart 上传，body 可能是 FormData（不只是 JSON 字符串）。
  body?: string | FormData;
  signal?: AbortSignal;
}) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

/** 转发结果：ok 时带 reference（缺陷编号），否则带中文失败原因。 */
export interface ForwardResult {
  ok: boolean;
  reference?: string;
  reason?: string;
  /** 转发整体成功、但附件没能全部跟过去时的如实说明（仍算 forwarded）。 */
  partialReason?: string;
}

/**
 * 服务端带凭据转发到 MAP 缺陷系统：先 create，再 submit。
 * submit 失败只降级为「已创建为草稿」，不整体判失败——缺陷已经落在 MAP 里了。
 */
export async function forwardToMap(
  report: NormalizedBugReport,
  config: BugReportForwardConfig,
  fetchImpl: FetchLike,
): Promise<ForwardResult> {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.token}`,
  };
  // 整个转发（create + submit）共用一份 10s 总预算，而不是每个请求各给 10s。
  // 前端文案承诺「超过 10 秒会转为本地留存」，两段各 10s 会让用户实际等到 20s，
  // 实现必须兑现文案（见 .claude/rules/expectation-management.md）。
  const budget = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(FORWARD_TOTAL_BUDGET_MS)
    : undefined;
  let created: { id?: string; defectNo?: string };
  try {
    const res = await fetchImpl(`${config.baseUrl}/api/defect-agent/defects`, {
      method: 'POST',
      headers,
      body: JSON.stringify(buildMapDefectBody(report, config)),
      signal: budget,
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, reason: `缺陷系统返回 HTTP ${res.status}` };
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, reason: '缺陷系统返回内容无法解析' };
    }
    const envelope = parsed as { success?: boolean; data?: { defect?: { id?: string; defectNo?: string } }; error?: { message?: string } };
    if (envelope?.success === false) {
      return { ok: false, reason: envelope.error?.message || '缺陷系统拒绝了本次提交' };
    }
    created = envelope?.data?.defect ?? {};
    if (!created.id) return { ok: false, reason: '缺陷系统未返回缺陷 ID' };
  } catch (e) {
    return { ok: false, reason: `无法连接缺陷系统：${e instanceof Error ? e.message : String(e)}` };
  }

  // 附件必须在 submit 之前上传：正文里只有文件名，没有图。少了这一步，
  // 缺陷系统收到的是「说有截图但没有截图」的单子，而 UI 却报「已提交」——
  // 属于典型的谎报成功（Codex PR #1273 P2）。上传失败不推翻「已进单」的事实，
  // 但必须如实回传部分失败，让用户知道图没跟过去。
  let attachmentFailures = 0;
  const attachments = report.attachments || [];
  for (const [index, item] of attachments.entries()) {
    try {
      const form = new FormData();
      const bytes = Buffer.from(item.dataBase64, 'base64');
      form.append(
        'file',
        new Blob([new Uint8Array(bytes)], { type: item.mimeType || 'application/octet-stream' }),
        item.name || `screenshot-${index + 1}`,
      );
      form.append('description', '由 CDS 快捷提缺陷自动上传');
      const res = await fetchImpl(`${config.baseUrl}/api/defect-agent/defects/${created.id}/attachments`, {
        method: 'POST',
        // 不要带 Content-Type：交给 FormData 自己生成含 boundary 的头，
        // 手写会让服务端解析不出 multipart。
        headers: { Authorization: headers.Authorization },
        body: form,
        signal: budget,
      });
      if (!res.ok) attachmentFailures += 1;
    } catch {
      attachmentFailures += 1;
    }
  }

  // submit 失败不推翻「已进入缺陷系统」的事实（草稿已经建了），但**必须如实说**：
  // 之前只 catch 异常、不看 res.ok，MAP 返 4xx/5xx 时 UI 照样显示「已提交」，
  // 而单子其实还躺在草稿态没人处理（Codex PR #1273 P2）。
  let submitIssue: string | null = null;
  try {
    const res = await fetchImpl(`${config.baseUrl}/api/defect-agent/defects/${created.id}/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
      signal: budget,
    });
    if (!res.ok) submitIssue = `缺陷已创建但提交流转失败（缺陷系统返回 HTTP ${res.status}），可能仍是草稿态`;
  } catch (e) {
    submitIssue = `缺陷已创建但提交流转失败（${e instanceof Error ? e.message : String(e)}），可能仍是草稿态`;
  }

  const attachmentIssue = attachmentFailures > 0
    ? `${attachmentFailures}/${attachments.length} 个截图上传失败，附件未跟随进入缺陷系统`
    : null;
  const issues = [submitIssue, attachmentIssue].filter(Boolean);
  return {
    ok: true,
    reference: created.defectNo || created.id,
    partialReason: issues.length > 0 ? issues.join('；') : undefined,
  };
}

/** 落盘后的记录（GET 列表返回的形状，不含 base64）。 */
export interface StoredBugReport {
  id: string;
  createdAt: string;
  /** 提交方项目（项目级 Key 提交时非空）。保留策略按它分桶。 */
  projectId?: string | null;
  source: string;
  reporter: string;
  title: string;
  description: string;
  severity: BugSeverity;
  environment: Record<string, string>;
  attachments: Array<{ name: string; mimeType: string; size: number; file: string }>;
  delivery: 'forwarded' | 'local';
  reference?: string | null;
  degradeReason?: string | null;
}

export interface BugReportsRouterDeps {
  /** 数据目录（记录写到 `<dataDir>/bug-reports/`）。 */
  getDataDir: () => string;
  /** 转发配置读取，默认读 process.env。 */
  readForwardConfig?: () => BugReportForwardConfig | null;
  /** 注入 fetch 便于测试。 */
  fetchImpl?: FetchLike;
  /** 解析报告人（默认取 CDS 登录态用户名）。 */
  resolveReporter?: (req: Request) => string;
  /** JSON body 上限，默认 BUG_REPORT_BODY_LIMIT；仅测试需要调小。 */
  bodyLimit?: string;
  /** 附件总量硬顶，默认 BUG_REPORT_MAX_ATTACHMENT_BYTES；仅测试需要调小。 */
  maxAttachmentBytes?: number;
  /** 单项目附件上限，默认 BUG_REPORT_MAX_ATTACHMENT_BYTES_PER_PROJECT；仅测试需要调小。 */
  maxAttachmentBytesPerProject?: number;
}

function defaultResolveReporter(req: Request): string {
  const user = (req as Request & { cdsUser?: { username?: unknown; name?: unknown } }).cdsUser;
  const username = typeof user?.username === 'string' ? user.username : '';
  const name = typeof user?.name === 'string' ? user.name : '';
  return username || name || 'anonymous';
}

function extensionFor(mimeType: string): string {
  if (mimeType.includes('png')) return 'png';
  if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return 'jpg';
  if (mimeType.includes('gif')) return 'gif';
  if (mimeType.includes('webp')) return 'webp';
  return 'bin';
}

export function createBugReportsRouter(deps: BugReportsRouterDeps): Router {
  const router = Router();
  const readForwardConfig = deps.readForwardConfig ?? (() => resolveForwardConfig());
  const resolveReporter = deps.resolveReporter ?? defaultResolveReporter;
  const fetchImpl = deps.fetchImpl
    ?? ((input, init) => (globalThis.fetch as unknown as FetchLike)(input, init));

  const maxAttachmentBytes = deps.maxAttachmentBytes ?? BUG_REPORT_MAX_ATTACHMENT_BYTES;
  const maxAttachmentBytesPerProject = deps.maxAttachmentBytesPerProject
    ?? BUG_REPORT_MAX_ATTACHMENT_BYTES_PER_PROJECT;

  const baseDir = (): string => path.join(deps.getDataDir(), 'bug-reports');
  const recordsFile = (): string => path.join(baseDir(), 'records.jsonl');

  function readRecords(limit: number): StoredBugReport[] {
    try {
      const raw = fs.readFileSync(recordsFile(), 'utf-8');
      const lines = raw.split('\n').filter((line) => line.trim());
      const parsed: StoredBugReport[] = [];
      for (const line of lines.slice(-limit).reverse()) {
        try {
          parsed.push(JSON.parse(line) as StoredBugReport);
        } catch {
          // 单行损坏不影响其余记录
        }
      }
      return parsed;
    } catch {
      return [];
    }
  }

  function persist(record: StoredBugReport, attachments: NormalizedBugReport['attachments']): void {
    const dir = baseDir();
    fs.mkdirSync(dir, { recursive: true });
    if (attachments.length > 0) {
      const assetDir = path.join(dir, 'attachments');
      fs.mkdirSync(assetDir, { recursive: true });
      attachments.forEach((item, index) => {
        const fileName = `${record.id}-${index + 1}.${extensionFor(item.mimeType)}`;
        try {
          fs.writeFileSync(path.join(assetDir, fileName), Buffer.from(item.dataBase64, 'base64'));
          record.attachments[index]!.file = fileName;
        } catch {
          record.attachments[index]!.file = '';
        }
      });
    }
    fs.appendFileSync(recordsFile(), `${JSON.stringify(record)}\n`, 'utf-8');
    pruneStore();
  }

  /**
   * 本地留存的保留策略。没有它，每次提交最多写 12MB 附件到 CDS 数据卷且**永不回收**：
   * 一个拿到 Key 的客户端（或一个不断重试的前端）反复调用就能把盘写满，而部署侧的
   * 磁盘刹车罩不到这条路由（Codex PR #1273 P1）。
   *
   * 双闸：条数上限（旧记录整条丢弃）+ 附件总量上限（从最旧的开始删文件）。
   * 只删附件文件不删记录正文时，记录里的 file 字段会被置空，列表仍看得到这条缺陷，
   * 只是图没了——比整条消失更可查。
   */
  function pruneStore(): void {
    try {
      const dir = baseDir();
      const assetDir = path.join(dir, 'attachments');
      // 注意 readRecords 返回的是**新在前**（它给列表 API 用，内部做了 reverse）。
      // 这里要保留的是「最新的 N 条」= 头部 N 条，slice(-N) 会反过来丢掉新记录。
      const newestFirst = readRecords(Number.MAX_SAFE_INTEGER);
      // 按提交方项目分桶后各自保留最近 N 条：全局一刀切会让一个吵闹的项目
      // （或一个不断重试的客户端）把别的项目的本地留存挤掉，而未配置 MAP 转发时
      // 本地留存就是唯一副本（Codex PR #1273 P1）。
      const perBucket = new Map<string, StoredBugReport[]>();
      for (const rec of newestFirst) {
        const key = rec.projectId || '__system__';
        const bucket = perBucket.get(key);
        if (bucket) bucket.push(rec);
        else perBucket.set(key, [rec]);
      }
      const keepIds = new Set<string>();
      for (const bucket of perBucket.values()) {
        for (const rec of bucket.slice(0, BUG_REPORT_MAX_RECORDS)) keepIds.add(rec.id);
      }
      const keptNewestFirst = newestFirst.filter((r) => keepIds.has(r.id));
      const droppedIds = new Set(newestFirst.filter((r) => !keepIds.has(r.id)).map((r) => r.id));
      // 落盘顺序必须回到时间正序（文件是 append-only 的 jsonl）。
      const kept = [...keptNewestFirst].reverse();

      // 附件总量回收也必须按项目隔离（Codex PR #1273 P1）。
      //
      // 此前这里是一个**全局**按时间正序的列表，从最旧的开始删到总量达标——于是
      // 一个项目猛提缺陷就能把别的项目的截图删光，而项目级 Key 就能触发它：
      // 条数保留已经按项目分桶了，字节回收却还是全局且破坏性的，等于留了后门。
      //
      // 两层配额：
      //   1. 每项目自有上限，各桶内部从最旧的删起——一个项目撑爆自己不影响别人；
      //   2. 全局上限作为磁盘硬顶，超出时**总是从当前占用最大的桶**删一个最旧的，
      //      让超量的那个项目先付账；占用低于公平份额的项目只有在所有桶都很大时
      //      才会被动到。
      type AttachmentFile = { path: string; size: number; rec: StoredBugReport; idx: number };
      const bucketFiles = new Map<string, AttachmentFile[]>();
      const bucketBytes = new Map<string, number>();
      let total = 0;
      let touchedFiles = 0;
      // kept 是时间正序，所以每个桶内天然也是「最旧的在前」。
      kept.forEach((rec) => {
        const key = rec.projectId || '__system__';
        (rec.attachments || []).forEach((att, idx) => {
          if (!att.file) return;
          const full = path.join(assetDir, att.file);
          let size = 0;
          try { size = fs.statSync(full).size; } catch { return; }
          total += size;
          touchedFiles += 1;
          bucketBytes.set(key, (bucketBytes.get(key) || 0) + size);
          const list = bucketFiles.get(key);
          if (list) list.push({ path: full, size, rec, idx });
          else bucketFiles.set(key, [{ path: full, size, rec, idx }]);
        });
      });

      const evictOldestOf = (key: string): boolean => {
        const list = bucketFiles.get(key);
        if (!list || list.length === 0) return false;
        const f = list.shift()!;
        try { fs.unlinkSync(f.path); } catch { /* 已不在就算了 */ }
        total -= f.size;
        bucketBytes.set(key, (bucketBytes.get(key) || 0) - f.size);
        f.rec.attachments[f.idx]!.file = '';
        return true;
      };

      // 第一层：每项目自有上限。
      for (const key of [...bucketFiles.keys()]) {
        while ((bucketBytes.get(key) || 0) > maxAttachmentBytesPerProject) {
          if (!evictOldestOf(key)) break;
        }
      }
      // 第二层：全局硬顶，永远先削当前最大的桶（超量者先付账）。
      while (total > maxAttachmentBytes) {
        let biggestKey: string | null = null;
        let biggestBytes = -1;
        for (const [key, list] of bucketFiles) {
          if (list.length === 0) continue;
          const bytes = bucketBytes.get(key) || 0;
          // 同量时按 key 排序，保证行为确定、可回归。
          if (bytes > biggestBytes || (bytes === biggestBytes && biggestKey !== null && key < biggestKey)) {
            biggestBytes = bytes;
            biggestKey = key;
          }
        }
        if (biggestKey === null || !evictOldestOf(biggestKey)) break;
      }
      // 注意用**回收前**的文件总数做「要不要重写记录文件」的判据：evictOldestOf 会
      // 把摘掉的项从桶里 shift 出去，拿回收后的剩余数会在「全被摘光」时判成 0，
      // 于是 att.file='' 这些改动一条都落不了盘。
      const attachmentFileCount = touchedFiles;

      if (droppedIds.size > 0 || attachmentFileCount > 0) {
        // 被整条丢弃的记录，其附件文件一并清掉，避免孤儿文件永久占盘。
        if (droppedIds.size > 0) {
          try {
            for (const name of fs.readdirSync(assetDir)) {
              const owner = name.replace(/-\d+\.[^.]+$/, '');
              if (droppedIds.has(owner)) {
                try { fs.unlinkSync(path.join(assetDir, name)); } catch { /* ignore */ }
              }
            }
          } catch { /* attachments 目录还不存在 */ }
        }
        fs.writeFileSync(recordsFile(), kept.map((r) => `${JSON.stringify(r)}\n`).join(''), 'utf-8');
      }
    } catch {
      // 保留策略失败不能影响「缺陷已收下」这件事本身。
    }
  }

  router.get('/bug-reports', (req, res) => {
    // 本地留存的缺陷是 CDS 系统级台账（正文含页面地址与 query、提交人、环境信息），
    // 且提交时没有项目维度可供过滤。项目级 cdsp_/cdsg_ key 一旦能读，等于跨项目
    // 拿到别的项目的缺陷正文——按 CDS 既有约定（无 cdsProjectKey 即管理员，
    // 见 cds-events.ts 的同款守卫）直接拒绝项目级凭据（Codex PR #1273 P1）。
    const projectKey = (req as unknown as { cdsProjectKey?: { projectId: string } }).cdsProjectKey;
    if (projectKey) {
      res.status(403).json({
        error: '缺陷台账是 CDS 系统级数据，项目级 Key 无权读取，请用管理员登录或全局 Key',
      });
      return;
    }
    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 50;
    const items = readRecords(limit).map((item) => ({ ...item, attachments: item.attachments || [] }));
    res.json({ items, forwardConfigured: Boolean(readForwardConfig()) });
  });

  // 截图附件是 base64，请求体远超全局 100kb 上限，故本路由自挂大上限解析器。
  // server.ts 已把 /api/bug-reports 排除在全局解析器之外，这里是唯一的解析入口。
  const jsonParser = express.json({ limit: deps.bodyLimit ?? BUG_REPORT_BODY_LIMIT });

  router.post('/bug-reports', jsonParser, async (req, res) => {
    const normalized = normalizeBugReport((req.body || {}) as BugReportPayloadInput);
    if ('error' in normalized) {
      res.status(400).json({ error: normalized.error });
      return;
    }
    const report = normalized.report;

    const config = readForwardConfig();
    let delivery: 'forwarded' | 'local' = 'local';
    let reference: string | null = null;
    let degradeReason: string | null = config ? null : '未配置缺陷系统转发（CDS_BUG_REPORT_MAP_BASE_URL / CDS_BUG_REPORT_MAP_TOKEN）';

    if (config) {
      const forwarded = await forwardToMap(report, config, fetchImpl);
      if (forwarded.ok) {
        delivery = 'forwarded';
        reference = forwarded.reference ?? null;
        // 附件部分失败：仍是 forwarded，但把「图没跟过去」如实带给用户。
        degradeReason = forwarded.partialReason ?? null;
      } else {
        degradeReason = forwarded.reason ?? '转发缺陷系统失败';
      }
    }

    const record: StoredBugReport = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      // 提交方的项目（项目级 cdsp_/cdsg_ Key 才有；人类/全局 Key 为 null）。
      // 保留策略按它分桶，否则一个吵闹的项目会把别的项目的本地留存挤掉。
      projectId: (req as unknown as { cdsProjectKey?: { projectId: string } }).cdsProjectKey?.projectId ?? null,
      source: report.source,
      reporter: resolveReporter(req),
      title: report.title,
      description: report.description,
      severity: report.severity,
      environment: report.environment,
      attachments: report.attachments.map((item) => ({
        name: item.name,
        mimeType: item.mimeType,
        size: item.size,
        file: '',
      })),
      delivery,
      reference,
      degradeReason,
    };

    try {
      persist(record, report.attachments);
    } catch (e) {
      // 本地留存失败且没转发成功 = 这条 bug 彻底丢了，必须如实报错让用户重试。
      if (delivery === 'local') {
        res.status(500).json({ error: `本地留存失败：${e instanceof Error ? e.message : String(e)}` });
        return;
      }
    }

    res.status(201).json({
      id: record.id,
      delivery: record.delivery,
      reference: record.reference,
      degradeReason: record.degradeReason,
    });
  });

  // body-parser 抛出的错误默认会被 Express 兜底处理器渲染成 HTML，前端只能拿到一段
  // 读不懂的标签。这里统一翻成中文 JSON，让用户知道该压缩截图而不是反复重试。
  router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    const type = (err as { type?: string } | null)?.type;
    if (type === 'entity.too.large') {
      res.status(413).json({ error: '提交内容超出上限，请减少或压缩截图后重试' });
      return;
    }
    if (type === 'entity.parse.failed') {
      res.status(400).json({ error: '请求体不是合法的 JSON' });
      return;
    }
    next(err);
  });

  return router;
}
