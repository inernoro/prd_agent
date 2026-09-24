// 搬迁自 cds/src/services/agent-workspace-session-runtime.ts（第 1 阶段：只改归属、不改行为）。
// 第 4 阶段删除 CDS 旧实现之前，两边的判据必须保持逐字一致；改这里要同步改那边，反之亦然。
// 与原文唯一的差别：本地测试之外允许 HTTP 传输的开关从 CDS_AGENT_WORKSPACE_ALLOW_HTTP_TRANSFER
// 改名为 DESIGN_RUNTIME_ALLOW_HTTP_TRANSFER（CDS_ 前缀在独立服务里没有意义），语义不变。
import { AgentWorkspaceRuntimeError } from '../errors.js';
import { parseDesignDirection } from '../prompts.js';
import { MAP_DESIGN_ARTIFACT_QUALITY_SCHEMA, parseVisibleTextOccurrenceConstraints } from '../quality/gate.js';
import { SHA256_RE, decodeBase64, normalizeRelativePath, sha256 } from './primitives.js';

export const MAP_DESIGN_WORKSPACE_SCHEMA = 'map-design-workspace-v1';
export const SESSION_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
export const MAX_PACKAGE_OVERHEAD_BYTES = 2 * 1024 * 1024;
export const MAX_COMMIT_RESPONSE_BYTES = 1024 * 1024;

export interface WorkspaceTransferRequest {
  schemaVersion: typeof MAP_DESIGN_WORKSPACE_SCHEMA;
  inputPackageUrl: string;
  resultCommitUrl: string;
  transferToken: string;
  inputSha256: string;
  baseRevision: string;
  maxInputBytes: number;
  maxOutputBytes: number;
  allowedOutputPaths: string[];
}

export interface OpenDesignModelAuthority {
  baseUrl: string;
  protocol: 'openai';
  apiKey: string;
  model: string;
}

export interface WorkspacePackageFile {
  path: string;
  contentBase64: string;
  sha256: string;
  size: number;
  mediaType: string;
}

interface WorkspacePackage {
  schemaVersion: typeof MAP_DESIGN_WORKSPACE_SCHEMA;
  runId: string;
  baseRevision: string;
  files: WorkspacePackageFile[];
}

export interface ParsedWorkspacePackage {
  runId: string;
  files: Array<{ path: string; bytes: Buffer; sha256: string; mediaType: string }>;
}

function normalizeSha(value: unknown, field: string): string {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!SHA256_RE.test(normalized)) {
    throw new AgentWorkspaceRuntimeError('workspace_transfer_invalid', `${field} must be a SHA-256 hex digest`);
  }
  return normalized;
}

function boundedInteger(value: unknown, field: string, min: number, max: number): number {
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) {
    throw new AgentWorkspaceRuntimeError(
      'workspace_transfer_invalid',
      `${field} must be an integer in [${min}, ${max}]`,
    );
  }
  return Number(value);
}

export function validateTransferUrl(value: unknown, field: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(typeof value === 'string' ? value : '');
  } catch {
    throw new AgentWorkspaceRuntimeError('workspace_transfer_invalid', `${field} must be an absolute HTTP URL`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new AgentWorkspaceRuntimeError('workspace_transfer_invalid', `${field} must use HTTP or HTTPS`);
  }
  if (parsed.username || parsed.password || parsed.hash || parsed.search) {
    throw new AgentWorkspaceRuntimeError(
      'workspace_transfer_invalid',
      `${field} cannot contain credentials, query parameters, or fragments`,
    );
  }
  if (
    parsed.protocol === 'http:'
    && parsed.hostname !== '127.0.0.1'
    && parsed.hostname !== 'localhost'
    && process.env.DESIGN_RUNTIME_ALLOW_HTTP_TRANSFER !== '1'
  ) {
    throw new AgentWorkspaceRuntimeError('workspace_transfer_invalid', `${field} must use HTTPS outside local tests`);
  }
  return parsed;
}

function normalizeAgentWorkspaceModelBaseUrl(value: unknown): string {
  return validateTransferUrl(value, 'modelBaseUrl').toString();
}

/**
 * 模型出口必须是本次任务的 MAP 出口：OpenAI 兼容协议、带本次任务票据、与工作区传输同一个 MAP origin。
 * 原为 AgentWorkspaceSessionRuntime.validateModelAuthority；提交任务时与执行前共用这一份判据。
 */
