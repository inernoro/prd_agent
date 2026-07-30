/**
 * 发布失败判据提取（纯函数，可单测）。
 *
 * 为什么要有这个模块：一次失败的发布，真正的结论往往是远端脚本自己打的一份
 * 门禁报告（`{"verdict":"fail","checks":[...]}`，走 stdout），而错误摘要只截了
 * 一段 stderr——于是用户看到一堆 WARN，看不懂为什么失败。CDS 其实把完整日志
 * 一行不落地存下来了，缺的只是「把结论捞出来」这一步。
 *
 * 三条纪律：
 *
 * - **只读日志，不猜结论。** 提不出结构化判据时如实说「未能从日志中提取判据」，
 *   并把 error 级日志原样列出，绝不编一个像模像样的原因（no-rootless-tree）。
 * - **噪音要标出来，但不许当成原因。** `context canceled` / 镜像预热超时这类 WARN
 *   会把真错误挤出摘要，所以单列一栏说明「它不是失败原因」，而不是删掉了事。
 * - **人话解释只在有明确信号时给。** status=401 且带 keyEnv 才说「密钥不被认」；
 *   没有信号就不说话，而不是给一句放之四海皆准的废话。
 */

export interface ReleaseDiagnosisLogLike {
  level: 'info' | 'warn' | 'error' | string;
  message: string;
  phase?: string;
}

export interface ReleaseGateCheckField {
  key: string;
  value: string;
}

export interface ReleaseGateCheck {
  name: string;
  ok: boolean;
  /** 原始 detail 字符串（可能是 JSON，也可能是 `status=401` 这种裸文本）。 */
  detail: string;
  /** detail 解析出的键值对；解析不出时为空数组，UI 退化成直接显示 detail。 */
  fields: ReleaseGateCheckField[];
}

export interface ReleaseGateReport {
  verdict: string;
  checks: ReleaseGateCheck[];
  passCount: number;
  failCount: number;
  totalCount: number;
}

export interface ReleaseFailureDiagnosis {
  /** 一句话结论，直接摆在首屏。 */
  headline: string;
  /** 结构化门禁报告。提不出来时缺省，UI 退化成 error 行列表。 */
  report?: ReleaseGateReport;
  /** 未通过的检查项（report 存在时才有内容）。 */
  failedChecks: ReleaseGateCheck[];
  /** error 级日志（去重、保序、限量）。 */
  errorLines: string[];
  /** 已知噪音行：会把真错误挤出摘要，但它本身不是失败原因。 */
  noiseLines: string[];
  /** 对首个未通过检查项的人话解释。没有明确信号时缺省。 */
  humanHint?: string;
}

/** JSON 扫描的规模上限，防止一份超长日志把主线程卡住。 */
const MAX_JSON_SCAN = 400_000;
const MAX_JSON_CANDIDATES = 400;
const MAX_ERROR_LINES = 8;
const MAX_NOISE_LINES = 6;

/**
 * 已知噪音。刻意写成「精确到现象」的正则而不是通配 WARN：
 * 把所有 WARN 都当噪音，等于给自己关掉一整类真实告警。
 */
const NOISE_PATTERNS: ReadonlyArray<RegExp> = [
  /\bcontext canceled\b/i,
  /warmup skipped or timed out/i,
  /image warmup/i,
];

/**
 * 从一段文本里抓出所有「顶格起行的 JSON 对象」。
 *
 * 只在**行首**的 `{` 处起扫是刻意的：脚本的门禁报告是 `json.dumps(indent=2)`
 * 打出来的，第一行必然是顶格 `{`。放开到「任意 `{`」会让每条含花括号的日志
 * 都触发一次回溯扫描，成本按日志长度平方增长。
 */
export function scanJsonObjects(text: string): unknown[] {
  const found: unknown[] = [];
  const source = text.length > MAX_JSON_SCAN ? text.slice(-MAX_JSON_SCAN) : text;
  let candidates = 0;
  let lineStart = 0;
  while (lineStart <= source.length && candidates < MAX_JSON_CANDIDATES) {
    let lineEnd = source.indexOf('\n', lineStart);
    if (lineEnd < 0) lineEnd = source.length;
    const line = source.slice(lineStart, lineEnd);
    const braceAt = line.indexOf('{');
    // 只认「这一行 `{` 之前全是空白」，即顶格起的 JSON 对象。
    if (braceAt >= 0 && line.slice(0, braceAt).trim() === '') {
      candidates += 1;
      const raw = sliceBalancedObject(source, lineStart + braceAt);
      if (raw) {
        try {
          found.push(JSON.parse(raw));
        } catch {
          /* 不是合法 JSON，跳过——日志里出现半截 JSON 是常态 */
        }
      }
    }
    lineStart = lineEnd + 1;
  }
  return found;
}

