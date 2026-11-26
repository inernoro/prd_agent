import { getDomain } from 'tldts';
import type { DesignRule, DesignScreen, DesignVersion } from '../shared/design-workspace.js';
import { inspectDesignAcceptance, type DesignAcceptanceIssue } from '../shared/design-acceptance-standard.mjs';
import { PlanningError, rejectPlanning } from './engineering-planning-input.js';

type GateNumber = 'G-01' | 'G-02' | 'G-03' | 'G-04' | 'G-05' | 'G-06' | 'G-07' | 'G-08' | 'G-09';
type HistoryVersion = Pick<DesignVersion, 'version' | 'sourceCommit' | 'acceptance' | 'screens' | 'delivery'>;
export type DesignPublicationGateContext = {
  history: readonly HistoryVersion[];
  designId?: string;
  sourceCommit?: string;
  publicBaseUrl?: string;
};
type GateInput = {
  manifest: Record<string, unknown>;
  archiveBytes: number;
  files: ReadonlyMap<string, Buffer>;
  indexedFiles: ReadonlyArray<{ path: string; sha256: string }>;
  screens: readonly DesignScreen[];
  acceptance: readonly DesignRule[];
};

export const designPublicationGateLimit = Math.floor(4 * 1024 * 1024 * 0.95);
export function rejectDesignGate(rule: GateNumber, message: string): never {
  return rejectPlanning(400, rule, `${rule} ${message}`);
}

export class DesignAcceptanceGateError extends PlanningError {
  constructor(public readonly issues: DesignAcceptanceIssue[]) {
    super(400, 'G-11', 'G-11 请补齐验收计划和覆盖维度。');
  }
}