export function validateModelAuthority(model: OpenDesignModelAuthority, inputPackageUrl: string): void {
  if (model.protocol !== 'openai' || !model.apiKey || !model.model.trim()) {
    throw new AgentWorkspaceRuntimeError(
      'model_authority_invalid',
      'OpenDesign requires a run-scoped MAP OpenAI-compatible base URL, API key, and model',
    );
  }
  const parsed = new URL(normalizeAgentWorkspaceModelBaseUrl(model.baseUrl));
  if (parsed.origin !== new URL(inputPackageUrl).origin) {
    throw new AgentWorkspaceRuntimeError(
      'model_authority_origin_mismatch',
      'modelBaseUrl and workspace transfer URLs must share one MAP origin',
    );
  }
}

export function normalizeWorkspaceTransfer(value: unknown): WorkspaceTransferRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentWorkspaceRuntimeError('workspace_transfer_required', 'workspaceTransfer is required for OpenDesign');
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== MAP_DESIGN_WORKSPACE_SCHEMA) {
    throw new AgentWorkspaceRuntimeError(
      'workspace_transfer_invalid',
      `workspaceTransfer.schemaVersion must be ${MAP_DESIGN_WORKSPACE_SCHEMA}`,
    );
  }
  const inputPackageUrl = validateTransferUrl(record.inputPackageUrl, 'workspaceTransfer.inputPackageUrl');
  const resultCommitUrl = validateTransferUrl(record.resultCommitUrl, 'workspaceTransfer.resultCommitUrl');
  if (inputPackageUrl.origin !== resultCommitUrl.origin) {
    throw new AgentWorkspaceRuntimeError(
      'workspace_transfer_origin_mismatch',
      'workspace transfer download and commit URLs must share one MAP origin',
    );
  }
  const transferToken = typeof record.transferToken === 'string' ? record.transferToken.trim() : '';
  if (!transferToken || transferToken.length > 8192) {
    throw new AgentWorkspaceRuntimeError('workspace_transfer_invalid', 'workspaceTransfer.transferToken is required');
  }
  const baseRevision = typeof record.baseRevision === 'string' ? record.baseRevision.trim() : '';
  if (!baseRevision || baseRevision.length > 256) {
    throw new AgentWorkspaceRuntimeError('workspace_transfer_invalid', 'workspaceTransfer.baseRevision is required');
  }
  const rawAllowlist = Array.isArray(record.allowedOutputPaths) ? record.allowedOutputPaths : [];
  const allowedOutputPaths = rawAllowlist
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
  if (allowedOutputPaths.length === 0 || allowedOutputPaths.length > 64) {
    throw new AgentWorkspaceRuntimeError(
      'workspace_transfer_invalid',
      'workspaceTransfer.allowedOutputPaths must contain 1 to 64 paths',
    );
  }
  for (const pattern of allowedOutputPaths) validateOutputPattern(pattern);
  if (!allowedOutputPaths.includes('index.html') || !allowedOutputPaths.includes('manifest.json')) {
    throw new AgentWorkspaceRuntimeError(
      'workspace_transfer_invalid',
      'workspaceTransfer.allowedOutputPaths must include index.html and manifest.json',
    );
  }
  return {
    schemaVersion: MAP_DESIGN_WORKSPACE_SCHEMA,
    inputPackageUrl: inputPackageUrl.toString(),
    resultCommitUrl: resultCommitUrl.toString(),
    transferToken,
    inputSha256: normalizeSha(record.inputSha256, 'workspaceTransfer.inputSha256'),
    baseRevision,
    maxInputBytes: boundedInteger(record.maxInputBytes, 'workspaceTransfer.maxInputBytes', 1, 64 * 1024 * 1024),
    maxOutputBytes: boundedInteger(record.maxOutputBytes, 'workspaceTransfer.maxOutputBytes', 1, 128 * 1024 * 1024),
    allowedOutputPaths: [...new Set(allowedOutputPaths)],
  };
}

function validateOutputPattern(pattern: string): void {
  const suffix = pattern.endsWith('/**') ? pattern.slice(0, -3) : pattern;
  const normalized = normalizeRelativePath(suffix, 'allowed output pattern');
  if (normalized !== suffix) {
    throw new AgentWorkspaceRuntimeError('workspace_transfer_invalid', `invalid allowed output pattern: ${pattern}`);
  }
  if (pattern.includes('*') && !pattern.endsWith('/**')) {
    throw new AgentWorkspaceRuntimeError(
      'workspace_transfer_invalid',
      `only exact paths and directory/** patterns are supported: ${pattern}`,
    );
  }
}


