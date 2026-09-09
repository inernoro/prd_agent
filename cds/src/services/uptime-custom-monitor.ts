/**
 * uptime-custom-monitor — 监控中心「自定义探测目标」的校验、派生与探测实现。
 *
 * 分支预览服务与生产发布目标都是**系统替你盯**：目标从台账推导，用户不用填。
 * 这一类相反，是**你让系统盯**：第三方依赖、上游网关、还没接进 CDS 的旧服务。
 * 所以它有三件前两类没有的事——
 *
 *   1. 输入要校验（地址合法、端口范围、间隔上下限），且按最小输入原则派生
 *      能派生的字段（名称留空取主机名，状态码规则缺省 200-399）；
 *   2. 探测方式由用户选（HTTP 状态码 / 关键字 / TCP 端口），不是「打根路径看 < 500」；
 *   3. 可以手动暂停、可以改间隔与超时——但间隔只能比全局慢，不能更快：
 *      探测轮次仍由 uptime-monitor 的单一定时器驱动，这里只在轮次里判「到没到点」。
 *
 * 纯函数（校验 / 派生 / 状态码规则 / 目标推导）与副作用（真的发探测）分开放，
 * 前者全部有单测，后者只在轮次里被调用。
 */

import net from 'node:net';
import type { MonitorObservation, UptimeCustomMonitor, UptimeCustomMonitorKind } from '../types.js';
import {
  ASSERT_OPS,
  VALUELESS_OPS,
  describeAssertionFailure,
  evaluateAssertions,
  readPath,
  type AssertOp,
  type MonitorAssertion,
} from './monitor-assertions.js';
import type { UptimeSample } from './uptime-metrics.js';

/**
 * 探测记录的命名空间前缀。与 release-probe-target 的 `release@` 同理：分支键
 * 必含 `::`、分支 id 不含 `@`，三类键在结构上永不相撞。
 */
export const CUSTOM_PROBE_ID_PREFIX = 'monitor@';

export function customProbeTargetId(monitor: Pick<UptimeCustomMonitor, 'id'>): string {
  return `${CUSTOM_PROBE_ID_PREFIX}${monitor.id}`;
}

export const DEFAULT_EXPECTED_STATUS = '200-399';
/** 自定义间隔的上下限（秒）。下限再小也没意义——轮次本身按全局间隔跑。 */
export const MIN_MONITOR_INTERVAL_SECONDS = 20;
export const MAX_MONITOR_INTERVAL_SECONDS = 24 * 3600;
export const MIN_MONITOR_TIMEOUT_MS = 1_000;
export const MAX_MONITOR_TIMEOUT_MS = 60_000;
/** 关键字探测最多读多少响应体：够找关键字，又不会被一个无限流吃光内存。 */
const KEYWORD_BODY_LIMIT_BYTES = 512 * 1024;
const MAX_NAME_LENGTH = 80;
const MAX_TAGS = 10;

export const MONITOR_KINDS: ReadonlyArray<UptimeCustomMonitorKind> = ['http', 'keyword', 'tcp', 'health-json', 'functional'];

/** 功能监控保留多少次观测证据。看趋势够用，不做审计日志——无限增长会把台账撑爆。 */
export const MAX_OBSERVATIONS = 20;
/** 功能监控读响应体的上限：判据只看结构化字段，几百 KB 绰绰有余。 */
const FUNCTIONAL_BODY_LIMIT_BYTES = 512 * 1024;
/** 请求体模板上限，防止把一整个数据集塞进监控定义。 */
const MAX_REQUEST_BODY_CHARS = 4000;
const MAX_ASSERTIONS = 12;

/**
 * 随机提示词素材。
 *
 * 为什么必须随机：固定提示词会被上游缓存，跑一万次也只证明缓存还在，
 * 证明不了这条生成链路今天还活着——那正是这类监控要回答的问题。
 */
const PROMPT_SUBJECTS = [
  'a lighthouse on a basalt cliff', 'an empty tram at dawn', 'a greenhouse in winter',
  'a fox crossing a frozen river', 'a bookshop with a cat asleep', 'a harbor crane at dusk',
  'a desert observatory', 'a rowboat under willow branches',
];
const PROMPT_MOODS = [
  'long exposure', 'soft overcast light', 'high contrast noon', 'blue hour',
  'grainy film', 'backlit haze',
];

/** 展开请求体模板里的随机项。目前只有 {{randomPrompt}} 一个占位，刻意不做通用模板引擎。 */
export function expandRequestTemplate(template: string, pick: (n: number) => number = (n) => Math.floor(Math.random() * n)): string {
  if (!template.includes('{{randomPrompt}}')) return template;
  const subject = PROMPT_SUBJECTS[pick(PROMPT_SUBJECTS.length)] ?? PROMPT_SUBJECTS[0];
  const mood = PROMPT_MOODS[pick(PROMPT_MOODS.length)] ?? PROMPT_MOODS[0];
  // JSON 安全：提示词进的是 JSON 字符串字面量，双引号与反斜杠必须转义，
  // 否则一条带引号的素材会把整个请求体变成非法 JSON，表现为「监控自己坏了」。
  const safe = `${subject}, ${mood}`.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return template.split('{{randomPrompt}}').join(safe);
}