/** 从 start 处的 `{` 起做括号配平，字符串与转义感知。取不到闭合就返回 null。 */
function sliceBalancedObject(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** detail 既可能是 JSON 对象串，也可能是 `status=401 · keyEnv=X` 这种裸文本。 */
export function parseCheckDetail(detail: string): ReleaseGateCheckField[] {
  const trimmed = (detail || '').trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return Object.entries(parsed)
          .filter(([, value]) => value !== null && value !== undefined && value !== '')
          .map(([key, value]) => ({
            key,
            value: Array.isArray(value) ? value.join(', ') : String(value),
          }));
      }
    } catch {
      /* 落到下面的裸文本解析 */
    }
  }
  const pairs = trimmed.split(/[·\n]|\s{2,}/).map((part) => part.trim()).filter(Boolean);
  const fields: ReleaseGateCheckField[] = [];
  for (const part of pairs) {
    const eq = part.indexOf('=');
    if (eq > 0) fields.push({ key: part.slice(0, eq).trim(), value: part.slice(eq + 1).trim() });
  }
  return fields;
}

function toGateReport(value: unknown): ReleaseGateReport | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  const rawChecks = obj.checks;
  if (!Array.isArray(rawChecks) || rawChecks.length === 0) return null;
  const checks: ReleaseGateCheck[] = [];
  for (const item of rawChecks) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const entry = item as Record<string, unknown>;
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    if (!name) return null;
    if (typeof entry.ok !== 'boolean') return null;
    const detail = typeof entry.detail === 'string' ? entry.detail : '';
    checks.push({ name, ok: entry.ok, detail, fields: parseCheckDetail(detail) });
  }
  const passCount = checks.filter((check) => check.ok).length;
  return {
    verdict: typeof obj.verdict === 'string' ? obj.verdict : (passCount === checks.length ? 'pass' : 'fail'),
    checks,
    passCount,
    failCount: checks.length - passCount,
    totalCount: checks.length,
  };
}

/** 日志文本里所有能认出来的门禁报告，按出现顺序。 */
export function extractGateReports(text: string): ReleaseGateReport[] {
  const reports: ReleaseGateReport[] = [];
  for (const value of scanJsonObjects(text)) {
    const report = toGateReport(value);
    if (report) reports.push(report);
  }
  return reports;
}

/**
 * 挑出「该给人看的那一份」：优先最后一份判定为失败的；全通过时取最后一份。
 * 一次发布可能打出多份报告（MAP 预检 / 网关预检 / 健康预检），
 * 用户要的是**卡住这次发布的那一份**。
 */
export function pickGateReport(reports: ReadonlyArray<ReleaseGateReport>): ReleaseGateReport | undefined {
  const failing = reports.filter((report) => report.failCount > 0 || report.verdict.toLowerCase() === 'fail');
  if (failing.length > 0) return failing[failing.length - 1];
  return reports[reports.length - 1];
}

function dedupeKeepOrder(values: ReadonlyArray<string>, limit: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= limit) break;
  }
  return out;
}