export async function readResponseLimited(response: Response, maxBytes: number): Promise<Buffer> {
  const length = Number(response.headers.get('content-length') || '0');
  if (Number.isFinite(length) && length > maxBytes) {
    throw new AgentWorkspaceRuntimeError('workspace_transfer_too_large', `response exceeds ${maxBytes} bytes`);
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new AgentWorkspaceRuntimeError('workspace_transfer_too_large', `response exceeds ${maxBytes} bytes`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}


export function parseWorkspacePackage(bytes: Buffer, transfer: WorkspaceTransferRequest): ParsedWorkspacePackage {
  if (sha256(bytes) !== transfer.inputSha256) {
    throw new AgentWorkspaceRuntimeError('workspace_package_hash_mismatch', 'workspace input package SHA-256 does not match');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new AgentWorkspaceRuntimeError('workspace_package_invalid', 'workspace input package is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AgentWorkspaceRuntimeError('workspace_package_invalid', 'workspace input package must be an object');
  }
  const pkg = parsed as Partial<WorkspacePackage>;
  if (pkg.schemaVersion !== MAP_DESIGN_WORKSPACE_SCHEMA || pkg.baseRevision !== transfer.baseRevision) {
    throw new AgentWorkspaceRuntimeError(
      'workspace_package_revision_mismatch',
      'workspace input package schema or base revision does not match the transfer contract',
    );
  }
  const runId = typeof pkg.runId === 'string' ? pkg.runId.trim() : '';
  if (!SESSION_ID_RE.test(runId)) {
    throw new AgentWorkspaceRuntimeError('workspace_package_invalid', 'workspace input package runId is missing or invalid');
  }
  if (!Array.isArray(pkg.files) || pkg.files.length === 0 || pkg.files.length > 512) {
    throw new AgentWorkspaceRuntimeError('workspace_package_invalid', 'workspace input package must contain 1 to 512 files');
  }
  const seen = new Set<string>();
  let total = 0;
  const files = pkg.files.map((file) => {
    if (!file || typeof file !== 'object') {
      throw new AgentWorkspaceRuntimeError('workspace_package_invalid', 'workspace file entry must be an object');
    }
    const relativePath = normalizeRelativePath(file.path);
    if (seen.has(relativePath)) {
      throw new AgentWorkspaceRuntimeError('workspace_package_invalid', `duplicate workspace file path: ${relativePath}`);
    }
    seen.add(relativePath);
    const content = decodeBase64(file.contentBase64, relativePath);
    const expectedSize = boundedInteger(file.size, `files[${relativePath}].size`, 0, transfer.maxInputBytes);
    if (content.byteLength !== expectedSize) {
      throw new AgentWorkspaceRuntimeError('workspace_package_invalid', `size mismatch for ${relativePath}`);
    }
    const expectedSha = normalizeSha(file.sha256, `files[${relativePath}].sha256`);
    if (sha256(content) !== expectedSha) {
      throw new AgentWorkspaceRuntimeError('workspace_package_hash_mismatch', `SHA-256 mismatch for ${relativePath}`);
    }
    total += content.byteLength;
    if (total > transfer.maxInputBytes) {
      throw new AgentWorkspaceRuntimeError('workspace_transfer_too_large', 'workspace input files exceed maxInputBytes');
    }
    const mediaType = typeof file.mediaType === 'string' && file.mediaType.trim()
      ? file.mediaType.trim().slice(0, 200)
      : 'application/octet-stream';
    return { path: relativePath, bytes: content, sha256: expectedSha, mediaType };
  });
  validateDesignTaskContract(runId, transfer.baseRevision, files);
  return { runId, files };
}

export const PREVIEW_CHECK_INTERVAL_MS = 8_000;
export const PREVIEW_MAX_BYTES = 1_048_576;

/** 预览端点与结果提交端点同源同前缀：…/workspace/result → …/workspace/preview。认不出形状就不推。 */
export function derivePreviewUrl(resultCommitUrl: string): string | undefined {
  try {
    const url = new URL(resultCommitUrl);
    if (!url.pathname.endsWith('/workspace/result')) return undefined;
    url.pathname = `${url.pathname.slice(0, -'/workspace/result'.length)}/workspace/preview`;
    url.search = '';
    return url.toString();
  } catch {
    return undefined;
  }
}

function validateDesignTaskContract(
  runId: string,
  baseRevision: string,
  files: ParsedWorkspacePackage['files'],
): void {
  const taskFile = files.find((file) => file.path === 'brief/task.json');
  if (!taskFile) {
    throw new AgentWorkspaceRuntimeError('workspace_package_invalid', 'workspace input package must contain brief/task.json');
  }
  let task: Record<string, unknown>;
  try {
    const parsed = JSON.parse(taskFile.bytes.toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    task = parsed as Record<string, unknown>;
  } catch {
    throw new AgentWorkspaceRuntimeError('workspace_package_invalid', 'brief/task.json is not valid JSON');
  }
  const quality = task.qualityContract;
  if (
    task.schemaVersion !== MAP_DESIGN_WORKSPACE_SCHEMA
    || task.runId !== runId
    || task.baseRevision !== baseRevision
    || !quality
    || typeof quality !== 'object'
    || Array.isArray(quality)
    || (quality as Record<string, unknown>).schemaVersion !== MAP_DESIGN_ARTIFACT_QUALITY_SCHEMA
  ) {
    throw new AgentWorkspaceRuntimeError(
      'workspace_quality_contract_unsupported',
      `brief/task.json must use ${MAP_DESIGN_ARTIFACT_QUALITY_SCHEMA} and match the workspace identity`,
    );
  }
  const contract = quality as Record<string, unknown>;
  for (const [field, expected] of [
    ['measuredClaimsRequireSource', true],
    ['sensitiveFactsRequireSource', true],
    ['contextBoundMetricsReviewRequired', true],
    ['visibleDraftMarkersAllowed', false],
    ['emptyOrMissingFragmentTargetsAllowed', false],
    ['inertEnabledButtonsAllowed', false],
    ['finalReviewRequired', true],
  ] as const) {
    if (contract[field] !== expected) {
      throw new AgentWorkspaceRuntimeError(
        'workspace_quality_contract_unsupported',
        `brief/task.json qualityContract.${field} is unsupported`,
      );
    }
  }
  parseVisibleTextOccurrenceConstraints(contract.visibleTextOccurrenceConstraints);
  parseDesignDirection(task.designDirection);
  const hasCurrentPage = files.some((file) => file.path === 'current/index.html');
  const hasKnowledge = files.some((file) => file.path.startsWith('knowledge/'));
  const responseContract = task.responseContract;
  const input = task.input;
  const inputContract = input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : undefined;
  const userSupplied = inputContract?.userSupplied;
  const userSuppliedContract = userSupplied && typeof userSupplied === 'object' && !Array.isArray(userSupplied)
    ? userSupplied as Record<string, unknown>
    : undefined;
  const serverKnowledge = inputContract?.serverKnowledge;
  const serverKnowledgeContract = serverKnowledge && typeof serverKnowledge === 'object' && !Array.isArray(serverKnowledge)
    ? serverKnowledge as Record<string, unknown>
    : undefined;
  const currentHtml = inputContract?.currentHtml;
  const currentHtmlContract = currentHtml && typeof currentHtml === 'object' && !Array.isArray(currentHtml)
    ? currentHtml as Record<string, unknown>
    : undefined;
  if (
    typeof task.title !== 'string'
    || !task.title.trim()
    || typeof userSuppliedContract?.instruction !== 'string'
    || !userSuppliedContract.instruction.trim()
    || userSuppliedContract.authority !== 'user-supplied'
    || serverKnowledgeContract?.authority !== 'server-authoritative-snapshot'
    || !Array.isArray(serverKnowledgeContract.references)
    || contract.userSuppliedInputsAreFactualProvenance !== false
    || (hasCurrentPage
      ? currentHtmlContract?.authority !== 'server-owned-current-artifact'
      : currentHtml !== null)
    || !responseContract
    || typeof responseContract !== 'object'
    || Array.isArray(responseContract)
    || (responseContract as Record<string, unknown>).requiredFile !== 'index.html'
    || (responseContract as Record<string, unknown>).manifestFile !== 'manifest.json'
    || (responseContract as Record<string, unknown>).writeback !== 'external'
  ) {
    throw new AgentWorkspaceRuntimeError(
      'workspace_package_invalid',
      'brief/task.json input authority, title, and responseContract are incomplete',
    );
  }
  const expectedSources = [
    ...(hasKnowledge ? ['server-knowledge'] : []),
    ...(hasCurrentPage ? ['server-current-visible-content'] : []),
  ];
  if (
    !Array.isArray(contract.factualSources)
    || contract.factualSources.length !== expectedSources.length
    || contract.factualSources.some((value, index) => value !== expectedSources[index])
  ) {
    throw new AgentWorkspaceRuntimeError(
      'workspace_quality_contract_unsupported',
      'brief/task.json qualityContract.factualSources does not match the operation',
    );
  }
  if ((task.operation === 'edit') !== hasCurrentPage || (task.operation !== 'edit' && task.operation !== 'generate')) {
    throw new AgentWorkspaceRuntimeError(
      'workspace_package_invalid',
      'brief/task.json operation does not match the presence of current/index.html',
    );
  }
}
