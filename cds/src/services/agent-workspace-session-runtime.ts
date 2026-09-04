import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import type { IShellExecutor } from '../types.js';

export const MAP_DESIGN_WORKSPACE_SCHEMA = 'map-design-workspace-v1';
export const OPEN_DESIGN_IMAGE = 'ghcr.io/inernoro/prd_agent/opendesign-runtime:od-0.21.1-opencode-1.18.28';

export interface AgentWorkspaceResourcePolicy {
  cpuCores: number;
  memoryMb: number;
  timeoutSeconds: number;
  networkPolicy: 'restricted' | 'egress-only' | 'open';
  autoCleanupMinutes: number;
}

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

interface ParsedWorkspacePackage {
  runId: string;
  files: Array<{ path: string; bytes: Buffer; sha256: string; mediaType: string }>;
}

interface RuntimeHandle {
  sessionId: string;
  mapRunId: string;
  hostRoot: string;
  workspaceDir: string;
  dataDir: string;
  containerName: string;
  networkName: string;
  daemonBaseUrl: string;
  daemonApiToken: string;
  transfer: Omit<WorkspaceTransferRequest, 'transferToken'>;
  policy: AgentWorkspaceResourcePolicy;
  activeRunId?: string;
  ttlTimer: NodeJS.Timeout;
}

export interface AgentWorkspaceSessionRuntimeOptions {
  rootDir?: string;
  image?: string;
  daemonPort?: number;
  fetchImpl?: typeof fetch;
  pollIntervalMs?: number;
  capabilityCacheMs?: number;
  containerUid?: number;
  containerGid?: number;
}

export interface AgentWorkspaceRuntimeCapability {
  available: boolean;
  resourcePolicyEnforcedPerSession: boolean;
  reason: string | null;
}

export interface AgentWorkspaceCreateResult {
  hostRoot: string;
  workspaceDir: string;
  containerName: string;
  networkName: string;
  daemonBaseUrl: string;
  inputFileCount: number;
}

export interface AgentWorkspaceExecuteResult {
  artifactRef: string;
  resultSha256: string;
  files: Array<Pick<WorkspacePackageFile, 'path' | 'sha256' | 'size' | 'mediaType'>>;
  openDesignRunId: string;
}

export class AgentWorkspaceRuntimeError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable = false,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AgentWorkspaceRuntimeError';
  }
}

type StageReporter = (stage: string, detail?: Record<string, unknown>) => void;

const SHA256_RE = /^[a-f0-9]{64}$/;
const SESSION_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const MAX_PACKAGE_OVERHEAD_BYTES = 2 * 1024 * 1024;
const MAX_COMMIT_RESPONSE_BYTES = 1024 * 1024;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function sha256(bytes: Uint8Array | string): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
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

function validateTransferUrl(value: unknown, field: string): URL {
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
    && process.env.CDS_AGENT_WORKSPACE_ALLOW_HTTP_TRANSFER !== '1'
  ) {
    throw new AgentWorkspaceRuntimeError('workspace_transfer_invalid', `${field} must use HTTPS outside local tests`);
  }
  return parsed;
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

function normalizeRelativePath(value: unknown, label = 'file path'): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 512 || value.includes('\\')) {
    throw new AgentWorkspaceRuntimeError('workspace_package_invalid', `${label} must be a bounded POSIX relative path`);
  }
  const trimmed = value.trim();
  const normalized = path.posix.normalize(trimmed);
  if (
    path.posix.isAbsolute(trimmed)
    || normalized === '.'
    || normalized === '..'
    || normalized.startsWith('../')
    || normalized.includes('/../')
    || normalized !== trimmed
    || trimmed.includes('\0')
  ) {
    throw new AgentWorkspaceRuntimeError('workspace_package_invalid', `${label} escapes the workspace: ${trimmed}`);
  }
  return normalized;
}

async function readResponseLimited(response: Response, maxBytes: number): Promise<Buffer> {
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

function decodeBase64(value: unknown, filePath: string): Buffer {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new AgentWorkspaceRuntimeError('workspace_package_invalid', `invalid contentBase64 for ${filePath}`);
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) {
    throw new AgentWorkspaceRuntimeError('workspace_package_invalid', `non-canonical contentBase64 for ${filePath}`);
  }
  return bytes;
}

function parseWorkspacePackage(bytes: Buffer, transfer: WorkspaceTransferRequest): ParsedWorkspacePackage {
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
  return { runId, files };
}