/** health-json 断言可取的字段与运算，都是有限枚举（见 types.ts 上的理由）。 */
export const HEALTH_FIELDS = ['status', 'observedValue'] as const;
export const HEALTH_OPS = ['eq', 'ne', 'lt', 'lte', 'gt', 'gte'] as const;
export type HealthAssertField = (typeof HEALTH_FIELDS)[number];
export type HealthAssertOp = (typeof HEALTH_OPS)[number];
/** health+json 是结构化小文档，512KB 足够；上限本身也是防无限流的闸。 */
const HEALTH_BODY_LIMIT_BYTES = 512 * 1024;

/** 用户可提交的原始输入（全部可选，由 normalize 决定哪些必填）。 */
export interface UptimeMonitorInput {
  id?: unknown;
  name?: unknown;
  kind?: unknown;
  url?: unknown;
  method?: unknown;
  expectedStatus?: unknown;
  keyword?: unknown;
  host?: unknown;
  port?: unknown;
  intervalSeconds?: unknown;
  timeoutMs?: unknown;
  projectId?: unknown;
  tags?: unknown;
  enabled?: unknown;
  healthComponentId?: unknown;
  healthField?: unknown;
  healthOp?: unknown;
  healthValue?: unknown;
  requestMethod?: unknown;
  requestBody?: unknown;
  assertions?: unknown;
  artifactUrlPath?: unknown;
}

export type NormalizeResult =
  | { ok: true; monitor: UptimeCustomMonitor }
  | { ok: false; error: string; field?: string };

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function optionalInt(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? Math.floor(n) : Number.NaN;
}

/**
 * 解析状态码规则：`200-299,301,404`。返回 null 表示写法不合法。
 * 每段要么是单个 100-599 的码，要么是 `a-b` 区间（a ≤ b）。
 */
export function parseStatusSpec(spec: string | undefined | null): Array<[number, number]> | null {
  const raw = (spec || '').trim() || DEFAULT_EXPECTED_STATUS;
  const ranges: Array<[number, number]> = [];
  for (const piece of raw.split(/[,，\s]+/).filter(Boolean)) {
    const m = /^(\d{3})(?:-(\d{3}))?$/.exec(piece);
    if (!m) return null;
    const lo = Number(m[1]);
    const hi = m[2] ? Number(m[2]) : lo;
    if (lo < 100 || hi > 599 || lo > hi) return null;
    ranges.push([lo, hi]);
  }
  return ranges.length > 0 ? ranges : null;
}

export function statusMatches(code: number, spec: string | undefined | null): boolean {
  const ranges = parseStatusSpec(spec);
  if (!ranges) return false;
  return ranges.some(([lo, hi]) => code >= lo && code <= hi);
}

function parseHttpUrl(raw: string): URL | null {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed;
  } catch {
    return null;
  }
}

/** 名称留空时的派生规则：http/keyword 取主机名（带非默认端口），tcp 取 host:port。 */
export function deriveMonitorName(input: {
  kind: UptimeCustomMonitorKind;
  url?: string;
  host?: string;
  port?: number;
}): string {
  if (input.kind === 'tcp') {
    return input.host && input.port ? `${input.host}:${input.port}` : (input.host || '');
  }
  const parsed = input.url ? parseHttpUrl(input.url) : null;
  if (!parsed) return '';
  return parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
}