const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const text = (value: unknown): value is string => typeof value === 'string' && Boolean(value.trim());
const integer = (value: unknown, min: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min;
const decoder = new TextDecoder('utf-8', { fatal: true });
function readText(bytes: Buffer | undefined): string | undefined {
  if (!bytes) return undefined;
  try { return decoder.decode(bytes); } catch { return undefined; }
}
function readObject(files: GateInput['files'], name: string): Record<string, unknown> | undefined {
  try { return object(JSON.parse(readText(files.get(name)) ?? '')); } catch { return undefined; }
}

function validateManifest(input: GateInput) {
  const { manifest, files } = input;
  if (!['project', 'title', 'rationale', 'prototype', 'checks'].every(key => text(manifest[key]))
    || !integer(manifest.prototypeVersion, 1) || !text(manifest.date) || !/^\d{4}-\d{2}-\d{2}$/.test(manifest.date)
    || typeof manifest.notes !== 'string' || !Array.isArray(manifest.docs) || !manifest.docs.every(text)
    || !Array.isArray(manifest.screens) || !Array.isArray(manifest.acceptance)
    || (manifest.id !== undefined && !text(manifest.id))
    || (manifest.framework != null && (!text(manifest.framework) || !integer(manifest.frameworkVersion, 1)))) {
    rejectDesignGate('G-01', 'design.json 的必填字段、原型版本或日期格式无效');
  }
  for (const item of manifest.screens) {
    const row = object(item);
    if (!row || !text(row.id) || !/^[a-z0-9][a-z0-9-]*$/.test(row.id)
      || !text(row.route) || !row.route.startsWith('#/') || !text(row.entryReadySelector)
      || !Array.isArray(row.themes) || !row.themes.length) {
      rejectDesignGate('G-02', '请为每个画面填写唯一编号、#/ 路由、视口、主题和就绪选择器');
    }
  }
  for (const item of input.acceptance) {
    if (!/^A-\d{2,3}$/.test(item.id) || !item.screenId || !text(item.expected)
      || (item.how === 'measure' && !item.expected.includes('检查：'))) {
      rejectDesignGate('G-03', '验收项须引用画面并填写规则和预期，测量预期须包含「检查：」');
    }
  }
  const references = [manifest.rationale, manifest.prototype, manifest.checks, ...manifest.docs];
  if (references.some(name => typeof name !== 'string' || !files.has(name))) {
    rejectDesignGate('G-04', '请补齐 design.json 引用的思路、原型、自检和文档');
  }
}

function validateChecks(files: GateInput['files'], checksPath: string) {
  const results = readObject(files, checksPath);
  const allowances = files.has('tools/gate-allow.json') ? readObject(files, 'tools/gate-allow.json') : {};
  if (!allowances || (allowances.checks !== undefined && !Array.isArray(allowances.checks))) {
    rejectDesignGate('G-05', '门禁例外登记须使用有效的自检条目列表');
  }
  const exceptions = new Set<string>();
  for (const value of (allowances.checks as unknown[] | undefined) ?? []) {
    const entry = object(value);
    if (!entry || !text(entry.name) || !text(entry.owner) || !text(entry.reason) || exceptions.has(entry.name)) {
      rejectDesignGate('G-05', '自检例外须有唯一名称、负责人和理由');
    }
    exceptions.add(entry.name);
  }
  if (!results || !Array.isArray(results.items) || results.total !== results.items.length) {
    rejectDesignGate('G-05', '自检总数须与条目数量一致');
  }
  let passed = 0;
  for (const value of results.items) {
    const item = object(value);
    if (!item || !text(item.name) || typeof item.pass !== 'boolean') {
      rejectDesignGate('G-05', '自检条目须提供名称和布尔值结果');
    }
    if (item.pass) passed++;
    else if (!exceptions.has(item.name)) rejectDesignGate('G-05', '未通过的自检须登记负责人和理由');
  }
  if (results.passed !== passed) rejectDesignGate('G-05', '自检通过数须与结果一致');
  return allowances;
}

function validateHeadings(files: GateInput['files'], next: number) {
  for (const name of ['思路.md', '交付说明.md']) {
    const body = readText(files.get(name));
    const heading = body?.match(/^#[ \t]+([^\r\n]+)$/m)?.[1];
    if (!heading?.includes(`（V${next}）`)) rejectDesignGate('G-06', `${name} 的标题须标明（V${next}）`);
    if (name === '交付说明.md' && /__[A-Z]+__|TODO|待填/.test(body ?? '')) {
      rejectDesignGate('G-06', '交付说明仍有占位符');
    }
  }
}

const deltaKeys = ['added', 'removed', 'changed'] as const;
function deltaIds<T extends { id: string }>(before: readonly T[], after: readonly T[], fields: ReadonlyArray<keyof T>) {
  const left = new Map(before.map(row => [row.id, row]));
  const right = new Map(after.map(row => [row.id, row]));
  return {
    added: after.filter(row => !left.has(row.id)).map(row => row.id).sort(),
    removed: before.filter(row => !right.has(row.id)).map(row => row.id).sort(),
    changed: after.filter(row => {
      const old = left.get(row.id);
      return old && fields.some(key => JSON.stringify(old[key] ?? null) !== JSON.stringify(row[key] ?? null));
    }).map(row => row.id).sort(),
  };
}

function validDelta(count: unknown, rows: unknown, actual: ReturnType<typeof deltaIds>) {
  const counts = object(count);
  const details = object(rows);
  return deltaKeys.every(key => {
    const values = details?.[key];
    return counts?.[key] === actual[key].length && Array.isArray(values) && values.every(row => text(object(row)?.id))
      && JSON.stringify(values.map(row => row.id).sort()) === JSON.stringify(actual[key]);
  });
}

function sourceHashes(rows: GateInput['indexedFiles']) {
  return new Map(rows.filter(row => row.path.startsWith('src/')).map(row => [row.path, row.sha256]));
}

function validateHistory(input: GateInput, context: DesignPublicationGateContext, next: number) {
  const { files } = input;
  const { history } = context;
  const registry = readObject(files, 'versions.json');
  const index = readObject(files, 'changes/index.json');
  if (!registry || !index || !Array.isArray(registry.versions) || !Array.isArray(index.from)
    || (registry.design !== undefined && registry.design !== context.designId)
    || index.to !== next || registry.versions.length !== history.length || index.from.length !== history.length) {
    rejectDesignGate('G-07', `版本登记和差异索引须覆盖 CDS 中的全部历史，并指向 V${next}`);
  }
  const currentSources = sourceHashes(input.indexedFiles);
  for (const [position, old] of history.entries()) {
    const previous = object(registry.versions[position]);
    const row = object(index.from[position]);
    const prefix = `changes/v${old.version}-v${next}/`;
    const summaryPath = prefix + 'summary.json';
    const documentPath = prefix + 'changes.md';
    const patchPath = prefix + 'source.diff';
    if (previous?.version !== old.version || previous.commit !== old.sourceCommit || row?.version !== old.version || row.commit !== old.sourceCommit
      || !Array.isArray(row.files) || !row.files.includes(summaryPath) || !row.files.includes(documentPath)
      || new Set(row.files).size !== row.files.length
      || row.files.some(name => ![summaryPath, documentPath, patchPath].includes(name) || !files.has(name))
      || !text(readText(files.get(documentPath)))) {
      rejectDesignGate('G-07', `V${old.version} 的登记提交或差异文件与 CDS 记录不符`);
    }
    const summary = readObject(files, summaryPath);
    const from = object(summary?.from);
    const to = object(summary?.to);
    const sources = object(summary?.source);
    const patchSize = files.get(patchPath)?.length;
    if (!summary || summary.direction !== 'upgrade' || from?.version !== old.version || from.commit !== old.sourceCommit
      || to?.version !== next || (to.commit != null && to.commit !== context.sourceCommit)
      || !integer(row.sourceFiles, 0) || sources?.files !== row.sourceFiles || !integer(sources.bytes, 0)
      || (patchSize !== undefined && (!row.files.includes(patchPath) || sources.bytes !== patchSize))
      || !validDelta(row.screens, summary.screens, deltaIds(old.screens, input.screens, ['name', 'route', 'viewport', 'entryActions']))
      || !validDelta(row.acceptance, summary.acceptance, deltaIds(old.acceptance, input.acceptance, ['rule', 'expected', 'how', 'screenId', 'priority', 'slots', 'interaction']))) {
      rejectDesignGate('G-07', `V${old.version} 的差异摘要与实际稿件变化不符`);
    }
    if (old.delivery) {
      const priorSources = sourceHashes(old.delivery.files);
      const changed = [...new Set([...priorSources.keys(), ...currentSources.keys()])]
        .filter(name => priorSources.get(name) !== currentSources.get(name));
      if (changed.length !== row.sourceFiles) rejectDesignGate('G-07', `V${old.version} 的源码文件数与实际变化不符`);
    }
  }
}

const secret = /(?<![A-Za-z0-9_])(?:cds[kp]_[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})|-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const email = /[a-z0-9._%+-]{1,64}@([a-z0-9.-]{1,253}\.[a-z]{2,63})\b/gi;
const exampleDomain = /(?:^|\.)example\.(?:com|org|net|test|invalid)$|\.(?:example|invalid)$/i;
const domainPattern = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i;
const textFile = /\.(?:mdx?|txt|json|ya?ml|html?|css|[cm]?js|[tj]sx?|csv|toml|xml|svg|diff|env|ini)$/i;
function validatePrivacy(files: GateInput['files'], allowances: Record<string, unknown>, publicBaseUrl?: string) {
  let hostedDomain: string | undefined;
  if (publicBaseUrl) {
    try {
      const hostname = new URL(publicBaseUrl).hostname;
      hostedDomain = getDomain(hostname) ?? (hostname.includes('.') && !hostname.startsWith('127.') ? hostname : undefined);
    } catch { /* A deployment without a public URL still rejects credentials and emails. */ }
  }
  const requested = allowances.forbiddenHosts ?? [];
  if (!Array.isArray(requested) || requested.length > 64 || !requested.every(host => text(host) && host.length <= 253 && domainPattern.test(host))) {
    rejectDesignGate('G-08', '敏感站点列表须使用有效域名');
  }
  const hosts = [...new Set([hostedDomain, ...requested].filter((host): host is string => text(host) && domainPattern.test(host)))];
  const escaped = hosts.map(host => host.replace(/\./g, '\\.')).join('|');
  const privateHost = escaped ? new RegExp(`(?:^|[^a-z0-9_-])(?:${escaped})(?=\\.?(?:$|[^a-z0-9_.-]))`, 'i') : undefined;
  for (const [name, bytes] of files) {
    let body = readText(bytes);
    if (textFile.test(name)) body ??= bytes.toString('latin1');
    else if (body?.includes('\0')) body = undefined;
    if (name === 'tools/gate-allow.json' && body) {
      const { forbiddenHosts: _declaredHosts, ...rest } = allowances;
      body = JSON.stringify(rest);
    }
    for (const value of [name, body]) {
      if (!value) continue;
      if (secret.test(value) || privateHost?.test(value)) {
        rejectDesignGate('G-08', '稿件含有凭据样式、真实邮箱或敏感站点，请替换为虚构数据');
      }
      for (const match of value.matchAll(email)) {
        if (!exampleDomain.test(match[1])) rejectDesignGate('G-08', '稿件含有真实邮箱，请替换为虚构数据');
      }
    }
  }
}

/** Validates only fresh writes. Previously accepted idempotent requests are replayed by CDS. */
export function validateDesignPublicationGate(input: GateInput, context: DesignPublicationGateContext) {
  const next = (context.history.at(-1)?.version ?? 0) + 1;
  validateManifest(input);
  const allowances = validateChecks(input.files, input.manifest.checks as string);
  validateHeadings(input.files, next);
  validateHistory(input, context, next);
  validatePrivacy(input.files, allowances, context.publicBaseUrl);
  if (input.archiveBytes > designPublicationGateLimit) rejectDesignGate('G-09', '上传 ZIP 不得超过 3.8 MiB');
  const issues = inspectDesignAcceptance(input.manifest);
  if (issues.length) throw new DesignAcceptanceGateError(issues);
}