function isAllowedOutput(relativePath: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => {
    if (pattern.endsWith('/**')) {
      const prefix = pattern.slice(0, -3);
      return relativePath === prefix || relativePath.startsWith(`${prefix}/`);
    }
    return relativePath === pattern;
  });
}

function mediaTypeForFile(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.html') return 'text/html; charset=utf-8';
  if (extension === '.css') return 'text/css; charset=utf-8';
  if (extension === '.js' || extension === '.mjs') return 'text/javascript; charset=utf-8';
  if (extension === '.json') return 'application/json; charset=utf-8';
  if (extension === '.svg') return 'image/svg+xml';
  if (extension === '.png') return 'image/png';
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.webp') return 'image/webp';
  return 'application/octet-stream';
}

function publicTransfer(transfer: WorkspaceTransferRequest): Omit<WorkspaceTransferRequest, 'transferToken'> {
  const { transferToken: _token, ...safe } = transfer;
  return safe;
}

export class AgentWorkspaceSessionRuntime {
  private readonly rootDir: string;
  private readonly image: string;
  private readonly daemonPort: number;
  private readonly fetchImpl: typeof fetch;
  private readonly pollIntervalMs: number;
  private readonly capabilityCacheMs: number;
  private readonly containerUid: number;
  private readonly containerGid: number;
  private readonly handles = new Map<string, RuntimeHandle>();
  private capabilityCache: { expiresAt: number; value: AgentWorkspaceRuntimeCapability } | null = null;

  constructor(
    private readonly shell: IShellExecutor,
    options: AgentWorkspaceSessionRuntimeOptions = {},
  ) {
    this.rootDir = path.resolve(options.rootDir || process.env.CDS_AGENT_WORKSPACE_ROOT || '/tmp/cds-agent-workspaces');
    this.image = options.image || process.env.CDS_OPEN_DESIGN_IMAGE || OPEN_DESIGN_IMAGE;
    this.daemonPort = options.daemonPort || 7456;
    this.fetchImpl = options.fetchImpl || fetch;
    this.pollIntervalMs = Math.max(5, options.pollIntervalMs || 750);
    this.capabilityCacheMs = Math.max(0, options.capabilityCacheMs ?? 5000);
    this.containerUid = options.containerUid ?? 1001;
    this.containerGid = options.containerGid ?? 1001;
  }

  async capability(force = false): Promise<AgentWorkspaceRuntimeCapability> {
    const now = Date.now();
    if (!force && this.capabilityCache && this.capabilityCache.expiresAt > now) {
      return this.capabilityCache.value;
    }
    let value: AgentWorkspaceRuntimeCapability;
    try {
      const docker = await this.shell.exec("docker version --format '{{.Server.Version}}'", { timeout: 5000 });
      if (docker.exitCode !== 0 || !docker.stdout.trim()) {
        value = {
          available: false,
          resourcePolicyEnforcedPerSession: false,
          reason: 'Docker daemon is unavailable; dedicated Agent workspace containers cannot be enforced',
        };
      } else {
        const image = await this.shell.exec(
          `docker image inspect ${shellQuote(this.image)} --format ${shellQuote('{{.Id}}')}`,
          { timeout: 10_000 },
        );
        if (image.exitCode !== 0 || !image.stdout.trim()) {
          value = {
            available: false,
            resourcePolicyEnforcedPerSession: false,
            reason: `OpenDesign image ${this.image} is not installed on this CDS node`,
          };
        } else {
          const agentCli = await this.shell.exec([
            'docker run --rm',
            '--pull never',
            '--read-only',
            '--network none',
            '--security-opt no-new-privileges:true',
            '--cap-drop ALL',
            '--pids-limit 64',
            '--memory 128m',
            '--cpus 0.25',
            '--entrypoint /bin/sh',
            shellQuote(this.image),
            '-lc',
            shellQuote('command -v opencode-cli >/dev/null 2>&1 || command -v opencode >/dev/null 2>&1'),
          ].join(' '), { timeout: 30_000 });
          value = agentCli.exitCode === 0
            ? { available: true, resourcePolicyEnforcedPerSession: true, reason: null }
            : {
                available: false,
                resourcePolicyEnforcedPerSession: false,
                reason: `OpenDesign image ${this.image} does not contain the required OpenCode Agent CLI`,
              };
        }
      }
    } catch {
      value = {
        available: false,
        resourcePolicyEnforcedPerSession: false,
        reason: 'Docker capability probe failed; dedicated Agent workspace containers remain disabled',
      };
    }
    this.capabilityCache = { expiresAt: now + this.capabilityCacheMs, value };
    return value;
  }