function newMonitorId(): string {
  return `mon-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 把用户输入收敛成可落库的监控定义。返回的 error 是给人看的中文，field 指明
 * 哪个输入框该标红。
 */
/**
 * 功能监控的输入校验。
 *
 * 比其它 kind 严的两处，都是为了「加进去就能跑」而不是「加进去才发现跑不通」：
 *   1. 请求体展开随机项后必须是合法 JSON——模板里少一个引号，线上表现是这条监控
 *      从第一次探测起就红，而红的原因是监控自己写坏了，不是被监控的服务有问题；
 *   2. 至少要有一条判据——没有判据的「功能监控」只是在定时发请求，
 *      任何返回都算通过，是一条永远绿的假判据（比没有监控更糟）。
 */
function normalizeFunctionalInput(
  input: UptimeMonitorInput,
  monitor: UptimeCustomMonitor,
  existing?: UptimeCustomMonitor,
): NormalizeResult | { ok: true } {
  const method = (str(input.requestMethod).toUpperCase() || existing?.requestMethod || 'POST') as 'GET' | 'POST';
  if (method !== 'GET' && method !== 'POST') {
    return { ok: false, error: '功能监控的请求方法只支持 GET 或 POST', field: 'requestMethod' };
  }
  monitor.requestMethod = method;

  const rawBody = input.requestBody === undefined
    ? existing?.requestBody
    : (input.requestBody === null ? undefined : String(input.requestBody));
  if (rawBody !== undefined && rawBody.trim() !== '') {
    if (rawBody.length > MAX_REQUEST_BODY_CHARS) {
      return { ok: false, error: `请求体不能超过 ${MAX_REQUEST_BODY_CHARS} 个字符`, field: 'requestBody' };
    }
    // 用展开后的样子校验：模板里带 {{randomPrompt}} 时，真正发出去的是替换后的文本，
    // 校验原文只能证明「带占位符的字符串」合法，证明不了实际请求体合法。
    try {
      JSON.parse(expandRequestTemplate(rawBody));
    } catch {
      return { ok: false, error: '请求体展开随机项后不是合法 JSON', field: 'requestBody' };
    }
    monitor.requestBody = rawBody;
  }

  const rawAsserts = input.assertions === undefined ? existing?.assertions : input.assertions;
  if (!Array.isArray(rawAsserts) || rawAsserts.length === 0) {
    return { ok: false, error: '功能监控至少要有一条判据，否则任何返回都算通过', field: 'assertions' };
  }
  if (rawAsserts.length > MAX_ASSERTIONS) {
    return { ok: false, error: `判据最多 ${MAX_ASSERTIONS} 条`, field: 'assertions' };
  }
  const assertions: MonitorAssertion[] = [];
  for (const [i, raw] of rawAsserts.entries()) {
    if (!raw || typeof raw !== 'object') {
      return { ok: false, error: `第 ${i + 1} 条判据格式不对`, field: 'assertions' };
    }
    const item = raw as Record<string, unknown>;
    const path = str(item.path);
    if (!path) return { ok: false, error: `第 ${i + 1} 条判据缺少字段路径`, field: 'assertions' };
    if (path.length > 200) return { ok: false, error: `第 ${i + 1} 条判据的路径过长`, field: 'assertions' };
    const op = str(item.op) as AssertOp;
    if (!ASSERT_OPS.includes(op)) {
      return { ok: false, error: `第 ${i + 1} 条判据的运算必须是 ${ASSERT_OPS.join(' / ')}`, field: 'assertions' };
    }
    // 期望值允许是 "0"：判空看 undefined/空串，不用真值判断——
    // 「数量等于 0」这类判据正是最该被写出来的那种。
    const value = item.value === undefined || item.value === null ? undefined : String(item.value);
    if (!VALUELESS_OPS.includes(op) && (value === undefined || value.trim() === '')) {
      return { ok: false, error: `第 ${i + 1} 条判据（${op}）必须填期望值`, field: 'assertions' };
    }
    assertions.push({ path, op, ...(value === undefined ? {} : { value }) });
  }
  monitor.assertions = assertions;

  const artifactPath = input.artifactUrlPath === undefined
    ? existing?.artifactUrlPath
    : (input.artifactUrlPath === null ? undefined : str(input.artifactUrlPath));
  if (artifactPath) {
    if (artifactPath.length > 200) {
      return { ok: false, error: '产物路径过长', field: 'artifactUrlPath' };
    }
    monitor.artifactUrlPath = artifactPath;
  }

  // 观测证据跟着定义走：编辑判据不该把历史证据清掉，那是排障时唯一的对照。
  if (existing?.observations?.length) monitor.observations = existing.observations;
  return { ok: true };
}

export function normalizeUptimeMonitorInput(
  input: UptimeMonitorInput,
  options: { existing?: UptimeCustomMonitor; now?: () => number } = {},
): NormalizeResult {
  const kind = str(input.kind || options.existing?.kind) as UptimeCustomMonitorKind;
  if (!MONITOR_KINDS.includes(kind)) {
    return { ok: false, error: '探测方式必须是 http（状态码）、keyword（关键字）、health-json（自检端点判据）或 tcp（端口）之一', field: 'kind' };
  }

  const monitor: UptimeCustomMonitor = {
    id: str(input.id) || options.existing?.id || newMonitorId(),
    name: '',
    kind,
    enabled: input.enabled === undefined ? (options.existing?.enabled ?? true) : Boolean(input.enabled),
    createdAt: options.existing?.createdAt || new Date(options.now ? options.now() : Date.now()).toISOString(),
    updatedAt: new Date(options.now ? options.now() : Date.now()).toISOString(),
  };
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(monitor.id)) {
    return { ok: false, error: '监控 id 只能包含字母、数字、下划线与连字符，且不超过 64 位', field: 'id' };
  }

  if (kind === 'tcp') {
    const host = str(input.host) || options.existing?.host || '';
    const port = input.port === undefined ? options.existing?.port : optionalInt(input.port);
    if (!host) return { ok: false, error: 'TCP 探测必须填写主机名或 IP', field: 'host' };
    if (/[\s/]/.test(host)) return { ok: false, error: '主机名不能包含空格或斜杠', field: 'host' };
    if (port === undefined || Number.isNaN(port) || port < 1 || port > 65535) {
      return { ok: false, error: '端口必须是 1-65535 之间的整数', field: 'port' };
    }
    monitor.host = host;
    monitor.port = port;
  } else {
    const url = str(input.url) || options.existing?.url || '';
    if (!url) return { ok: false, error: '请填写要探测的地址（http:// 或 https:// 开头）', field: 'url' };
    if (!parseHttpUrl(url)) return { ok: false, error: '地址必须是合法的 http:// 或 https:// 网址', field: 'url' };
    monitor.url = url;

    if (kind === 'functional') {
      const verdict = normalizeFunctionalInput(input, monitor, options.existing);
      if (!verdict.ok) return verdict;
    }

    // 功能监控不吃下面这一整套：它的方法走 requestMethod（通常是 POST），判据看的是
    // 响应内容而不是状态码。硬套「GET/HEAD + 期望状态码」会让一条合法的 POST 监控
    // 根本存不进来，而报错还指着一个它没填过的字段。
    if (kind !== 'functional') {
      const method = str(input.method).toUpperCase() || options.existing?.method || 'GET';
      if (method !== 'GET' && method !== 'HEAD') {
        return { ok: false, error: '请求方法只支持 GET 或 HEAD', field: 'method' };
      }
      // 关键字与 health-json 都要读响应体，HEAD 没有响应体——写了也是永远失败，直接拒掉。
      if ((kind === 'keyword' || kind === 'health-json') && method === 'HEAD') {
        return {
          ok: false,
          error: kind === 'keyword'
            ? '关键字探测需要读取响应体，请求方法只能用 GET'
            : 'health-json 探测需要读取响应体，请求方法只能用 GET',
          field: 'method',
        };
      }
      monitor.method = method;
      // 状态码规则三种输入：没传 = 沿用旧值；传 null = 清掉自定义、回到默认；传字符串 = 用它。
      // 编辑弹窗把清空的输入框发成 null——发成「不传」的话永远改不回默认（Codex PR #1514 P2）。
      const expectedStatus = input.expectedStatus === null
        ? DEFAULT_EXPECTED_STATUS
        : (str(input.expectedStatus) || options.existing?.expectedStatus || DEFAULT_EXPECTED_STATUS);
      if (!parseStatusSpec(expectedStatus)) {
        return { ok: false, error: '状态码规则写法不合法，示例：200-299 或 200-399,401', field: 'expectedStatus' };
      }
      monitor.expectedStatus = expectedStatus;
      if (kind === 'keyword') {
        const keyword = typeof input.keyword === 'string' ? input.keyword : (options.existing?.keyword || '');
        if (!keyword.trim()) return { ok: false, error: '关键字探测必须填写要匹配的文本', field: 'keyword' };
        if (keyword.length > 200) return { ok: false, error: '关键字不能超过 200 个字符', field: 'keyword' };
        monitor.keyword = keyword;
      }
      if (kind === 'health-json') {
        const componentId = str(input.healthComponentId) || options.existing?.healthComponentId || '';
        if (!componentId) {
          return { ok: false, error: 'health-json 探测必须指定要断言的 componentId', field: 'healthComponentId' };
        }
        if (componentId.length > 200) {
          return { ok: false, error: 'componentId 不能超过 200 个字符', field: 'healthComponentId' };
        }
        const field = (str(input.healthField) || options.existing?.healthField || 'observedValue') as HealthAssertField;
        if (!HEALTH_FIELDS.includes(field)) {
          return { ok: false, error: `断言字段只能是 ${HEALTH_FIELDS.join(' / ')}`, field: 'healthField' };
        }
        const op = (str(input.healthOp) || options.existing?.healthOp || 'eq') as HealthAssertOp;
        if (!HEALTH_OPS.includes(op)) {
          return { ok: false, error: `比较运算只能是 ${HEALTH_OPS.join(' / ')}`, field: 'healthOp' };
        }
        // 期望值允许是 "0"，所以判空要看 undefined/空串，不能用真值判断——
        // 「未处理异常数 == 0」正是最该被监控的那一条，用真值判断会把它拒掉。
        const rawValue = input.healthValue === undefined || input.healthValue === null
          ? options.existing?.healthValue
          : String(input.healthValue);
        const value = (rawValue ?? '').trim();
        if (value === '') {
          return { ok: false, error: 'health-json 探测必须填写期望值', field: 'healthValue' };
        }
        if (value.length > 200) {
          return { ok: false, error: '期望值不能超过 200 个字符', field: 'healthValue' };
        }
        monitor.healthComponentId = componentId;
        monitor.healthField = field;
        monitor.healthOp = op;
        monitor.healthValue = value;
      }
    }
  }

  // 名称：显式传了就用（传空串 = 要求重新派生）；没传则沿用旧名；都没有才派生。
  const name = (input.name === undefined ? (options.existing?.name || '') : str(input.name)).slice(0, MAX_NAME_LENGTH);
  monitor.name = name || deriveMonitorName(monitor);
  if (!monitor.name) return { ok: false, error: '请填写监控名称', field: 'name' };

  // 间隔 / 超时同上：null = 回到全局默认（optionalInt 把 null 收成 undefined，而下面的
  // 「沿用旧值」分支只认真正没传的 undefined）。
  const interval = optionalInt(input.intervalSeconds);
  if (interval !== undefined) {
    if (Number.isNaN(interval) || interval < MIN_MONITOR_INTERVAL_SECONDS || interval > MAX_MONITOR_INTERVAL_SECONDS) {
      return {
        ok: false,
        error: `探测间隔必须在 ${MIN_MONITOR_INTERVAL_SECONDS}-${MAX_MONITOR_INTERVAL_SECONDS} 秒之间`,
        field: 'intervalSeconds',
      };
    }
    monitor.intervalSeconds = interval;
  } else if (options.existing?.intervalSeconds && input.intervalSeconds === undefined) {
    monitor.intervalSeconds = options.existing.intervalSeconds;
  }

  const timeout = optionalInt(input.timeoutMs);
  if (timeout !== undefined) {
    if (Number.isNaN(timeout) || timeout < MIN_MONITOR_TIMEOUT_MS || timeout > MAX_MONITOR_TIMEOUT_MS) {
      return {
        ok: false,
        error: `超时必须在 ${MIN_MONITOR_TIMEOUT_MS}-${MAX_MONITOR_TIMEOUT_MS} 毫秒之间`,
        field: 'timeoutMs',
      };
    }
    monitor.timeoutMs = timeout;
  } else if (options.existing?.timeoutMs && input.timeoutMs === undefined) {
    monitor.timeoutMs = options.existing.timeoutMs;
  }

  const projectId = input.projectId === undefined ? (options.existing?.projectId ?? null) : (str(input.projectId) || null);
  monitor.projectId = projectId;

  if (input.tags !== undefined) {
    if (!Array.isArray(input.tags)) return { ok: false, error: '标签必须是字符串数组', field: 'tags' };
    const tags = [...new Set(input.tags.map((t) => str(t)).filter(Boolean))].slice(0, MAX_TAGS);
    monitor.tags = tags;
  } else if (options.existing?.tags) {
    monitor.tags = options.existing.tags;
  }
  if (options.existing?.createdBy) monitor.createdBy = options.existing.createdBy;

  return { ok: true, monitor };
}

/** 一句人话描述探测方式，列表与详情页直接展示。 */
/**
 * 从 health+json 文档里找出目标 check。
 *
 * IETF draft-inadarei-api-health-check 的 checks 是
 * `{"组件:度量": [{componentId, observedValue, status, ...}]}`；实现里也常见
 * 简化成数组或单对象。这三种都认，匹配顺序是「先认 componentId 字段，再认键名」——
 * 键名带 `:度量` 后缀，所以只在没有 componentId 时才退回它。
 *
 * 找不到返回 undefined，**调用方必须把这当失败**：判据指向一条不存在的 check，
 * 说明自检端点和监控声明已经对不上了，那是接线断了，不是「没问题」。
 */
export function findHealthCheck(doc: unknown, componentId: string): Record<string, unknown> | undefined {
  if (!doc || typeof doc !== 'object') return undefined;
  const checks = (doc as Record<string, unknown>).checks;
  if (!checks || typeof checks !== 'object') return undefined;

  const entries: Array<[string, unknown]> = Array.isArray(checks)
    ? checks.map((item, i) => [String(i), item])
    : Object.entries(checks as Record<string, unknown>);

  const items: Array<[string, Record<string, unknown>]> = [];
  for (const [key, value] of entries) {
    const list = Array.isArray(value) ? value : [value];
    for (const item of list) {
      if (item && typeof item === 'object') items.push([key, item as Record<string, unknown>]);
    }
  }
  const byComponentId = items.find(([, item]) => item.componentId === componentId);
  if (byComponentId) return byComponentId[1];
  const byKey = items.find(([key]) => key === componentId);
  return byKey?.[1];
}

export interface HealthCheckEvaluation {
  ok: boolean;
  /** 实际读到的值，失败信息里要带上它，否则排障还得自己再打一次端点 */
  observed?: string;
  err?: string;
}

/**
 * 按结构化判据评估一条 check。
 *
 * 只有有限的字段与运算（见 HEALTH_FIELDS / HEALTH_OPS）——不解析表达式。
 * 大小比较强制两边都是数字，字符串比较则先把数字规范化，
 * 免得 `0` 与 `"0"` 被判成不等这种纯粹由类型引起的假故障。
 */
export function evaluateHealthJson(
  raw: string,
  componentId: string,
  field: HealthAssertField,
  op: HealthAssertOp,
  expected: string,
): HealthCheckEvaluation {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return { ok: false, err: '响应不是合法 JSON（health-json 探测要求 application/health+json）' };
  }
  const check = findHealthCheck(doc, componentId);
  if (!check) {
    return { ok: false, err: `响应里没有 componentId 为「${componentId}」的 check——自检端点与监控声明已经对不上` };
  }
  const rawValue = check[field];
  if (rawValue === undefined || rawValue === null) {
    return { ok: false, err: `check「${componentId}」没有 ${field} 字段` };
  }
  const observed = String(rawValue);

  if (op === 'lt' || op === 'lte' || op === 'gt' || op === 'gte') {
    const a = Number(observed);
    const b = Number(expected);
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      return { ok: false, observed, err: `${field}=${observed} 或期望值 ${expected} 不是数字，无法做大小比较` };
    }
    const ok = op === 'lt' ? a < b : op === 'lte' ? a <= b : op === 'gt' ? a > b : a >= b;
    return ok ? { ok: true, observed } : { ok: false, observed, err: `${field}=${observed}，期望 ${op} ${expected}` };
  }

  // eq / ne：数字先规范化再比，避免 0 与 "0"、1.0 与 "1" 这种假故障
  const normalize = (v: string): string => (Number.isFinite(Number(v)) && v.trim() !== '' ? String(Number(v)) : v);
  const same = normalize(observed) === normalize(expected);
  const ok = op === 'eq' ? same : !same;
  return ok
    ? { ok: true, observed }
    : { ok: false, observed, err: `${field}=${observed}，期望 ${op === 'eq' ? '等于' : '不等于'} ${expected}` };
}

/** 某个项目名下一条分支的预览主机名，用于自助登记时的地址反查。 */
export interface ProjectPreviewHost {
  branchId: string;
  host: string;
}

export type ProjectScopedWriteVerdict =
  | { ok: true; boundBranchId: string }
  | { ok: false; error: string; field?: string };

/**
 * 项目级 Key 自助登记监控的准入判定（2026-09-09）。
 *
 * 背景：自定义监控的写接口原本对项目级 Key 一律 403。那条边界的理由写得很具体
 * （见 routes/uptime.ts 的 denyProjectScopedWrite），是两个实打实的风险，不是
 * 「项目 Key 不可信」这种笼统判断：
 *
 *   风险 A  借 CDS 主机扫回环、内网、别的项目的内部服务（SSRF）；
 *   风险 B  关键字探测把响应内容当 oracle 透出来。
 *
 * 所以这里不是把边界拆掉，而是开一条**同时堵死这两个风险**的窄路：
 *
 *   规则 1  只能写自己项目名下的监控          → 堵「改别人的」
 *   规则 2  kind 只能是 health-json           → 堵风险 B：判据是结构化比较，
 *           不像 keyword 那样能拿任意响应体当探针回显
 *   规则 3  url 必须落在**该项目自己的**分支预览主机上 → 堵风险 A：
 *           地址由服务端从项目的分支台账反查，调用方报什么地址都没用
 *
 * 规则 3 顺带解决了另一个问题：反查出来的 branchId 会被钉进 boundBranchId，
 * 于是这条监控的寿命跟着那条分支走——临时分支删掉时监控一起消失，
 * 不会留下一条永远红着的死地址（这是用户最担心的那种失效）。
 */
export function evaluateProjectScopedWrite(
  monitor: Pick<UptimeCustomMonitor, 'kind' | 'url' | 'projectId'>,
  scope: string,
  previewHosts: ProjectPreviewHost[],
): ProjectScopedWriteVerdict {
  if (!scope) return { ok: false, error: '缺少项目作用域' };
  if (monitor.projectId && monitor.projectId !== scope) {
    return {
      ok: false,
      error: '项目级 Key 只能登记自己项目名下的监控',
      field: 'projectId',
    };
  }
  if (monitor.kind !== 'health-json') {
    return {
      ok: false,
      error: '项目级 Key 只能登记 health-json 监控：它的判据是结构化比较，'
        + '不会像关键字探测那样把任意响应体透出来。其它探测方式请管理员添加',
      field: 'kind',
    };
  }
  let host = '';
  try {
    host = new URL(monitor.url || '').host.toLowerCase();
  } catch {
    return { ok: false, error: '地址必须是合法的 http:// 或 https:// 网址', field: 'url' };
  }
  if (previewHosts.length === 0) {
    return {
      ok: false,
      error: '这个项目名下还没有已部署的分支，没有可登记的地址',
      field: 'url',
    };
  }
  const hit = previewHosts.find((x) => x.host.toLowerCase() === host);
  if (!hit) {
    return {
      ok: false,
      // 报出可选项，省得调用方靠猜——但只报本项目的，不泄漏别的项目有哪些分支。
      error: `地址 ${host} 不属于本项目任何一条分支的预览域名。`
        + `可登记的是：${previewHosts.map((x) => x.host).join('、')}`,
      field: 'url',
    };
  }
  return { ok: true, boundBranchId: hit.branchId };
}

export function describeMonitorProbe(monitor: Pick<UptimeCustomMonitor, 'kind' | 'url' | 'method' | 'expectedStatus' | 'keyword' | 'healthComponentId' | 'healthField' | 'healthOp' | 'healthValue' | 'requestMethod' | 'requestBody' | 'assertions' | 'artifactUrlPath' | 'host' | 'port'>): string {
  if (monitor.kind === 'tcp') return `TCP 连接 ${monitor.host}:${monitor.port}`;
  const method = monitor.method || 'GET';
  const status = monitor.expectedStatus || DEFAULT_EXPECTED_STATUS;
  if (monitor.kind === 'keyword') return `${method} ${monitor.url} · 状态 ${status} 且响应含「${monitor.keyword}」`;
  if (monitor.kind === 'health-json') {
    return `${method} ${monitor.url} · 状态 ${status} 且 check「${monitor.healthComponentId}」的 `
      + `${monitor.healthField} ${monitor.healthOp} ${monitor.healthValue}`;
  }
  if (monitor.kind === 'functional') {
    const asserts = (monitor.assertions || [])
      .map((a) => `${a.path} ${a.op}${a.value === undefined ? '' : ` ${a.value}`}`)
      .join('；');
    const random = monitor.requestBody?.includes('{{randomPrompt}}') ? '（每次随机提示词）' : '';
    return `${monitor.requestMethod || 'POST'} ${monitor.url}${random} · 断言 ${asserts || '（未配置）'}`;
  }
  return `${method} ${monitor.url} · 状态 ${status}`;
}

// ── 探测实现（副作用） ──

export type CustomProbeOutcome = Omit<UptimeSample, 't'> & {
  /**
   * 功能监控这一次留下的证据。存活监控为空。
   * 轮次拿到它写进监控定义的 observations——判定归判定，证据归证据，两件事。
   */
  observation?: MonitorObservation;
};

/**
 * 功能监控：把业务真跑一遍，再在响应上逐条判。
 *
 * 与 health-json 的分工：那个问「服务自己觉得健康吗」，读的是服务给出的自检结论；
 * 这个问「这条业务现在还能用吗」，自己发一次真请求，按调用方的判据验收返回值。
 * 前者抓「后台在炸」，后者抓「后台没炸但产出不对」——2026-09-09 那次 500 属于前者，
 * 「生图接口通、返回的却是 512×512」属于后者，两种都得有人盯。
 */
async function functionalProbe(
  monitor: Pick<UptimeCustomMonitor, 'url' | 'requestMethod' | 'requestBody' | 'assertions' | 'artifactUrlPath'>,
  timeoutMs: number,
): Promise<CustomProbeOutcome> {
  const startedAt = Date.now();
  const method = monitor.requestMethod || 'POST';
  const requestBody = monitor.requestBody ? expandRequestTemplate(monitor.requestBody) : undefined;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  const observation = (extra: Partial<MonitorObservation>): MonitorObservation => ({
    at: new Date(startedAt).toISOString(),
    ok: false,
    elapsedMs: Date.now() - startedAt,
    results: [],
    ...(requestBody ? { requestBody } : {}),
    ...extra,
  });

  try {
    const res = await fetch(monitor.url || '', {
      method,
      signal: ctrl.signal,
      redirect: 'manual',
      // 与其它自定义探测同款：绝不把探测令牌发给外部地址，只带公开的 polling 分类头。
      headers: {
        'user-agent': 'cds-uptime-monitor',
        'x-cds-poll': 'true',
        ...(requestBody ? { 'content-type': 'application/json' } : {}),
      },
      ...(requestBody && method !== 'GET' ? { body: requestBody } : {}),
    });
    const code = res.status;
    const raw = await readBodyPrefix(res, FUNCTIONAL_BODY_LIMIT_BYTES);

    let doc: unknown;
    try {
      doc = JSON.parse(raw);
    } catch {
      const err = `响应不是合法 JSON（HTTP ${code}）`;
      return { up: false, ms: Date.now() - startedAt, code, err, observation: observation({ code, err }) };
    }

    const { ok, results } = evaluateAssertions(doc, (monitor.assertions || []) as MonitorAssertion[]);
    // 产物地址即使判据失败也要留：那张「不该是 512×512」的图正是排障要看的东西。
    const artifactRaw = monitor.artifactUrlPath ? readPath(doc, monitor.artifactUrlPath) : undefined;
    const artifactUrl = typeof artifactRaw === 'string' && artifactRaw.length > 0 ? artifactRaw : undefined;

    const obs = observation({
      ok,
      code,
      results,
      ...(artifactUrl ? { artifactUrl } : {}),
    });
    return ok
      ? { up: true, ms: Date.now() - startedAt, code, observation: obs }
      : { up: false, ms: Date.now() - startedAt, code, err: describeAssertionFailure(results), observation: obs };
  } catch (err) {
    const aborted = (err as Error).name === 'AbortError';
    const message = aborted
      ? `请求超时（${timeoutMs}ms）`
      : ((err as Error & { cause?: Error }).cause?.message || (err as Error).message);
    return {
      up: false,
      ms: Date.now() - startedAt,
      err: message,
      observation: observation({ err: message }),
    };
  } finally {
    clearTimeout(timer);
  }
}

function tcpProbe(host: string, port: number, timeoutMs: number): Promise<CustomProbeOutcome> {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: CustomProbeOutcome): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    const socket = net.connect({ host, port });
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish({ up: true, ms: Date.now() - startedAt }));
    socket.once('timeout', () => finish({ up: false, ms: Date.now() - startedAt, err: `连接超时（${timeoutMs}ms）` }));
    socket.once('error', (err) => finish({ up: false, ms: Date.now() - startedAt, err: (err as Error).message }));
  });
}

async function readBodyPrefix(res: Response, limitBytes: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let received = 0;
  try {
    while (received < limitBytes) {
      const { value, done } = await reader.read();
      if (done) break;
      received += value.byteLength;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return text;
}

async function httpProbe(
  monitor: Pick<UptimeCustomMonitor, 'kind' | 'url' | 'method' | 'expectedStatus' | 'keyword' | 'healthComponentId' | 'healthField' | 'healthOp' | 'healthValue'>,
  timeoutMs: number,
): Promise<CustomProbeOutcome> {
  const startedAt = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(monitor.url || '', {
      method: monitor.method || 'GET',
      signal: ctrl.signal,
      redirect: 'manual',
      // 自定义目标是任意外部地址，探测令牌绝不能发出去（会被对端记下并回放到预览
      // 域名上豁免 LRU）；只带公开的 polling 分类头。
      headers: { 'user-agent': 'cds-uptime-monitor', 'x-cds-poll': 'true' },
    });
    const code = res.status;
    if (!statusMatches(code, monitor.expectedStatus)) {
      await res.body?.cancel().catch(() => undefined);
      return { up: false, ms: Date.now() - startedAt, code, err: `HTTP ${code}，不在期望范围 ${monitor.expectedStatus || DEFAULT_EXPECTED_STATUS}` };
    }
    if (monitor.kind === 'keyword') {
      const body = await readBodyPrefix(res, KEYWORD_BODY_LIMIT_BYTES);
      if (!body.includes(monitor.keyword || '')) {
        return { up: false, ms: Date.now() - startedAt, code, err: `响应中未找到关键字「${monitor.keyword}」` };
      }
    } else if (monitor.kind === 'health-json') {
      const body = await readBodyPrefix(res, HEALTH_BODY_LIMIT_BYTES);
      const verdict = evaluateHealthJson(
        body,
        monitor.healthComponentId || '',
        monitor.healthField || 'observedValue',
        monitor.healthOp || 'eq',
        monitor.healthValue || '',
      );
      if (!verdict.ok) {
        // 判据不成立时 HTTP 往往仍是 200——「接口通但结论是坏的」正是这类探测的存在意义。
        return { up: false, ms: Date.now() - startedAt, code, err: verdict.err };
      }
    } else {
      await res.body?.cancel().catch(() => undefined);
    }
    return { up: true, ms: Date.now() - startedAt, code };
  } catch (err) {
    const aborted = (err as Error).name === 'AbortError';
    return {
      up: false,
      ms: Date.now() - startedAt,
      err: aborted ? `探测超时（${timeoutMs}ms）` : ((err as Error & { cause?: Error }).cause?.message || (err as Error).message),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 按监控定义发一次探测。timeoutMs 由调用方结算（监控自身 > 全局）。 */
export async function probeCustomMonitor(
  monitor: Pick<UptimeCustomMonitor, 'kind' | 'url' | 'method' | 'expectedStatus' | 'keyword' | 'healthComponentId' | 'healthField' | 'healthOp' | 'healthValue' | 'requestMethod' | 'requestBody' | 'assertions' | 'artifactUrlPath' | 'host' | 'port'>,
  timeoutMs: number,
): Promise<CustomProbeOutcome> {
  if (monitor.kind === 'tcp') {
    if (!monitor.host || !monitor.port) return { up: false, ms: 0, err: 'TCP 目标缺少主机或端口' };
    return await tcpProbe(monitor.host, monitor.port, timeoutMs);
  }
  if (!monitor.url) return { up: false, ms: 0, err: '未配置探测地址' };
  if (monitor.kind === 'functional') return await functionalProbe(monitor, timeoutMs);
  return await httpProbe(monitor, timeoutMs);
}