export function isNoiseLine(message: string): boolean {
  return NOISE_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * 对未通过的检查项给一句人话。只在信号明确时开口：
 * 401/403 + keyEnv 就是「密钥不被对方认」，其余一律沉默。
 */
export function explainGateCheck(check: ReleaseGateCheck): string | undefined {
  const byKey = new Map(check.fields.map((field) => [field.key.toLowerCase(), field.value]));
  const status = byKey.get('status');
  const keyEnv = byKey.get('keyenv');
  if ((status === '401' || status === '403') && keyEnv) {
    return `密钥有值，但对方不认它：带 ${keyEnv} 调用返回 ${status}。最常见的原因是对端密钥已经轮换，而目标机上的那一份没有同步。`;
  }
  if (status === '0' || status === 'null') {
    return '目标地址没有返回任何 HTTP 状态，说明这一步压根没连上——先确认目标机上的服务在跑、端口和域名解析正确。';
  }
  const missing = byKey.get('missingprotocols') || byKey.get('missing');
  if (missing) {
    return `对方少了这些必需项：${missing}。这是能力缺失，不是网络问题，重试不会变好。`;
  }
  return undefined;
}

/**
 * 失败诊断入口。传入一次 run 的全部日志行。
 * 注意：即使 report 存在，errorLines / noiseLines 也照常给——
 * 结论归结论，原始证据不省略。
 */
export function diagnoseReleaseFailure(
  logs: ReadonlyArray<ReleaseDiagnosisLogLike>,
): ReleaseFailureDiagnosis {
  const messages = logs.map((log) => log.message || '');
  const text = messages.join('\n');
  const report = pickGateReport(extractGateReports(text));
  const failedChecks = report ? report.checks.filter((check) => !check.ok) : [];
  const errorLines = dedupeKeepOrder(
    logs.filter((log) => log.level === 'error').map((log) => log.message || ''),
    MAX_ERROR_LINES,
  );
  const noiseLines = dedupeKeepOrder(messages.filter(isNoiseLine), MAX_NOISE_LINES);

  let headline: string;
  if (report && failedChecks.length > 0) {
    headline = `发布门禁 ${report.totalCount} 项检查，未通过 ${failedChecks.length} 项：${failedChecks.map((check) => check.name).join('、')}`;
  } else if (errorLines.length > 0) {
    headline = errorLines[0];
  } else if (report) {
    headline = `发布门禁 ${report.totalCount} 项检查全部通过，失败发生在门禁之外的步骤`;
  } else {
    headline = '未能从日志中提取到结构化判据，请查看下方原始日志';
  }

  const humanHint = failedChecks.length > 0 ? explainGateCheck(failedChecks[0]) : undefined;

  return {
    headline,
    ...(report ? { report } : {}),
    failedChecks,
    errorLines,
    noiseLines,
    ...(humanHint ? { humanHint } : {}),
  };
}

/**
 * 「立即试跑一次」的结论文案。
 *
 * 这条结果**没有** `message` 字段（后端给的是 `{ ok, exitCode, log, error }`），
 * 而 log 的第一行恒为「本次只做检查、未发布」的安全横幅。所以原先的
 * `result.message || log 首行` 在成功和失败两种情况下都只显示那条横幅——
 * 用户看不到规则到底哪一项没过，也就无从修（Codex review P2，2026-07-29）。
 *
 * 失败时按「error → 日志里的 fail 行 → 兜底」逐级取，取到什么说什么。
 */
export function describeDryRunResult(
  result: { ok?: boolean; error?: string; log?: string } | undefined,
): string {
  if (!result) return '试跑完成：只执行了发布前检查，未发布';
  if (result.ok) return '试跑通过：发布前检查全部满足，未发布';

  const failedChecks = (result.log || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('[fail]') || line.startsWith('[warn]'));

  const detail = result.error?.trim() || failedChecks.join('；');
  return detail ? `试跑未通过：${detail}` : '试跑未通过：发布前检查存在阻塞项';
}

export interface DiskGuardShortfall {
  requiredMb: number;
  availableMb: number;
  shortfallMb: number;
  mountPoint: string;
}

/**
 * 从失败日志里认出「磁盘护栏」失败并算出差额。
 *
 * 判据对齐 scripts/llmgw-disk-space-guard.sh 的输出格式：
 * `requires at least <N>MB free on <mount>; available=<M>MB`。
 * 认出来之后 UI 才有资格给出「磁盘诊断」这一步——其他失败给这个按钮只是噪音。
 */
export function parseDiskGuardShortfall(
  logs: ReadonlyArray<ReleaseDiagnosisLogLike>,
): DiskGuardShortfall | null {
  for (const log of logs) {
    const match = /requires at least (\d+)MB free on (\S+); available=(\d+)MB/.exec(log.message);
    if (!match) continue;
    const requiredMb = Number(match[1]);
    const availableMb = Number(match[3]);
    if (!Number.isFinite(requiredMb) || !Number.isFinite(availableMb)) continue;
    return {
      requiredMb,
      availableMb,
      shortfallMb: Math.max(0, requiredMb - availableMb),
      mountPoint: match[2],
    };
  }
  return null;
}