  async create(
    sessionId: string,
    rawTransfer: unknown,
    policy: AgentWorkspaceResourcePolicy,
    onStage: StageReporter = () => undefined,
    onExpired: (error?: unknown) => void = () => undefined,
  ): Promise<AgentWorkspaceCreateResult> {
    if (!SESSION_ID_RE.test(sessionId)) {
      throw new AgentWorkspaceRuntimeError('workspace_session_invalid', 'session id is not safe for container allocation');
    }
    if (this.handles.has(sessionId)) {
      throw new AgentWorkspaceRuntimeError('workspace_session_conflict', 'workspace session already exists');
    }
    if (policy.networkPolicy !== 'egress-only') {
      throw new AgentWorkspaceRuntimeError(
        'resource_policy_not_enforced',
        'OpenDesign requires the egress-only network policy',
      );
    }
    const capability = await this.capability();
    if (!capability.available || !capability.resourcePolicyEnforcedPerSession) {
      throw new AgentWorkspaceRuntimeError('workspace_runtime_unavailable', capability.reason || 'workspace runtime unavailable', true);
    }
    const transfer = normalizeWorkspaceTransfer(rawTransfer);
    fs.mkdirSync(this.rootDir, { recursive: true, mode: 0o700 });
    const hostRoot = fs.mkdtempSync(path.join(this.rootDir, `${sessionId}-`));
    const workspaceDir = path.join(hostRoot, 'workspace');
    const dataDir = path.join(hostRoot, 'data');
    const suffix = sha256(sessionId).slice(0, 16);
    const containerName = `cds-od-${suffix}`;
    const networkName = `cds-od-net-${suffix}`;
    let containerStarted = false;
    let networkCreated = false;
    try {
      fs.mkdirSync(workspaceDir, { recursive: true, mode: 0o750 });
      fs.mkdirSync(dataDir, { recursive: true, mode: 0o750 });
      onStage('workspace_downloading');
      const response = await this.fetchImpl(transfer.inputPackageUrl, {
        headers: { Authorization: `Bearer ${transfer.transferToken}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(Math.min(policy.timeoutSeconds * 1000, 60_000)),
      });
      if (!response.ok) {
        throw new AgentWorkspaceRuntimeError(
          'workspace_download_failed',
          `MAP workspace download failed with status ${response.status}`,
          response.status >= 500,
        );
      }
      const packageBytes = await readResponseLimited(
        response,
        Math.ceil(transfer.maxInputBytes * 1.5) + MAX_PACKAGE_OVERHEAD_BYTES,
      );
      const workspacePackage = parseWorkspacePackage(packageBytes, transfer);
      const files = workspacePackage.files;
      for (const file of files) {
        const target = path.join(workspaceDir, ...file.path.split('/'));
        const relative = path.relative(workspaceDir, target);
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
          throw new AgentWorkspaceRuntimeError('workspace_package_invalid', `workspace path escaped root: ${file.path}`);
        }
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o750 });
        fs.writeFileSync(target, file.bytes, { mode: 0o640, flag: 'wx' });
      }
      this.chownForContainer(hostRoot);
      onStage('workspace_materialized', { fileCount: files.length });

      const network = await this.shell.exec(
        `docker network create --label cds.managed=true --label cds.type=agent-session --label ${shellQuote(`cds.agent.session=${sessionId}`)} ${shellQuote(networkName)}`,
        { timeout: 30_000 },
      );
      if (network.exitCode !== 0) {
        throw new AgentWorkspaceRuntimeError('workspace_network_create_failed', 'could not create isolated Agent network', true);
      }
      networkCreated = true;
      const daemonApiToken = crypto.randomBytes(32).toString('hex');
      const env = [
        'NODE_ENV=production',
        'OD_BIND_HOST=0.0.0.0',
        `OD_PORT=${this.daemonPort}`,
        `OD_WEB_PORT=${this.daemonPort}`,
        'OD_DATA_DIR=/app/.od',
        `OD_API_TOKEN=${daemonApiToken}`,
        'OD_SANDBOX_MODE=1',
        'OD_SANDBOX_IMPORT_ALLOWED_ROOTS=/workspace',
      ].join('\n') + '\n';
      const command = [
        'docker run --detach',
        '--pull never',
        `--name ${shellQuote(containerName)}`,
        '--restart no',
        '--read-only',
        '--security-opt no-new-privileges:true',
        '--cap-drop ALL',
        `--cpus ${shellQuote(String(policy.cpuCores))}`,
        `--memory ${shellQuote(`${policy.memoryMb}m`)}`,
        '--pids-limit 256',
        '--stop-timeout 10',
        '--log-opt max-size=20m',
        '--log-opt max-file=2',
        '--tmpfs /tmp:rw,noexec,nosuid,size=128m',
        `--network ${shellQuote(networkName)}`,
        `--label ${shellQuote('cds.managed=true')}`,
        `--label ${shellQuote('cds.type=agent-session')}`,
        `--label ${shellQuote(`cds.agent.session=${sessionId}`)}`,
        `--mount ${shellQuote(`type=bind,src=${workspaceDir},dst=/workspace`)}`,
        `--mount ${shellQuote(`type=bind,src=${dataDir},dst=/app/.od`)}`,
        '--workdir /workspace',
        '--env-file /dev/stdin',
        shellQuote(this.image),
      ].join(' ');
      onStage('container_starting', { image: this.image });
      const started = await this.shell.exec(command, { timeout: 120_000, stdin: env });
      if (started.exitCode !== 0) {
        throw new AgentWorkspaceRuntimeError('workspace_container_start_failed', 'OpenDesign container failed to start', true);
      }
      containerStarted = true;
      const address = await this.shell.exec(
        `docker inspect --format ${shellQuote(`{{with index .NetworkSettings.Networks "${networkName}"}}{{.IPAddress}}{{end}}`)} ${shellQuote(containerName)}`,
        { timeout: 5000 },
      );
      const containerIp = address.exitCode === 0 ? address.stdout.trim() : '';
      if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(containerIp)) {
        throw new AgentWorkspaceRuntimeError('workspace_container_address_failed', 'OpenDesign container has no isolated network address', true);
      }
      const daemonBaseUrl = `http://${containerIp}:${this.daemonPort}`;
      await this.waitForHealth(daemonBaseUrl, daemonApiToken, policy.timeoutSeconds);
      const ttlTimer = setTimeout(() => {
        void this.stop(sessionId, 'ttl_expired')
          .then(() => onExpired())
          .catch((error) => onExpired(error));
      }, Math.max(1, policy.autoCleanupMinutes) * 60_000);
      ttlTimer.unref();
      this.handles.set(sessionId, {
        sessionId,
        mapRunId: workspacePackage.runId,
        hostRoot,
        workspaceDir,
        dataDir,
        containerName,
        networkName,
        daemonBaseUrl,
        daemonApiToken,
        transfer: publicTransfer(transfer),
        policy,
        ttlTimer,
      });
      onStage('container_ready');
      return {
        hostRoot,
        workspaceDir,
        containerName,
        networkName,
        daemonBaseUrl,
        inputFileCount: files.length,
      };
    } catch (error) {
      const cleanupErrors: string[] = [];
      if (containerStarted) {
        await this.removeContainer(containerName).catch((cleanupError) => {
          cleanupErrors.push(cleanupError instanceof Error ? cleanupError.message : String(cleanupError));
        });
      }
      if (networkCreated) {
        await this.removeNetwork(networkName).catch((cleanupError) => {
          cleanupErrors.push(cleanupError instanceof Error ? cleanupError.message : String(cleanupError));
        });
      }
      try { fs.rmSync(hostRoot, { recursive: true, force: true }); } catch (cleanupError) {
        cleanupErrors.push(cleanupError instanceof Error ? cleanupError.message : String(cleanupError));
      }
      if (cleanupErrors.length > 0) {
        throw new AgentWorkspaceRuntimeError(
          'workspace_cleanup_failed',
          'OpenDesign session creation failed and allocated resources could not be fully cleaned',
          true,
          {
            originalCode: error instanceof AgentWorkspaceRuntimeError ? error.code : null,
            cleanupErrors,
          },
        );
      }
      throw error;
    }
  }

  async execute(
    sessionId: string,
    instruction: string,
    model: OpenDesignModelAuthority,
    transferToken: string,
    signal?: AbortSignal,
    onStage: StageReporter = () => undefined,
  ): Promise<AgentWorkspaceExecuteResult> {
    const handle = this.handles.get(sessionId);
    if (!handle) {
      throw new AgentWorkspaceRuntimeError('workspace_session_not_found', 'OpenDesign workspace session does not exist');
    }
    if (handle.activeRunId) {
      throw new AgentWorkspaceRuntimeError('workspace_session_busy', 'OpenDesign workspace session already has an active run');
    }
    if (!instruction.trim() || instruction.length > 12_000) {
      throw new AgentWorkspaceRuntimeError('design_instruction_invalid', 'design instruction must contain 1 to 12000 characters');
    }
    this.validateModelAuthority(model, handle.transfer.inputPackageUrl);
    if (!transferToken || transferToken.length > 8192) {
      throw new AgentWorkspaceRuntimeError('workspace_transfer_invalid', 'workspace transfer token is missing');
    }
    onStage('open_design_importing');
    const imported = await this.odJson(handle, '/api/import/folder', {
      method: 'POST',
      body: {
        baseDir: '/workspace',
        name: `MAP design ${sessionId.slice(-12)}`,
        orchestratorWorkspace: {
          kind: 'scratch',
          sourceLabel: 'MAP design workspace',
          sourceRef: sessionId,
          baseRevision: handle.transfer.baseRevision,
          writeback: 'external',
        },
      },
      signal,
    });
    const project = imported.project as Record<string, unknown> | undefined;
    const projectId = typeof project?.id === 'string' ? project.id : '';
    const conversationId = typeof imported.conversationId === 'string' ? imported.conversationId : '';
    if (!projectId || !conversationId) {
      throw new AgentWorkspaceRuntimeError('open_design_contract_mismatch', 'OpenDesign folder import returned no project identity');
    }
    onStage('open_design_run_starting', { projectId });
    const run = await this.odJson(handle, '/api/runs', {
      method: 'POST',
      body: {
        projectId,
        conversationId,
        agentId: 'byok-opencode',
        model: model.model,
        message: instruction.trim(),
        systemPrompt: [
          'The workspace is already prepared by MAP. Read the referenced files from /workspace.',
          'Write the final webpage to index.html. The first release must be self-contained: inline all CSS, JavaScript, fonts, and images; do not reference relative or remote assets.',
          'Do not request credentials, upload source files, publish, deploy, or mutate any external source.',
        ].join(' '),
        byokProvider: {
          protocol: 'openai',
          apiKey: model.apiKey,
          baseUrl: model.baseUrl,
          model: model.model,
          requiresApiKey: true,
        },
      },
      signal,
      acceptedStatuses: [200, 202],
    });
    const runId = typeof run.runId === 'string'
      ? run.runId
      : typeof run.id === 'string'
        ? run.id
        : '';
    if (!runId) {
      throw new AgentWorkspaceRuntimeError('open_design_contract_mismatch', 'OpenDesign run creation returned no run id');
    }
    handle.activeRunId = runId;
    try {
      await this.waitForRun(handle, runId, signal, onStage);
      onStage('workspace_collecting');
      const collectedFiles = this.collectOutputs(handle);
      const indexFile = collectedFiles.find((file) => file.path === 'index.html');
      if (!indexFile) {
        throw new AgentWorkspaceRuntimeError('design_output_missing', 'OpenDesign completed without index.html');
      }
      this.validateSelfContainedHtml(Buffer.from(indexFile.contentBase64, 'base64').toString('utf8'));
      const manifestBytes = Buffer.from(JSON.stringify({
        schemaVersion: 'map-design-artifact-manifest-v1',
        baseRevision: handle.transfer.baseRevision,
        entryFile: 'index.html',
        files: collectedFiles.map(({ path: filePath, sha256: fileSha, size, mediaType }) => ({
          path: filePath,
          sha256: fileSha,
          size,
          mediaType,
        })),
      }));
      const files = [
        ...collectedFiles,
        {
          path: 'manifest.json',
          contentBase64: manifestBytes.toString('base64'),
          sha256: sha256(manifestBytes),
          size: manifestBytes.byteLength,
          mediaType: 'application/json; charset=utf-8',
        },
      ].sort((left, right) => left.path.localeCompare(right.path));
      const totalOutputBytes = files.reduce((total, file) => total + file.size, 0);
      if (totalOutputBytes > handle.transfer.maxOutputBytes) {
        throw new AgentWorkspaceRuntimeError('design_output_too_large', 'OpenDesign output and CDS manifest exceed maxOutputBytes');
      }
      const commitBody = {
        schemaVersion: MAP_DESIGN_WORKSPACE_SCHEMA,
        sessionId,
        runId: handle.mapRunId,
        baseRevision: handle.transfer.baseRevision,
        files,
      };
      const serialized = JSON.stringify(commitBody);
      onStage('workspace_committing', { fileCount: files.length });
      const commitResponse = await this.fetchImpl(handle.transfer.resultCommitUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${transferToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: serialized,
        signal: signal || AbortSignal.timeout(Math.min(handle.policy.timeoutSeconds * 1000, 60_000)),
      });
      const commitBytes = await readResponseLimited(commitResponse, MAX_COMMIT_RESPONSE_BYTES);
      let commit: Record<string, unknown> = {};
      try {
        commit = commitBytes.length ? JSON.parse(commitBytes.toString('utf8')) as Record<string, unknown> : {};
      } catch {
        throw new AgentWorkspaceRuntimeError('workspace_commit_invalid_response', 'MAP result commit returned invalid JSON');
      }
      if (!commitResponse.ok) {
        throw new AgentWorkspaceRuntimeError(
          'workspace_commit_failed',
          typeof commit.message === 'string'
            ? commit.message
            : `MAP result commit failed with status ${commitResponse.status}`,
          commitResponse.status >= 500,
        );
      }
      const artifactRef = typeof commit.artifactRef === 'string' ? commit.artifactRef : '';
      if (!artifactRef) {
        throw new AgentWorkspaceRuntimeError('workspace_commit_invalid_response', 'MAP result commit returned no artifactRef');
      }
      const resultSha256 = typeof commit.resultSha256 === 'string'
        ? commit.resultSha256.toLowerCase()
        : '';
      if (!SHA256_RE.test(resultSha256)) {
        throw new AgentWorkspaceRuntimeError(
          'workspace_commit_invalid_response',
          'MAP result commit returned no valid resultSha256',
        );
      }
      return {
        artifactRef,
        resultSha256,
        files: files.map(({ path: filePath, sha256: fileSha, size, mediaType }) => ({
          path: filePath,
          sha256: fileSha,
          size,
          mediaType,
        })),
        openDesignRunId: runId,
      };
    } finally {
      handle.activeRunId = undefined;
    }
  }

  async stop(sessionId: string, _reason = 'requested'): Promise<void> {
    const handle = this.handles.get(sessionId);
    if (!handle) return;
    clearTimeout(handle.ttlTimer);
    if (handle.activeRunId) {
      await this.odJson(handle, `/api/runs/${encodeURIComponent(handle.activeRunId)}/cancel`, {
        method: 'POST',
        body: {},
        acceptedStatuses: [200, 202, 404, 409],
      }).catch(() => undefined);
    }
    handle.activeRunId = undefined;
    handle.daemonApiToken = '';
    const cleanupErrors: string[] = [];
    await this.removeContainer(handle.containerName).catch((error) => {
      cleanupErrors.push(error instanceof Error ? error.message : String(error));
    });
    await this.removeNetwork(handle.networkName).catch((error) => {
      cleanupErrors.push(error instanceof Error ? error.message : String(error));
    });
    try { fs.rmSync(handle.hostRoot, { recursive: true, force: true }); } catch (error) {
      cleanupErrors.push(error instanceof Error ? error.message : String(error));
    }
    if (cleanupErrors.length > 0) {
      throw new AgentWorkspaceRuntimeError(
        'workspace_cleanup_failed',
        'OpenDesign session resources could not be fully cleaned',
        true,
        { cleanupErrors },
      );
    }
    this.handles.delete(sessionId);
  }

  has(sessionId: string): boolean {
    return this.handles.has(sessionId);
  }

  private validateModelAuthority(model: OpenDesignModelAuthority, inputPackageUrl: string): void {
    if (model.protocol !== 'openai' || !model.apiKey || !model.model.trim()) {
      throw new AgentWorkspaceRuntimeError(
        'model_authority_invalid',
        'OpenDesign requires a run-scoped MAP OpenAI-compatible base URL, API key, and model',
      );
    }
    const parsed = validateTransferUrl(model.baseUrl, 'modelBaseUrl');
    if (parsed.origin !== new URL(inputPackageUrl).origin) {
      throw new AgentWorkspaceRuntimeError(
        'model_authority_origin_mismatch',
        'modelBaseUrl and workspace transfer URLs must share one MAP origin',
      );
    }
  }

  private chownForContainer(hostRoot: string): void {
    const visit = (target: string): void => {
      try { fs.chownSync(target, this.containerUid, this.containerGid); } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EPERM' && code !== 'EINVAL' && code !== 'ENOSYS') throw error;
      }
      if (!fs.lstatSync(target).isDirectory()) return;
      for (const name of fs.readdirSync(target)) visit(path.join(target, name));
    };
    visit(hostRoot);
  }

  private async waitForHealth(baseUrl: string, token: string, timeoutSeconds: number): Promise<void> {
    const deadline = Date.now() + Math.min(Math.max(timeoutSeconds, 10), 180) * 1000;
    let last = 'connection pending';
    while (Date.now() < deadline) {
      try {
        const response = await this.fetchImpl(`${baseUrl}/api/health`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(3000),
        });
        if (response.ok) return;
        last = `HTTP ${response.status}`;
      } catch (error) {
        last = error instanceof Error ? error.message : String(error);
      }
      await delay(this.pollIntervalMs);
    }
    throw new AgentWorkspaceRuntimeError('open_design_not_ready', `OpenDesign health check timed out: ${last}`, true);
  }

  private async waitForRun(
    handle: RuntimeHandle,
    runId: string,
    signal: AbortSignal | undefined,
    onStage: StageReporter,
  ): Promise<void> {
    const startedAt = Date.now();
    const deadline = startedAt + handle.policy.timeoutSeconds * 1000;
    let lastStatus = '';
    let lastProgressAt = 0;
    while (Date.now() < deadline) {
      if (signal?.aborted) {
        await this.cancelRun(handle, runId);
        throw new AgentWorkspaceRuntimeError('open_design_run_cancelled', 'OpenDesign run was cancelled');
      }
      const status = await this.odJson(handle, `/api/runs/${encodeURIComponent(runId)}`, {
        method: 'GET',
        signal,
      });
      const value = typeof status.status === 'string' ? status.status : '';
      const now = Date.now();
      if (value && (value !== lastStatus || now - lastProgressAt >= 3_000)) {
        lastStatus = value;
        lastProgressAt = now;
        onStage('open_design_running', {
          status: value,
          runId,
          elapsedSeconds: Math.max(0, Math.floor((now - startedAt) / 1000)),
        });
      }
      if (value === 'succeeded') {
        if (status.deliverableValid === false) {
          throw new AgentWorkspaceRuntimeError(
            'open_design_deliverable_invalid',
            typeof status.deliverableValidation === 'string'
              ? status.deliverableValidation
              : 'OpenDesign rejected its final deliverable',
          );
        }
        return;
      }
      if (value === 'failed' || value === 'canceled') {
        throw new AgentWorkspaceRuntimeError(
          value === 'failed' ? 'open_design_run_failed' : 'open_design_run_cancelled',
          typeof status.error === 'string' ? status.error : `OpenDesign run ended with status ${value}`,
        );
      }
      await delay(this.pollIntervalMs, undefined, signal ? { signal } : undefined).catch((error) => {
        if (signal?.aborted) return;
        throw error;
      });
    }
    await this.cancelRun(handle, runId);
    throw new AgentWorkspaceRuntimeError('open_design_run_timeout', 'OpenDesign run exceeded the session timeout', true);
  }

  private collectOutputs(handle: RuntimeHandle): WorkspacePackageFile[] {
    const results: WorkspacePackageFile[] = [];
    let total = 0;
    const walk = (directory: string): void => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name);
        const relative = path.relative(handle.workspaceDir, absolute).split(path.sep).join('/');
        normalizeRelativePath(relative);
        const stat = fs.lstatSync(absolute);
        if (stat.isSymbolicLink()) {
          throw new AgentWorkspaceRuntimeError('design_output_invalid', `symbolic links are not allowed: ${relative}`);
        }
        if (stat.isDirectory()) {
          walk(absolute);
          continue;
        }
        if (
          !stat.isFile()
          || relative === 'manifest.json'
          || !isAllowedOutput(relative, handle.transfer.allowedOutputPaths)
        ) continue;
        total += stat.size;
        if (total > handle.transfer.maxOutputBytes) {
          throw new AgentWorkspaceRuntimeError('design_output_too_large', 'OpenDesign output exceeds maxOutputBytes');
        }
        const bytes = fs.readFileSync(absolute);
        results.push({
          path: relative,
          contentBase64: bytes.toString('base64'),
          sha256: sha256(bytes),
          size: bytes.byteLength,
          mediaType: mediaTypeForFile(relative),
        });
      }
    };
    walk(handle.workspaceDir);
    return results.sort((left, right) => left.path.localeCompare(right.path));
  }

  private validateSelfContainedHtml(html: string): void {
    if (!/^\s*<!doctype html>|^\s*<html[\s>]/i.test(html)) {
      throw new AgentWorkspaceRuntimeError('design_output_invalid', 'index.html is not a complete HTML document');
    }
    for (const match of html.matchAll(/<([a-z][a-z0-9-]*)\b[^>]*\b(src|href)\s*=\s*(["'])(.*?)\3/gi)) {
      const tag = match[1].toLowerCase();
      const attribute = match[2].toLowerCase();
      const value = match[4].trim();
      if (!value || value.startsWith('#') || value.startsWith('data:')) continue;
      if (tag === 'a' && attribute === 'href') continue;
      throw new AgentWorkspaceRuntimeError(
        'design_output_not_self_contained',
        `index.html references a non-inline resource from <${tag}>`,
      );
    }
    for (const match of html.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/gi)) {
      const value = match[2].trim();
      if (!value || value.startsWith('data:') || value.startsWith('#')) continue;
      throw new AgentWorkspaceRuntimeError(
        'design_output_not_self_contained',
        'index.html CSS references a non-inline resource',
      );
    }
  }

  private async odJson(
    handle: RuntimeHandle,
    apiPath: string,
    options: {
      method: 'GET' | 'POST';
      body?: Record<string, unknown>;
      signal?: AbortSignal;
      acceptedStatuses?: number[];
    },
  ): Promise<Record<string, unknown>> {
    const response = await this.fetchImpl(`${handle.daemonBaseUrl}${apiPath}`, {
      method: options.method,
      headers: {
        Authorization: `Bearer ${handle.daemonApiToken}`,
        Accept: 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const bytes = await readResponseLimited(response, MAX_PACKAGE_OVERHEAD_BYTES);
    let body: Record<string, unknown> = {};
    try {
      body = bytes.length ? JSON.parse(bytes.toString('utf8')) as Record<string, unknown> : {};
    } catch {
      throw new AgentWorkspaceRuntimeError('open_design_contract_mismatch', `OpenDesign ${apiPath} returned invalid JSON`);
    }
    const accepted = options.acceptedStatuses || [200];
    if (!accepted.includes(response.status)) {
      const nestedError = body.error && typeof body.error === 'object'
        ? body.error as Record<string, unknown>
        : null;
      const message = typeof nestedError?.message === 'string'
        ? nestedError.message
        : typeof body.message === 'string'
          ? body.message
          : `OpenDesign ${apiPath} failed with status ${response.status}`;
      throw new AgentWorkspaceRuntimeError(
        'open_design_request_failed',
        message,
        response.status >= 500,
        { status: response.status, upstreamCode: nestedError?.code || null },
      );
    }
    return body;
  }

  private async cancelRun(handle: RuntimeHandle, runId: string): Promise<void> {
    await this.odJson(handle, `/api/runs/${encodeURIComponent(runId)}/cancel`, {
      method: 'POST',
      body: {},
      acceptedStatuses: [200, 202, 404, 409],
    }).catch(() => undefined);
  }

  private async removeContainer(containerName: string): Promise<void> {
    const result = await this.shell.exec(`docker rm -f ${shellQuote(containerName)}`, { timeout: 30_000 });
    if (result.exitCode !== 0 && !/No such container/i.test(`${result.stderr}\n${result.stdout}`)) {
      throw new AgentWorkspaceRuntimeError(
        'workspace_container_cleanup_failed',
        'OpenDesign session container could not be removed',
        true,
      );
    }
  }

  private async removeNetwork(networkName: string): Promise<void> {
    const result = await this.shell.exec(`docker network rm ${shellQuote(networkName)}`, { timeout: 30_000 });
    if (result.exitCode !== 0 && !/No such network/i.test(`${result.stderr}\n${result.stdout}`)) {
      throw new AgentWorkspaceRuntimeError(
        'workspace_network_cleanup_failed',
        'OpenDesign session network could not be removed',
        true,
      );
    }
  }
}
