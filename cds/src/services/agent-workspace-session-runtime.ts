import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import type { ExecResult, IShellExecutor } from '../types.js';
import { computeCdsInstanceId } from './orphan-container-reaper.js';
import { maskSecrets } from './secret-masker.js';

export const MAP_DESIGN_WORKSPACE_SCHEMA = 'map-design-workspace-v1';
export const OPEN_DESIGN_IMAGE = 'ghcr.io/inernoro/prd_agent/opendesign-runtime@sha256:c4d2d53a21fa31adfb8b4b0dc189d6e8db3b7543f93c231c3574a75baf33f474';
const OPEN_DESIGN_WEB_PROTOTYPE_SKILL = 'web-prototype';
const OPEN_DESIGN_WEB_PROTOTYPE_SOURCE = '/app/plugins/_official/examples/web-prototype';

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

const MAP_DESIGN_ARTIFACT_QUALITY_SCHEMA = 'map-design-artifact-quality-v1';

interface RuntimeHandle {
  kind: 'active';
  sessionId: string;
  mapRunId: string;
  hostRoot: string;
  workspaceDir: string;
  outputDir: string;
  dataDir: string;
  containerName: string;
  egressContainerName?: string;
  networkName: string;
  workspaceVolumeName: string;
  dataVolumeName: string;
  inputPaths: string[];
  daemonBaseUrl: string;
  daemonApiToken: string;
  egressClientToken: string;
  transfer: Omit<WorkspaceTransferRequest, 'transferToken'>;
  policy: AgentWorkspaceResourcePolicy;
  activeRunId?: string;
  ttlTimer: NodeJS.Timeout;
  onCleanupSettled: (error?: unknown) => void;
}

interface PartialCleanupHandle {
  kind: 'partial-cleanup';
  sessionId: string;
  hostRoot?: string;
  containerNames: string[];
  networkName?: string;
  volumeNames: string[];
  onCleanupSettled: (error?: unknown) => void;
}

type ManagedRuntimeHandle = RuntimeHandle | PartialCleanupHandle;

export interface AgentWorkspaceSessionRuntimeOptions {
  rootDir?: string;
  instanceId?: string;
  image?: string;
  daemonPort?: number;
  fetchImpl?: typeof fetch;
  pollIntervalMs?: number;
  capabilityCacheMs?: number;
  capabilityNegativeCacheMs?: number;
  capabilityMaxStaleMs?: number;
  containerUid?: number;
  containerGid?: number;
  autoPullImage?: boolean;
  cleanupRetryBaseMs?: number;
  cleanupRetryMaxMs?: number;
}

export interface AgentWorkspaceRuntimeCapability {
  available: boolean;
  resourcePolicyEnforcedPerSession: boolean;
  reason: string | null;
  verificationPending?: boolean;
}

interface CapabilitySnapshot {
  value: AgentWorkspaceRuntimeCapability;
  freshUntil: number;
  staleUntil: number;
}

interface CapabilityProbeResult {
  value: AgentWorkspaceRuntimeCapability;
  imageId: string | null;
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

interface OpenDesignRunOutcome {
  deliverableValid: boolean;
  deliverableValidation?: string;
}

const SHA256_RE = /^[a-f0-9]{64}$/;
const SESSION_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const MAX_PACKAGE_OVERHEAD_BYTES = 2 * 1024 * 1024;
const MAX_COMMIT_RESPONSE_BYTES = 1024 * 1024;
const MAX_RUNTIME_DIAGNOSTIC_BYTES = 2 * 1024;
const MAX_QUALITY_REPAIR_ATTEMPTS = 1;
const MAX_OUTPUT_FILE_COUNT = 100;
const MAX_WORKSPACE_FILE_COUNT = 1024;
const MAX_WORKSPACE_NODE_COUNT = 2048;
const MAX_WORKSPACE_DIRECTORY_DEPTH = 16;
const MIN_WORKSPACE_STORAGE_BYTES = 64 * 1024 * 1024;
const WORKSPACE_STORAGE_HEADROOM_BYTES = 32 * 1024 * 1024;
const DATA_STORAGE_LIMIT_BYTES = 128 * 1024 * 1024;
const WORKSPACE_STORAGE_INODE_LIMIT = 4096;
const DATA_STORAGE_INODE_LIMIT = 4096;
const STORAGE_CAPABILITY_PROBE_BYTES = 1024 * 1024;
const STORAGE_CAPABILITY_PROBE_INODES = 64;
const DEFAULT_CLEANUP_RETRY_BASE_MS = 1000;
const DEFAULT_CLEANUP_RETRY_MAX_MS = 30_000;
const EGRESS_PROXY_PORT = 8787;
const ARTIFACT_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "connect-src 'none'",
  "form-action 'none'",
  "img-src data:",
  "font-src data:",
  "media-src data:",
  "style-src 'unsafe-inline'",
  "script-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "manifest-src 'none'",
].join('; ');
const DOCUMENT_ROOT_RE = /^\uFEFF?\s*(?:<!doctype\s+html\s*>\s*)?(?:<!--[\s\S]*?-->\s*)*<html(?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:"[^"<>]*"|'[^'<>]*'|[^\s"'\x60=<>]+))?)*\s*>/i;
const DOCUMENT_HEAD_RE = /^\s*(?:<!--[\s\S]*?-->\s*)*<head(?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:"[^"<>]*"|'[^'<>]*'|[^\s"'\x60=<>]+))?)*\s*>/i;
const IGNORED_RUNTIME_OUTPUT_PATHS = ['index.html.artifact.json'] as const;

// This script runs inside the isolated OpenDesign container before any bytes
// cross the Docker boundary. Original MAP inputs and CDS-managed skill files
// stay private; every other file must be a regular allowlisted output and fit
// the transfer contract. The host repeats validation after copy as defense in
// depth, but no unbounded or special file reaches docker cp first.
const OUTPUT_PREFLIGHT_SCRIPT = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const config = JSON.parse(Buffer.from(process.env.CDS_OUTPUT_PREFLIGHT_CONFIG || '', 'base64').toString('utf8'));
const root = '/workspace';
const inputPaths = new Set(config.inputPaths);
const ignoredRuntimePaths = new Set(config.ignoredRuntimePaths);
const allowed = (relative) => config.allowedOutputPaths.some((pattern) => {
  if (pattern.endsWith('/**')) {
    const prefix = pattern.slice(0, -3);
    return relative === prefix || relative.startsWith(prefix + '/');
  }
  return relative === pattern;
});
let fileCount = 0;
let totalBytes = 0;
let workspaceFileCount = 0;
let nodeCount = 0;
const fail = (code, relative = '') => {
  const encodedPath = relative ? ':' + Buffer.from(relative, 'utf8').toString('base64url') : '';
  process.stderr.write('CDS_OUTPUT_PREFLIGHT:' + code + encodedPath);
  process.exit(1);
};
const walk = (directory) => {
  for (const name of fs.readdirSync(directory)) {
    const absolute = path.join(directory, name);
    const relative = path.relative(root, absolute).split(path.sep).join('/');
    nodeCount += 1;
    if (nodeCount > config.maxNodeCount) fail('node_count');
    if (relative.split('/').length > config.maxDirectoryDepth) fail('directory_depth');
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) fail('special_file', relative);
    if (stat.isDirectory()) { walk(absolute); continue; }
    workspaceFileCount += 1;
    if (workspaceFileCount > config.maxWorkspaceFileCount) fail('workspace_file_count');
    if (allowed(relative)) {
      fileCount += 1;
      totalBytes += stat.size;
      if (fileCount > config.maxFileCount) fail('file_count');
      if (totalBytes > config.maxOutputBytes) fail('total_bytes');
      continue;
    }
    if (inputPaths.has(relative) || ignoredRuntimePaths.has(relative) || relative.startsWith('.od-skills/')) continue;
    fail('path_not_allowed', relative);
  }
};
walk(root);
`;

// OpenDesign never receives a routable egress network. This narrow relay is
// the only container attached to both the internal session network and Docker's
// outbound bridge. It pins one MAP origin/path, rejects redirects, and resolves
// DNS itself so private, loopback, link-local, and metadata ranges fail closed.
const EGRESS_PROXY_SCRIPT = String.raw`
const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns');
const net = require('node:net');
const crypto = require('node:crypto');
const target = new URL(process.env.TARGET_ORIGIN);
const prefix = process.env.TARGET_PATH_PREFIX || '/';
const mapModelTicket = process.env.MAP_MODEL_TICKET || '';
const relayClientToken = process.env.RELAY_CLIENT_TOKEN || '';
const requestStarts = [];
const maxRequestsPerMinute = 240;
const deniedAddresses = new net.BlockList();
for (const [address, prefix, type] of [
  ['0.0.0.0', 8, 'ipv4'], ['10.0.0.0', 8, 'ipv4'], ['100.64.0.0', 10, 'ipv4'],
  ['127.0.0.0', 8, 'ipv4'], ['169.254.0.0', 16, 'ipv4'], ['172.16.0.0', 12, 'ipv4'],
  ['192.0.0.0', 24, 'ipv4'], ['192.0.2.0', 24, 'ipv4'], ['192.168.0.0', 16, 'ipv4'],
  ['192.88.99.0', 24, 'ipv4'], ['198.18.0.0', 15, 'ipv4'], ['198.51.100.0', 24, 'ipv4'],
  ['203.0.113.0', 24, 'ipv4'], ['224.0.0.0', 4, 'ipv4'], ['240.0.0.0', 4, 'ipv4'],
  ['::', 128, 'ipv6'], ['::1', 128, 'ipv6'],
  ['64:ff9b::', 96, 'ipv6'], ['64:ff9b:1::', 48, 'ipv6'], ['100::', 64, 'ipv6'],
  ['2001:10::', 28, 'ipv6'], ['2001:20::', 28, 'ipv6'], ['2001:db8::', 32, 'ipv6'],
  ['fc00::', 7, 'ipv6'], ['fe80::', 10, 'ipv6'], ['fec0::', 10, 'ipv6'], ['ff00::', 8, 'ipv6'],
]) deniedAddresses.addSubnet(address, prefix, type);
function authorized(value) {
  if (!relayClientToken || typeof value !== 'string') return false;
  const actual = Buffer.from(value, 'utf8');
  const expected = Buffer.from('Bearer ' + relayClientToken, 'utf8');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
function loopback(address) {
  const value = String(address || '').toLowerCase().split('%')[0];
  return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1';
}
function blocked(address) {
  const value = String(address || '').toLowerCase().split('%')[0];
  const family = net.isIP(value);
  if (family === 4) return deniedAddresses.check(value, 'ipv4');
  if (family === 6) {
    if (value.startsWith('::ffff:') && net.isIP(value.slice(7)) === 4) return blocked(value.slice(7));
    return deniedAddresses.check(value, 'ipv6');
  }
  return true;
}
function admitted() {
  const cutoff = Date.now() - 60000;
  while (requestStarts.length && requestStarts[0] < cutoff) requestStarts.shift();
  if (requestStarts.length >= maxRequestsPerMinute) return false;
  requestStarts.push(Date.now());
  return true;
}
function pathAllowed(raw) {
  try {
    const pathname = new URL(raw, 'http://relay.invalid').pathname;
    return prefix === '/' || pathname === prefix || pathname.startsWith(prefix.endsWith('/') ? prefix : prefix + '/');
  } catch { return false; }
}
const server = http.createServer((req, res) => {
  if (req.url === '/__health') {
    res.writeHead(loopback(req.socket && req.socket.remoteAddress) ? (mapModelTicket && relayClientToken ? 204 : 503) : 403);
    res.end(); return;
  }
  if (!authorized(req.headers.authorization)) { res.writeHead(401); res.end(); return; }
  if (!admitted()) { res.writeHead(429, { 'retry-after': '60' }); res.end(); return; }
  if ((req.method !== 'GET' && req.method !== 'POST') || !pathAllowed(req.url || '/')) {
    res.writeHead(403); res.end(); return;
  }
  dns.lookup(target.hostname, { all: true, verbatim: true }, (lookupError, addresses) => {
    if (lookupError || !addresses.length || addresses.some((entry) => blocked(entry.address))) {
      res.writeHead(502); res.end(); return;
    }
    const selected = addresses[0];
    const headers = { ...req.headers, host: target.host };
    for (const name of [
      'authorization', 'proxy-authorization', 'x-api-key', 'api-key', 'apikey',
      'openai-api-key', 'anthropic-api-key', 'x-goog-api-key', 'x-auth-token',
      'x-access-token', 'cookie', 'set-cookie', 'connection', 'proxy-connection',
      'upgrade', 'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto',
    ]) delete headers[name];
    headers.authorization = 'Bearer ' + mapModelTicket;
    const transport = target.protocol === 'https:' ? https : http;
    const upstream = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || undefined,
      method: req.method,
      path: req.url,
      headers,
      lookup: (_hostname, options, callback) => {
        if (options && typeof options === 'object' && options.all) {
          callback(null, [selected]);
          return;
        }
        callback(null, selected.address, selected.family);
      },
    }, (upstreamResponse) => {
      if ((upstreamResponse.statusCode || 0) >= 300 && (upstreamResponse.statusCode || 0) < 400) {
        upstreamResponse.resume(); res.writeHead(502); res.end(); return;
      }
      const responseHeaders = { ...upstreamResponse.headers };
      delete responseHeaders.location;
      res.writeHead(upstreamResponse.statusCode || 502, responseHeaders);
      upstreamResponse.pipe(res);
    });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    upstream.setTimeout?.(90000, () => upstream.destroy());
    req.pipe(upstream);
  });
});
server.maxConnections = 16;
server.headersTimeout = 10000;
server.requestTimeout = 900000;
server.keepAliveTimeout = 5000;
server.on('connection', (socket) => socket.setTimeout(90000, () => socket.destroy()));
server.on('connect', (_req, socket) => socket.destroy());
server.on('upgrade', (_req, socket) => socket.destroy());
server.listen(Number(process.env.PROXY_PORT || '8787'), '0.0.0.0');
`;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function sha256(bytes: Uint8Array | string): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function runtimeDiagnosticPreview(value: string, excludedValues: string[]): string {
  let safe = value.replaceAll('\0', '');
  for (const excluded of excludedValues) {
    if (excluded) safe = safe.split(excluded).join('***[masked]***');
  }
  safe = maskSecrets(safe, { mask: true });
  const bytes = Buffer.from(safe, 'utf8');
  if (bytes.length <= MAX_RUNTIME_DIAGNOSTIC_BYTES) return safe;

  const suffix = `\n[cds runtime diagnostic truncated: original ${bytes.length} bytes]`;
  const textBudget = Math.max(0, MAX_RUNTIME_DIAGNOSTIC_BYTES - Buffer.byteLength(suffix, 'utf8'));
  let preview = bytes.subarray(0, textBudget).toString('utf8');
  while (Buffer.byteLength(preview, 'utf8') > textBudget) preview = preview.slice(0, -1);
  return `${preview}${suffix}`;
}

function outputPreflightRejectedPath(diagnostic: string, code: string): Record<string, unknown> {
  const match = diagnostic.match(new RegExp(`CDS_OUTPUT_PREFLIGHT:${code}:([A-Za-z0-9_-]{1,512})`));
  if (!match) return { stage: 'output_preflight' };
  try {
    const relative = Buffer.from(match[1], 'base64url').toString('utf8');
    normalizeRelativePath(relative);
    return { stage: 'output_preflight', rejectedPath: relative.slice(0, 240) };
  } catch {
    return { stage: 'output_preflight' };
  }
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

export function normalizeAgentWorkspaceModelBaseUrl(value: unknown): string {
  return validateTransferUrl(value, 'modelBaseUrl').toString();
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
  if (
    typeof value !== 'string'
    || !value.trim()
    || value !== value.trim()
    || value.length > 512
    || value.includes('\\')
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
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
  validateDesignTaskContract(runId, transfer.baseRevision, files);
  return { runId, files };
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
  const hasCurrentPage = files.some((file) => file.path === 'current/index.html');
  const responseContract = task.responseContract;
  if (
    typeof task.title !== 'string'
    || typeof task.instruction !== 'string'
    || !task.title.trim()
    || !task.instruction.trim()
    || !responseContract
    || typeof responseContract !== 'object'
    || Array.isArray(responseContract)
    || (responseContract as Record<string, unknown>).requiredFile !== 'index.html'
    || (responseContract as Record<string, unknown>).manifestFile !== 'manifest.json'
    || (responseContract as Record<string, unknown>).writeback !== 'external'
  ) {
    throw new AgentWorkspaceRuntimeError(
      'workspace_package_invalid',
      'brief/task.json title, instruction, and responseContract are incomplete',
    );
  }
  const expectedSources = hasCurrentPage
    ? ['title', 'instruction', 'knowledge', 'current-visible-content']
    : ['title', 'instruction', 'knowledge'];
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
  private readonly instanceRootDir: string;
  private readonly instanceId: string;
  private readonly instanceNameScope: string;
  private readonly image: string;
  private readonly daemonPort: number;
  private readonly fetchImpl: typeof fetch;
  private readonly pollIntervalMs: number;
  private readonly capabilityCacheMs: number;
  private readonly capabilityNegativeCacheMs: number;
  private readonly capabilityMaxStaleMs: number;
  private readonly containerUid: number;
  private readonly containerGid: number;
  private readonly autoPullImage: boolean;
  private readonly cleanupRetryBaseMs: number;
  private readonly cleanupRetryMaxMs: number;
  private readonly handles = new Map<string, ManagedRuntimeHandle>();
  private readonly cleanupRetryTimers = new Map<string, NodeJS.Timeout>();
  private readonly cleanupRetryAttempts = new Map<string, number>();
  private readonly cleanupInFlight = new Map<string, Promise<void>>();
  private capabilityCache: CapabilitySnapshot | null = null;
  private capabilityRefresh: Promise<CapabilityProbeResult> | null = null;
  private capabilityRetryAfter = 0;
  private capabilityRefreshError: string | null = null;
  private readonly runtimeValidationByImageId = new Map<string, boolean>();
  private hardStoragePolicyValidated = false;
  private hardStoragePolicyFailureCode: string | null = null;
  private hardStoragePolicyDiagnostic: string | null = null;
  private imagePreparation: Promise<void> | null = null;
  private imagePreparationAttemptedAt = 0;
  private imagePreparationError: string | null = null;
  private bootstrapPreparation: Promise<void> | null = null;
  private bootstrapAttempted = false;
  private bootstrapError: string | null = null;

  constructor(
    private readonly shell: IShellExecutor,
    options: AgentWorkspaceSessionRuntimeOptions = {},
  ) {
    this.rootDir = path.resolve(options.rootDir || process.env.CDS_AGENT_WORKSPACE_ROOT || '/tmp/cds-agent-workspaces');
    const configuredInstanceId = options.instanceId
      || computeCdsInstanceId(process.env.CDS_REPO_ROOT || path.resolve(process.cwd(), '..'));
    this.instanceId = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(configuredInstanceId)
      ? configuredInstanceId
      : sha256(configuredInstanceId).slice(0, 12);
    this.instanceNameScope = sha256(this.instanceId).slice(0, 8);
    this.instanceRootDir = path.join(this.rootDir, this.instanceNameScope);
    this.image = options.image || process.env.CDS_OPEN_DESIGN_IMAGE || OPEN_DESIGN_IMAGE;
    this.daemonPort = options.daemonPort || 7456;
    this.fetchImpl = options.fetchImpl || fetch;
    this.pollIntervalMs = Math.max(5, options.pollIntervalMs || 750);
    this.capabilityCacheMs = Math.max(0, options.capabilityCacheMs ?? 30_000);
    this.capabilityNegativeCacheMs = Math.max(0, options.capabilityNegativeCacheMs ?? 5_000);
    this.capabilityMaxStaleMs = Math.max(
      this.capabilityCacheMs,
      options.capabilityMaxStaleMs ?? 120_000,
    );
    this.containerUid = options.containerUid ?? 1001;
    this.containerGid = options.containerGid ?? 1001;
    this.autoPullImage = options.autoPullImage ?? process.env.CDS_OPEN_DESIGN_AUTO_PULL !== '0';
    this.cleanupRetryBaseMs = Math.max(1, options.cleanupRetryBaseMs ?? DEFAULT_CLEANUP_RETRY_BASE_MS);
    this.cleanupRetryMaxMs = Math.max(
      this.cleanupRetryBaseMs,
      options.cleanupRetryMaxMs ?? DEFAULT_CLEANUP_RETRY_MAX_MS,
    );
  }

  /**
   * Process-start barrier for the runtime. In-memory session handles cannot be
   * restored safely after a CDS restart, so daemon resources bearing both the
   * agent-session and this CDS instance label are reclaimed before the provider
   * becomes selectable. Legacy unlabeled resources are deliberately left for
   * operator reconciliation because shared-host ownership cannot be proven.
   */
  async bootstrap(): Promise<void> {
    if (this.bootstrapPreparation) return this.bootstrapPreparation;
    this.bootstrapAttempted = true;
    const preparation = (async () => {
      await this.recoverOrphans();
      await this.prepareImage();
      await this.refreshCapability().catch(() => undefined);
    })()
      .then(() => { this.bootstrapError = null; })
      .catch((error) => {
        this.bootstrapError = error instanceof Error ? error.message : 'Agent workspace bootstrap failed';
      })
      .finally(() => {
        this.bootstrapPreparation = null;
      });
    this.bootstrapPreparation = preparation;
    return preparation;
  }

  async recoverOrphans(): Promise<void> {
    if (this.handles.size > 0) {
      throw new AgentWorkspaceRuntimeError(
        'workspace_recovery_conflict',
        'Agent workspace recovery cannot run while managed sessions are active',
      );
    }
    const failures: string[] = [];
    const removeLabeled = async (
      listCommand: string,
      remove: (identifier: string) => Promise<void>,
      kind: string,
    ): Promise<void> => {
      const listed = await this.shell.exec(listCommand, { timeout: 30_000 });
      if (listed.exitCode !== 0) {
        failures.push(`${kind} listing failed`);
        return;
      }
      const identifiers = listed.stdout.split(/\s+/).map((value) => value.trim()).filter(Boolean);
      for (const identifier of identifiers) {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,255}$/.test(identifier)) {
          failures.push(`${kind} returned an unsafe identifier`);
          continue;
        }
        await remove(identifier).catch(() => failures.push(`${kind} ${identifier} cleanup failed`));
      }
    };

    await removeLabeled(
      `docker ps -aq --filter ${shellQuote('label=cds.type=agent-session')} --filter ${shellQuote(`label=cds.instance=${this.instanceId}`)}`,
      (identifier) => this.removeContainer(identifier),
      'container',
    );
    await removeLabeled(
      `docker network ls -q --filter ${shellQuote('label=cds.type=agent-session')} --filter ${shellQuote(`label=cds.instance=${this.instanceId}`)}`,
      (identifier) => this.removeNetwork(identifier),
      'network',
    );
    await removeLabeled(
      `docker volume ls -q --filter ${shellQuote('label=cds.type=agent-session')} --filter ${shellQuote(`label=cds.instance=${this.instanceId}`)}`,
      (identifier) => this.removeVolume(identifier),
      'volume',
    );

    try {
      if (fs.existsSync(this.instanceRootDir)) {
        for (const entry of fs.readdirSync(this.instanceRootDir, { withFileTypes: true })) {
          if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
          const target = path.resolve(this.instanceRootDir, entry.name);
          if (path.dirname(target) !== this.instanceRootDir) {
            failures.push('workspace cleanup resolved outside the configured root');
            continue;
          }
          fs.rmSync(target, { recursive: true, force: true });
        }
        fs.rmdirSync(this.instanceRootDir);
      }
    } catch {
      failures.push('workspace directory cleanup failed');
    }
    if (failures.length > 0) {
      throw new AgentWorkspaceRuntimeError(
        'workspace_orphan_cleanup_failed',
        'Stale Agent workspace resources could not be fully reclaimed',
        true,
        { failures },
      );
    }
  }

  async prepareImage(): Promise<void> {
    if (!this.autoPullImage) return;
    if (this.imagePreparation) return this.imagePreparation;
    if (this.imagePreparationError && Date.now() - this.imagePreparationAttemptedAt < 60_000) return;
    this.imagePreparationAttemptedAt = Date.now();
    const preparation = (async () => {
      const docker = await this.shell.exec("docker version --format '{{.Server.Version}}'", { timeout: 5000 });
      if (docker.exitCode !== 0 || !docker.stdout.trim()) {
        throw new Error('Docker daemon is unavailable');
      }
      const installed = await this.shell.exec(
        `docker image inspect ${shellQuote(this.image)} --format ${shellQuote('{{.Id}}')}`,
        { timeout: 10_000 },
      );
      if (installed.exitCode === 0 && installed.stdout.trim()) return;
      const pulled = await this.shell.exec(`docker pull ${shellQuote(this.image)}`, { timeout: 600_000 });
      if (pulled.exitCode !== 0) throw new Error(classifyImagePullFailure(pulled.stdout, pulled.stderr));
      const verified = await this.shell.exec(
        `docker image inspect ${shellQuote(this.image)} --format ${shellQuote('{{.Id}}')}`,
        { timeout: 10_000 },
      );
      if (verified.exitCode !== 0 || !verified.stdout.trim()) {
        throw new Error('runtime image is still unavailable after pull');
      }
    })()
      .then(() => { this.imagePreparationError = null; })
      .catch((error) => {
        this.imagePreparationError = error instanceof Error ? error.message : 'runtime image preparation failed';
      })
      .finally(() => {
        this.imagePreparation = null;
      });
    this.imagePreparation = preparation;
    return preparation;
  }

  /**
   * 默认供 Provider 目录读取：只返回内存快照并在后台刷新，绝不等待最长 45 秒的 Docker 冷探针。
   * force 只供会话创建安全门使用：等待同一个去重刷新，并在探针异常时从严返回不可用。
   */
  async capability(force = false): Promise<AgentWorkspaceRuntimeCapability> {
    const now = Date.now();
    if (this.bootstrapPreparation) {
      return {
        available: false,
        resourcePolicyEnforcedPerSession: false,
        reason: 'Agent workspace startup recovery is still running',
      };
    }
    if (this.bootstrapAttempted && this.bootstrapError) {
      return {
        available: false,
        resourcePolicyEnforcedPerSession: false,
        reason: `Agent workspace startup recovery failed: ${this.bootstrapError}`,
      };
    }
    if (force) {
      try {
        return (await this.refreshCapability()).value;
      } catch {
        return this.failedCapabilitySnapshot();
      }
    }
    if (this.capabilityCache && this.capabilityCache.freshUntil > now) {
      return this.capabilityCache.value;
    }
    if (now >= this.capabilityRetryAfter) void this.refreshCapability().catch(() => undefined);
    if (this.capabilityCache && this.capabilityCache.staleUntil > now) {
      return this.capabilityCache.value;
    }
    return this.pendingCapabilitySnapshot();
  }

  private refreshCapability(): Promise<CapabilityProbeResult> {
    if (this.capabilityRefresh) return this.capabilityRefresh;
    const refresh = this.probeCapability()
      .then((result) => {
        const now = Date.now();
        const freshFor = result.value.available
          ? this.capabilityCacheMs
          : this.capabilityNegativeCacheMs;
        this.capabilityCache = {
          value: result.value,
          freshUntil: now + freshFor,
          staleUntil: now + this.capabilityMaxStaleMs,
        };
        this.capabilityRetryAfter = now + freshFor;
        this.capabilityRefreshError = null;
        return result;
      })
      .catch((error) => {
        const now = Date.now();
        this.capabilityRefreshError = error instanceof Error
          ? error.message
          : 'Docker capability probe failed';
        this.capabilityRetryAfter = now + this.capabilityNegativeCacheMs;
        if (!this.capabilityCache || this.capabilityCache.staleUntil <= now) {
          this.capabilityCache = {
            value: this.failedCapabilitySnapshot(),
            freshUntil: this.capabilityRetryAfter,
            staleUntil: this.capabilityRetryAfter,
          };
        }
        throw error;
      })
      .finally(() => {
        this.capabilityRefresh = null;
      });
    this.capabilityRefresh = refresh;
    return refresh;
  }

  private async probeCapability(): Promise<CapabilityProbeResult> {
    const docker = await this.shell.exec("docker version --format '{{.Server.Version}}'", { timeout: 5000 });
    if (docker.exitCode !== 0 || !docker.stdout.trim()) {
      return {
        imageId: null,
        value: {
          available: false,
          resourcePolicyEnforcedPerSession: false,
          reason: 'Docker daemon is unavailable; dedicated Agent workspace containers cannot be enforced',
        },
      };
    }

    const image = await this.shell.exec(
      `docker image inspect ${shellQuote(this.image)} --format ${shellQuote('{{.Id}}')}`,
      { timeout: 10_000 },
    );
    const imageId = image.exitCode === 0 ? image.stdout.trim() : '';
    if (!imageId) {
      if (this.autoPullImage) {
        void this.prepareImage().then(() => {
          if (!this.imagePreparationError) void this.refreshCapability().catch(() => undefined);
        });
      }
      return {
        imageId: null,
        value: {
          available: false,
          resourcePolicyEnforcedPerSession: false,
          reason: !this.autoPullImage
            ? `OpenDesign image ${this.image} is not installed on this CDS node`
            : this.imagePreparationError
              ? `OpenDesign image ${this.image} could not be prepared on this CDS node: ${this.imagePreparationError}`
              : `OpenDesign image ${this.image} is being prepared on this CDS node`,
        },
      };
    }

    let runtimeAvailable = this.runtimeValidationByImageId.get(imageId);
    if (runtimeAvailable === undefined) {
      const runtimeValidation = await this.shell.exec([
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
        shellQuote([
          '(command -v opencode-cli >/dev/null 2>&1 || command -v opencode >/dev/null 2>&1)',
          `test -f ${OPEN_DESIGN_WEB_PROTOTYPE_SOURCE}/SKILL.md`,
          `test -f ${OPEN_DESIGN_WEB_PROTOTYPE_SOURCE}/assets/template.html`,
          `test -f ${OPEN_DESIGN_WEB_PROTOTYPE_SOURCE}/references/layouts.md`,
          `test -f ${OPEN_DESIGN_WEB_PROTOTYPE_SOURCE}/references/checklist.md`,
        ].join(' && ')),
      ].join(' '), { timeout: 30_000 });
      runtimeAvailable = runtimeValidation.exitCode === 0;
      this.runtimeValidationByImageId.clear();
      this.runtimeValidationByImageId.set(imageId, runtimeAvailable);
    }

    if (runtimeAvailable && !this.hardStoragePolicyValidated) {
      this.hardStoragePolicyValidated = await this.probeHardStoragePolicy();
    }

    return {
      imageId,
      value: runtimeAvailable && this.hardStoragePolicyValidated
        ? { available: true, resourcePolicyEnforcedPerSession: true, reason: null }
        : !runtimeAvailable
          ? {
            available: false,
            resourcePolicyEnforcedPerSession: false,
            reason: `OpenDesign image ${this.image} does not contain the required OpenCode Agent CLI and web prototype resources`,
          }
          : {
              available: false,
              resourcePolicyEnforcedPerSession: false,
              reason: `Docker node cannot enforce and verify hard per-session Agent workspace storage limits (${this.hardStoragePolicyFailureCode || 'unknown'}${this.hardStoragePolicyDiagnostic ? `; ${this.hardStoragePolicyDiagnostic}` : ''})`,
            },
    };
  }

  private async probeHardStoragePolicy(): Promise<boolean> {
    const volumeName = `cds-od-storage-probe-${this.instanceNameScope}`;
    const sessionLabel = `capability-${this.instanceNameScope}`;
    let created = false;
    let verified = false;
    let removed = false;
    this.hardStoragePolicyFailureCode = null;
    this.hardStoragePolicyDiagnostic = null;
    try {
      // Treat the name as allocated before Docker replies: a timed-out create
      // can still have succeeded in the daemon and therefore must be removed.
      created = true;
      const volume = await this.shell.exec(
        this.limitedVolumeCreateCommand(
          volumeName,
          STORAGE_CAPABILITY_PROBE_BYTES,
          STORAGE_CAPABILITY_PROBE_INODES,
          sessionLabel,
        ),
        { timeout: 30_000 },
      );
      if (volume.exitCode === 0) {
        const validation = await this.shell.exec([
          'docker run --rm',
          '--pull never',
          '--network none',
          '--read-only',
          '--security-opt no-new-privileges:true',
          '--cap-drop ALL',
          // The probe volume is intentionally mode=0700 and owned by root.
          // Production sessions separately initialize their volume ownership;
          // this probe verifies the daemon's byte/inode enforcement itself.
          '--user 0:0',
          '--pids-limit 32',
          '--memory 64m',
          '--cpus 0.1',
          `--mount ${shellQuote(`type=volume,src=${volumeName},dst=/cds-storage-probe,volume-nocopy`)}`,
          `--tmpfs ${shellQuote(`/cds-direct-storage-probe:rw,noexec,nosuid,size=${STORAGE_CAPABILITY_PROBE_BYTES},nr_inodes=${STORAGE_CAPABILITY_PROBE_INODES},mode=0700`)}`,
          '--entrypoint /bin/sh',
          shellQuote(this.image),
          '-lc',
          // POSIX shells may terminate when a redirection on the special `:`
          // builtin fails. Keep that expected ENOSPC inside a subshell so the
          // parent can observe it, break the loop, and finish the probe.
          shellQuote('set -u; command -v dd >/dev/null 2>&1 || exit 10; stage=20; for root in /cds-storage-probe /cds-direct-storage-probe; do dd if=/dev/zero of="$root/within-limit" bs=524288 count=1 2>/dev/null || exit $((stage + 1)); if dd if=/dev/zero of="$root/over-limit" bs=1048576 count=2 2>/dev/null; then exit $((stage + 2)); fi; rm -f "$root/within-limit" "$root/over-limit" || exit $((stage + 3)); created=0; while [ "$created" -lt 128 ]; do if ( : > "$root/inode-limit-$created" ) 2>/dev/null; then created=$((created + 1)); else break; fi; done; test "$created" -lt 128 || exit $((stage + 4)); rm -f "$root"/inode-limit-* || exit $((stage + 5)); stage=30; done; exit 0'),
        ].join(' '), { timeout: 30_000 });
        verified = validation.exitCode === 0;
        if (!verified) {
          const diagnostic = `${validation.stderr}\n${validation.stdout}`.toLowerCase();
          const category = diagnostic.includes('permission denied')
            ? 'permission_denied'
            : diagnostic.includes('operation not permitted')
              ? 'operation_not_permitted'
              : diagnostic.includes('invalid argument') || diagnostic.includes('invalid mount')
                ? 'invalid_mount'
                : diagnostic.includes('unknown flag') || diagnostic.includes('unknown option')
                  ? 'unsupported_option'
                  : diagnostic.includes('no space left')
                    ? 'no_space'
                    : diagnostic.includes('read-only')
                      ? 'read_only'
                      : diagnostic.length > 0
                        ? 'docker_or_shell_error'
                        : 'no_diagnostic';
          this.hardStoragePolicyFailureCode = `validation_exit_${validation.exitCode}_${category}`;
          this.hardStoragePolicyDiagnostic = runtimeDiagnosticPreview(
            `${validation.stderr}\n${validation.stdout}`,
            [volumeName, this.image],
          ).trim().replace(/\s+/g, ' ').slice(0, 240) || null;
        }
      } else {
        this.hardStoragePolicyFailureCode = `volume_create_exit_${volume.exitCode}`;
      }
    } catch {
      verified = false;
      this.hardStoragePolicyFailureCode = 'probe_exception';
    } finally {
      if (created) {
        await this.removeVolume(volumeName)
          .then(() => { removed = true; })
          .catch(() => { removed = false; });
      }
    }
    if (!removed) this.hardStoragePolicyFailureCode = 'volume_remove_failed';
    return verified && removed;
  }

  private limitedVolumeCreateCommand(
    volumeName: string,
    maxBytes: number,
    maxInodes: number,
    sessionId: string,
  ): string {
    return [
      'docker volume create',
      '--driver local',
      '--opt type=tmpfs',
      '--opt device=tmpfs',
      `--opt ${shellQuote(`o=size=${maxBytes},nr_inodes=${maxInodes},mode=0700`)}`,
      '--label cds.managed=true',
      '--label cds.type=agent-session',
      `--label ${shellQuote(`cds.instance=${this.instanceId}`)}`,
      `--label ${shellQuote(`cds.agent.session=${sessionId}`)}`,
      shellQuote(volumeName),
    ].join(' ');
  }

  private pendingCapabilitySnapshot(): AgentWorkspaceRuntimeCapability {
    return {
      available: false,
      resourcePolicyEnforcedPerSession: false,
      reason: this.capabilityRefreshError
        ? 'Docker capability probe failed; dedicated Agent workspace containers remain disabled'
        : 'OpenDesign capability verification is running on this CDS node',
      ...(this.capabilityRefreshError ? {} : { verificationPending: true }),
    };
  }

  private failedCapabilitySnapshot(): AgentWorkspaceRuntimeCapability {
    return {
      available: false,
      resourcePolicyEnforcedPerSession: false,
      reason: 'Docker capability probe failed; dedicated Agent workspace containers remain disabled',
    };
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
    if (policy.autoCleanupMinutes * 60 < policy.timeoutSeconds + 120) {
      throw new AgentWorkspaceRuntimeError(
        'resource_policy_not_enforced',
        'OpenDesign auto-cleanup must leave at least two minutes for result validation and commit',
      );
    }
    const capability = await this.capability(true);
    if (!capability.available || !capability.resourcePolicyEnforcedPerSession) {
      throw new AgentWorkspaceRuntimeError('workspace_runtime_unavailable', capability.reason || 'workspace runtime unavailable', true);
    }
    const transfer = normalizeWorkspaceTransfer(rawTransfer);
    fs.mkdirSync(this.instanceRootDir, { recursive: true, mode: 0o700 });
    const hostRoot = fs.mkdtempSync(path.join(this.instanceRootDir, `${sessionId}-`));
    const workspaceDir = path.join(hostRoot, 'workspace');
    const outputDir = path.join(hostRoot, 'output');
    const dataDir = path.join(hostRoot, 'data');
    const suffix = sha256(sessionId).slice(0, 16);
    const containerName = `cds-od-${this.instanceNameScope}-${suffix}`;
    const storageKeeperName = `${containerName}-storage`;
    const networkName = `cds-od-net-${this.instanceNameScope}-${suffix}`;
    const workspaceVolumeName = `cds-od-ws-${this.instanceNameScope}-${suffix}`;
    const dataVolumeName = `cds-od-data-${this.instanceNameScope}-${suffix}`;
    let containerCreated = false;
    let storageKeeperCreated = false;
    let networkCreated = false;
    const createdVolumes: string[] = [];
    try {
      fs.mkdirSync(workspaceDir, { recursive: true, mode: 0o755 });
      fs.mkdirSync(outputDir, { recursive: true, mode: 0o750 });
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
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
        fs.writeFileSync(target, file.bytes, { mode: 0o644, flag: 'wx' });
      }
      this.chownForContainer(hostRoot);
      onStage('workspace_materialized', { fileCount: files.length });

      // Docker 命令超时或返回非零时也可能已经创建了具名资源。名称由 session 派生且
      // 归当前 runtime 独占，因此从发起命令起就按“可能存在”登记，失败收尾会用
      // No-such 幂等删除确认，而不是假定非零退出等于零残留。
      networkCreated = true;
      const network = await this.shell.exec(
        `docker network create --internal --label cds.managed=true --label cds.type=agent-session --label ${shellQuote(`cds.instance=${this.instanceId}`)} --label ${shellQuote(`cds.agent.session=${sessionId}`)} ${shellQuote(networkName)}`,
        { timeout: 30_000 },
      );
      if (network.exitCode !== 0) {
        throw new AgentWorkspaceRuntimeError('workspace_network_create_failed', 'could not create isolated Agent network', true);
      }
      const workspaceStorageLimitBytes = Math.max(
        MIN_WORKSPACE_STORAGE_BYTES,
        transfer.maxInputBytes + transfer.maxOutputBytes + WORKSPACE_STORAGE_HEADROOM_BYTES,
      );
      for (const [volumeName, maxBytes, maxInodes] of [
        [workspaceVolumeName, workspaceStorageLimitBytes, WORKSPACE_STORAGE_INODE_LIMIT],
        [dataVolumeName, DATA_STORAGE_LIMIT_BYTES, DATA_STORAGE_INODE_LIMIT],
      ] as const) {
        createdVolumes.push(volumeName);
        const volume = await this.shell.exec(
          this.limitedVolumeCreateCommand(volumeName, maxBytes, maxInodes, sessionId),
          { timeout: 30_000 },
        );
        if (volume.exitCode !== 0) {
          throw new AgentWorkspaceRuntimeError('workspace_volume_create_failed', 'could not create Agent workspace volume', true);
        }
      }
      // A local-driver tmpfs volume is unmounted when its last consumer exits.
      // Copying into a stopped container and then running a short init helper
      // can therefore lose both bytes and ownership before the real container
      // starts. Keep both mounts alive across copy, chown and startup; once the
      // main container is running it becomes the volume consumer and this
      // helper can be removed without remounting the tmpfs.
      storageKeeperCreated = true;
      const storageKeeper = await this.shell.exec([
        'docker run --detach',
        '--pull never',
        `--name ${shellQuote(storageKeeperName)}`,
        '--restart no',
        '--network none',
        '--read-only',
        '--security-opt no-new-privileges:true',
        '--cap-drop ALL',
        '--user 0:0',
        '--pids-limit 16',
        '--memory 32m',
        '--cpus 0.05',
        `--label ${shellQuote('cds.managed=true')}`,
        `--label ${shellQuote('cds.type=agent-session')}`,
        `--label ${shellQuote(`cds.instance=${this.instanceId}`)}`,
        `--label ${shellQuote(`cds.agent.session=${sessionId}`)}`,
        `--mount ${shellQuote(`type=volume,src=${workspaceVolumeName},dst=/workspace,volume-nocopy`)}`,
        `--mount ${shellQuote(`type=volume,src=${dataVolumeName},dst=/app/.od,volume-nocopy`)}`,
        '--entrypoint /bin/sh',
        shellQuote(this.image),
        '-c',
        shellQuote('while :; do sleep 300; done'),
      ].join(' '), { timeout: 30_000 });
      if (storageKeeper.exitCode !== 0) {
        throw new AgentWorkspaceRuntimeError(
          'workspace_volume_keeper_start_failed',
          'Agent workspace storage mount could not be held during initialization',
          true,
          {
            stage: 'docker_volume_keeper',
            exitCode: storageKeeper.exitCode,
            stderrPreview: runtimeDiagnosticPreview(storageKeeper.stderr, [storageKeeperName]),
            stdoutPreview: runtimeDiagnosticPreview(storageKeeper.stdout, [storageKeeperName]),
          },
        );
      }
      const daemonApiToken = crypto.randomBytes(32).toString('hex');
      const egressClientToken = `cds-placeholder-${crypto.randomBytes(32).toString('base64url')}`;
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
      const envFilePath = path.join(hostRoot, `.docker-env-${crypto.randomBytes(8).toString('hex')}`);
      fs.writeFileSync(envFilePath, env, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      const command = [
        'docker create',
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
        '--tmpfs /tmp:rw,noexec,nosuid,size=128m,nr_inodes=2048',
        `--tmpfs ${shellQuote(`/app/design-templates:rw,noexec,nosuid,size=8m,nr_inodes=512,uid=${this.containerUid},gid=${this.containerGid},mode=0755`)}`,
        `--network ${shellQuote(networkName)}`,
        `--label ${shellQuote('cds.managed=true')}`,
        `--label ${shellQuote('cds.type=agent-session')}`,
        `--label ${shellQuote(`cds.instance=${this.instanceId}`)}`,
        `--label ${shellQuote(`cds.agent.session=${sessionId}`)}`,
        `--mount ${shellQuote(`type=volume,src=${workspaceVolumeName},dst=/workspace,volume-nocopy`)}`,
        `--mount ${shellQuote(`type=volume,src=${dataVolumeName},dst=/app/.od,volume-nocopy`)}`,
        `--env-file ${shellQuote(envFilePath)}`,
        shellQuote(this.image),
      ].join(' ');
      onStage('container_starting', { image: this.image });
      let started: ExecResult;
      containerCreated = true;
      try {
        started = await this.shell.exec(command, { timeout: 120_000 });
      } finally {
        fs.rmSync(envFilePath, { force: true });
      }
      if (started.exitCode !== 0) {
        const excludedDiagnosticValues = [daemonApiToken, transfer.transferToken, command];
        throw new AgentWorkspaceRuntimeError(
          'workspace_container_create_failed',
          'OpenDesign container failed to be created',
          true,
          {
            stage: 'docker_create',
            exitCode: started.exitCode,
            stderrPreview: runtimeDiagnosticPreview(started.stderr, excludedDiagnosticValues),
            stdoutPreview: runtimeDiagnosticPreview(started.stdout, excludedDiagnosticValues),
          },
        );
      }
      // Match CDS project validation's established sibling-container pattern:
      // docker cp streams from the control-plane filesystem through the Docker
      // API, so no control-container /tmp path is misinterpreted as a daemon
      // host bind source.
      const copied = await this.shell.exec(
        `docker cp ${shellQuote(`${workspaceDir}/.`)} ${shellQuote(`${containerName}:/workspace/`)}`,
        { timeout: 90_000 },
      );
      if (copied.exitCode !== 0) {
        throw new AgentWorkspaceRuntimeError('workspace_copy_failed', 'workspace files could not be copied into the Agent volume', true);
      }
      const initialized = await this.shell.exec([
        'docker run --rm',
        '--pull never',
        '--network none',
        '--read-only',
        '--security-opt no-new-privileges:true',
        '--cap-drop ALL',
        '--cap-add CHOWN',
        '--user 0:0',
        `--label ${shellQuote('cds.managed=true')}`,
        `--label ${shellQuote('cds.type=agent-session')}`,
        `--label ${shellQuote(`cds.instance=${this.instanceId}`)}`,
        `--label ${shellQuote(`cds.agent.session=${sessionId}`)}`,
        `--mount ${shellQuote(`type=volume,src=${workspaceVolumeName},dst=/workspace,volume-nocopy`)}`,
        `--mount ${shellQuote(`type=volume,src=${dataVolumeName},dst=/app/.od,volume-nocopy`)}`,
        '--entrypoint /bin/sh',
        shellQuote(this.image),
        '-c',
        shellQuote(`chown ${this.containerUid}:${this.containerGid} /workspace /app/.od`),
      ].join(' '), { timeout: 90_000 });
      if (initialized.exitCode !== 0) {
        throw new AgentWorkspaceRuntimeError(
          'workspace_volume_init_failed',
          'Agent workspace volume ownership could not be initialized',
          true,
          {
            stage: 'docker_volume_init',
            exitCode: initialized.exitCode,
            stderrPreview: runtimeDiagnosticPreview(initialized.stderr, []),
            stdoutPreview: runtimeDiagnosticPreview(initialized.stdout, []),
          },
        );
      }
      const startedContainer = await this.shell.exec(`docker start ${shellQuote(containerName)}`, { timeout: 30_000 });
      if (startedContainer.exitCode !== 0) {
        throw new AgentWorkspaceRuntimeError('workspace_container_start_failed', 'OpenDesign container failed to start', true);
      }
      await this.removeContainer(storageKeeperName);
      storageKeeperCreated = false;
      const preparedDesignTemplate = await this.shell.exec([
        'docker exec',
        shellQuote(containerName),
        '/bin/sh -lc',
        shellQuote([
          'mkdir -p /app/design-templates/web-prototype',
          'mkdir -p /workspace/.od-skills/web-prototype',
          `cp -a ${OPEN_DESIGN_WEB_PROTOTYPE_SOURCE}/. /app/design-templates/web-prototype/`,
          `cp -a ${OPEN_DESIGN_WEB_PROTOTYPE_SOURCE}/. /workspace/.od-skills/web-prototype/`,
          `if [ -f /workspace/current/index.html ]; then cp /workspace/current/index.html /workspace/index.html; elif [ ! -f /workspace/index.html ]; then cp ${OPEN_DESIGN_WEB_PROTOTYPE_SOURCE}/assets/template.html /workspace/index.html; fi`,
          'test -f /app/design-templates/web-prototype/SKILL.md',
          'test -f /app/design-templates/web-prototype/assets/template.html',
          'test -f /app/design-templates/web-prototype/references/layouts.md',
          'test -f /app/design-templates/web-prototype/references/checklist.md',
          'test -f /workspace/.od-skills/web-prototype/assets/template.html',
          'test -f /workspace/.od-skills/web-prototype/references/layouts.md',
          'test -f /workspace/.od-skills/web-prototype/references/checklist.md',
          'test -f /workspace/index.html',
        ].join(' && ')),
      ].join(' '), { timeout: 30_000 });
      if (preparedDesignTemplate.exitCode !== 0) {
        throw new AgentWorkspaceRuntimeError(
          'workspace_design_template_init_failed',
          'OpenDesign web prototype resources could not be prepared',
          false,
          {
            stage: 'design_template_init',
            exitCode: preparedDesignTemplate.exitCode,
            stderrPreview: runtimeDiagnosticPreview(preparedDesignTemplate.stderr, []),
            stdoutPreview: runtimeDiagnosticPreview(preparedDesignTemplate.stdout, []),
          },
        );
      }
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
        kind: 'active',
        sessionId,
        mapRunId: workspacePackage.runId,
        hostRoot,
        workspaceDir,
        outputDir,
        dataDir,
        containerName,
        networkName,
        workspaceVolumeName,
        dataVolumeName,
        inputPaths: files.map((file) => file.path),
        daemonBaseUrl,
        daemonApiToken,
        egressClientToken,
        transfer: publicTransfer(transfer),
        policy,
        ttlTimer,
        onCleanupSettled: onExpired,
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
      const remainingContainerNames = new Set([
        ...(containerCreated ? [containerName] : []),
        ...(storageKeeperCreated ? [storageKeeperName] : []),
      ]);
      let remainingNetworkName = networkCreated ? networkName : undefined;
      const remainingVolumeNames = new Set(createdVolumes);
      let remainingHostRoot: string | undefined = hostRoot;
      for (const allocatedContainerName of [...remainingContainerNames]) {
        await this.removeContainer(allocatedContainerName)
          .then(() => { remainingContainerNames.delete(allocatedContainerName); })
          .catch((cleanupError) => {
            cleanupErrors.push(cleanupError instanceof Error ? cleanupError.message : String(cleanupError));
          });
      }
      if (networkCreated) {
        await this.removeNetwork(networkName)
          .then(() => { remainingNetworkName = undefined; })
          .catch((cleanupError) => {
            cleanupErrors.push(cleanupError instanceof Error ? cleanupError.message : String(cleanupError));
          });
      }
      for (const volumeName of [...createdVolumes].reverse()) {
        await this.removeVolume(volumeName)
          .then(() => { remainingVolumeNames.delete(volumeName); })
          .catch((cleanupError) => {
            cleanupErrors.push(cleanupError instanceof Error ? cleanupError.message : String(cleanupError));
          });
      }
      try {
        fs.rmSync(hostRoot, { recursive: true, force: true });
        remainingHostRoot = undefined;
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError instanceof Error ? cleanupError.message : String(cleanupError));
      }
      this.removeInstanceRootIfEmpty();
      if (cleanupErrors.length > 0) {
        this.handles.set(sessionId, {
          kind: 'partial-cleanup',
          sessionId,
          ...(remainingHostRoot ? { hostRoot: remainingHostRoot } : {}),
          containerNames: [...remainingContainerNames],
          ...(remainingNetworkName ? { networkName: remainingNetworkName } : {}),
          volumeNames: [...remainingVolumeNames],
          onCleanupSettled: onExpired,
        });
        this.scheduleCleanupRetry(sessionId);
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
    if (handle.kind === 'partial-cleanup') {
      throw new AgentWorkspaceRuntimeError(
        'workspace_cleanup_pending',
        'OpenDesign workspace session cannot execute while resource cleanup is pending',
        true,
      );
    }
    const executionDeadline = Date.now() + Math.max(1, handle.policy.timeoutSeconds) * 1000;
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
        skillId: OPEN_DESIGN_WEB_PROTOTYPE_SKILL,
        orchestratorWorkspace: {
          kind: 'scratch',
          sourceLabel: 'MAP design workspace',
          sourceRef: sessionId,
          baseRevision: handle.transfer.baseRevision,
          writeback: 'external',
        },
      },
      signal: this.signalForDeadline(executionDeadline, signal),
    });
    const project = imported.project as Record<string, unknown> | undefined;
    const projectId = typeof project?.id === 'string' ? project.id : '';
    const conversationId = typeof imported.conversationId === 'string' ? imported.conversationId : '';
    if (!projectId || !conversationId) {
      throw new AgentWorkspaceRuntimeError('open_design_contract_mismatch', 'OpenDesign folder import returned no project identity');
    }
    if (project?.skillId !== OPEN_DESIGN_WEB_PROTOTYPE_SKILL) {
      throw new AgentWorkspaceRuntimeError('open_design_contract_mismatch', 'OpenDesign folder import did not retain the required web prototype skill');
    }
    const proxiedModelBaseUrl = await this.startEgressProxy(
      handle,
      model.baseUrl,
      model.apiKey,
      handle.egressClientToken,
    );
    const agentModelPlaceholderKey = handle.egressClientToken;
    const knowledgeDir = path.join(handle.workspaceDir, 'knowledge');
    const knowledgeFiles = fs.existsSync(knowledgeDir)
      ? fs.readdirSync(knowledgeDir, { withFileTypes: true })
          .filter((entry) => entry.isFile())
          .map((entry) => `/workspace/knowledge/${entry.name}`)
          .sort()
      : [];
    const currentIndexPath = path.join(handle.workspaceDir, 'current', 'index.html');
    const editingExistingPage = fs.existsSync(currentIndexPath);
    try {
    const systemPrompt = [
      'The workspace is already prepared by MAP. Read /workspace/brief/task.json first; its operation, instruction, and title are authoritative.',
      'The versioned qualityContract in task.json is mandatory. Factual claims, measured values, dates, prices, contact details, and links must come from the listed MAP sources. Review what each number describes and never attach a sourced value to a different subject. Remove visible placeholders, empty links, missing fragment targets, and enabled buttons without provable declarative behavior.',
      knowledgeFiles.length > 0
        ? `Read every knowledge source before editing: ${knowledgeFiles.join(', ')}. Use those files as the only source for factual claims and product copy.`
        : 'This task has no knowledge source files. Do not invent factual claims or metrics.',
      'The active web-prototype skill side files are rooted at /workspace/.od-skills/web-prototype. Read /workspace/.od-skills/web-prototype/assets/template.html, /workspace/.od-skills/web-prototype/references/layouts.md, and /workspace/.od-skills/web-prototype/references/checklist.md by these exact paths; do not resolve them as /workspace/assets or /workspace/references.',
      editingExistingPage
        ? 'A starting /workspace/index.html already exists; it is the exact current published page and must remain the starting point. The generic template is reference material only. Never replace the product identity with OpenDesign or copy generic template copy into the deliverable.'
        : 'This is a new page. Create /workspace/index.html from the MAP task and knowledge sources; the generic template is reference material only and its sample identity or copy must not appear in the deliverable.',
      editingExistingPage
        ? 'Modify index.html with small targeted edit operations; never replace the whole document with one write operation. The user instruction has priority over example text. Complete every requested change and do not stop after one replacement. Then reread task.json and index.html. Remove every unresolved placeholder and verify every visible-language and content constraint before claiming completion.'
        : 'Build a complete responsive index.html, then reread task.json, every knowledge file, and the finished page. Remove every unresolved placeholder and verify every visible-language, source accuracy, navigation, control, and content constraint before claiming completion.',
      'Keep the final webpage in index.html. The first release is declarative-only and self-contained: inline CSS, fonts, and images; do not include JavaScript, script elements, inline event handlers, or relative or remote assets. Existing scripts are static design reference only and must be removed from the final deliverable.',
      'Do not request credentials, upload source files, publish, deploy, or mutate any external source.',
    ].join(' ');
    const buildRunBody = (message: string) => ({
      projectId,
      conversationId,
      agentId: 'byok-opencode',
      model: model.model,
      message,
      systemPrompt,
      byokProvider: {
        protocol: 'openai',
        apiKey: agentModelPlaceholderKey,
        baseUrl: proxiedModelBaseUrl,
        model: model.model,
        requiresApiKey: true,
      },
    });
    onStage('open_design_run_starting', { projectId });
    const run = await this.odJson(handle, '/api/runs', {
      method: 'POST',
      body: buildRunBody(instruction.trim()),
      signal: this.signalForDeadline(executionDeadline, signal),
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
      let finalRunId = runId;
      let runOutcome = await this.waitForRun(handle, runId, executionDeadline, signal, onStage);
      if (Date.now() >= executionDeadline) {
        throw new AgentWorkspaceRuntimeError('open_design_run_timeout', 'OpenDesign run exceeded the session timeout', true);
      }
      const review = await this.odJson(handle, '/api/runs', {
        method: 'POST',
        body: buildRunBody([
          'Perform a strict final review of /workspace/index.html against every constraint and the qualityContract in /workspace/brief/task.json.',
          'Do not merely describe the result. Inspect all visible labels, navigation, buttons, headings, statistics, role paths, placeholders, and factual claims. Correct every proven mismatch in the file before stopping.',
          editingExistingPage
            ? 'Use only the smallest targeted edit operations needed. Never use broad or global string replacement. Never alter CSS values, existing facts, links, section order, or product identity unless task.json explicitly requests that exact change. If a possible change is not directly required or you are uncertain, keep the existing content unchanged.'
            : 'For this newly generated page, remove or replace every unsupported element. Do not retain sample copy, fake actions, missing targets, invented measured claims, or incomplete sections merely to preserve the first draft.',
          'Reread the finished index.html and only stop when every requested constraint is visibly present and every forbidden placeholder, inert control, broken fragment, or unsupported claim is absent.',
        ].join(' ')),
        signal: this.signalForDeadline(executionDeadline, signal),
        acceptedStatuses: [200, 202],
      });
      finalRunId = typeof review.runId === 'string'
        ? review.runId
        : typeof review.id === 'string'
          ? review.id
          : '';
      if (!finalRunId) {
        throw new AgentWorkspaceRuntimeError('open_design_contract_mismatch', 'OpenDesign review run returned no run id');
      }
      handle.activeRunId = finalRunId;
      onStage('open_design_reviewing', { runId: finalRunId });
      runOutcome = await this.waitForRun(handle, finalRunId, executionDeadline, signal, onStage);
      let collectedFiles: WorkspacePackageFile[] = [];
      let indexFile: WorkspacePackageFile | undefined;
      let hardenedHtml = '';
      for (let qualityRepairAttempt = 0; ; qualityRepairAttempt += 1) {
        onStage('workspace_collecting');
        await this.copyOutputsFromContainer(handle);
        collectedFiles = this.collectOutputs(handle);
        indexFile = collectedFiles.find((file) => file.path === 'index.html');
        if (!indexFile) {
          throw new AgentWorkspaceRuntimeError('design_output_missing', 'OpenDesign completed without index.html');
        }
        const outputHtml = Buffer.from(indexFile.contentBase64, 'base64');
        const currentHtml = fs.existsSync(currentIndexPath) ? fs.readFileSync(currentIndexPath) : undefined;
        if (
          !runOutcome.deliverableValid
          && !canAcceptUntrackedWorkspaceEdit(runOutcome.deliverableValidation, currentHtml, outputHtml)
        ) {
          throw new AgentWorkspaceRuntimeError(
            'open_design_deliverable_invalid',
            runOutcome.deliverableValidation || 'OpenDesign rejected its final deliverable',
          );
        }
        const qualityEvidence = collectArtifactQualityEvidence(handle.workspaceDir);
        try {
          hardenedHtml = hardenSelfContainedHtml(outputHtml.toString('utf8'), qualityEvidence);
          break;
        } catch (error) {
          if (
            !(error instanceof AgentWorkspaceRuntimeError)
            || error.code !== 'design_output_quality_rejected'
            || qualityRepairAttempt >= MAX_QUALITY_REPAIR_ATTEMPTS
          ) {
            throw error;
          }
          if (Date.now() >= executionDeadline) {
            throw new AgentWorkspaceRuntimeError('open_design_run_timeout', 'OpenDesign run exceeded the session timeout', true);
          }
          const repairReason = classifyQualityRepairReason(error.message);
          if (!repairReason) throw error;
          const repair = await this.odJson(handle, '/api/runs', {
            method: 'POST',
            body: buildRunBody([
              'The deterministic CDS publication gate rejected /workspace/index.html after your final review.',
              `The controlled rejection reason is ${repairReason.code}: ${repairReason.instruction}`,
              'Fix exactly this proven quality violation in /workspace/index.html. Inspect the whole file and remove every occurrence of the same violation while preserving supported facts, valid structure, visual quality, and all other task constraints.',
              'Do not merely explain the change. Save the corrected file, reread it, and stop only after the violation is absent.',
            ].join(' ')),
            signal: this.signalForDeadline(executionDeadline, signal),
            acceptedStatuses: [200, 202],
          });
          finalRunId = typeof repair.runId === 'string'
            ? repair.runId
            : typeof repair.id === 'string'
              ? repair.id
              : '';
          if (!finalRunId) {
            throw new AgentWorkspaceRuntimeError('open_design_contract_mismatch', 'OpenDesign quality repair run returned no run id');
          }
          handle.activeRunId = finalRunId;
          onStage('open_design_quality_repairing', {
            runId: finalRunId,
            attempt: qualityRepairAttempt + 1,
          });
          runOutcome = await this.waitForRun(handle, finalRunId, executionDeadline, signal, onStage);
        }
      }
      const hardenedBytes = Buffer.from(hardenedHtml);
      indexFile!.contentBase64 = hardenedBytes.toString('base64');
      indexFile!.sha256 = sha256(hardenedBytes);
      indexFile!.size = hardenedBytes.byteLength;
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
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(Math.min(handle.policy.timeoutSeconds * 1000, 60_000))])
          : AbortSignal.timeout(Math.min(handle.policy.timeoutSeconds * 1000, 60_000)),
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
        openDesignRunId: finalRunId,
      };
    } finally {
      handle.activeRunId = undefined;
    }
    } finally {
      if (this.handles.get(sessionId)?.kind === 'active') {
        await this.stopEgressProxy(handle);
      }
    }
  }

  async stop(sessionId: string, reason = 'requested'): Promise<void> {
    return this.runManagedCleanup(sessionId, reason, false);
  }

  private async runManagedCleanup(
    sessionId: string,
    reason: string,
    notifyOnSuccess: boolean,
  ): Promise<void> {
    const pendingTimer = this.cleanupRetryTimers.get(sessionId);
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      this.cleanupRetryTimers.delete(sessionId);
    }
    const handle = this.handles.get(sessionId);
    const onCleanupSettled = handle?.onCleanupSettled;
    let cleanup = this.cleanupInFlight.get(sessionId);
    if (!cleanup) {
      cleanup = this.stopOnce(sessionId, reason).finally(() => {
        if (this.cleanupInFlight.get(sessionId) === cleanup) {
          this.cleanupInFlight.delete(sessionId);
        }
      });
      this.cleanupInFlight.set(sessionId, cleanup);
    }
    try {
      await cleanup;
      this.cleanupRetryAttempts.delete(sessionId);
      if (notifyOnSuccess && !this.handles.has(sessionId)) onCleanupSettled?.();
    } catch (error) {
      if (this.handles.has(sessionId)) this.scheduleCleanupRetry(sessionId);
      throw error;
    }
  }

  private scheduleCleanupRetry(sessionId: string): void {
    if (!this.handles.has(sessionId) || this.cleanupRetryTimers.has(sessionId)) return;
    const attempt = (this.cleanupRetryAttempts.get(sessionId) || 0) + 1;
    this.cleanupRetryAttempts.set(sessionId, attempt);
    const exponent = Math.min(attempt - 1, 20);
    const retryMs = Math.min(this.cleanupRetryMaxMs, this.cleanupRetryBaseMs * (2 ** exponent));
    const timer = setTimeout(() => {
      this.cleanupRetryTimers.delete(sessionId);
      void this.runManagedCleanup(sessionId, 'cleanup_janitor_retry', true).catch(() => undefined);
    }, retryMs);
    timer.unref();
    this.cleanupRetryTimers.set(sessionId, timer);
  }

  private async stopOnce(sessionId: string, _reason: string): Promise<void> {
    const handle = this.handles.get(sessionId);
    if (!handle) return;
    if (handle.kind === 'partial-cleanup') {
      const cleanupErrors: string[] = [];
      for (const containerName of [...handle.containerNames]) {
        await this.removeContainer(containerName)
          .then(() => {
            handle.containerNames = handle.containerNames.filter((candidate) => candidate !== containerName);
          })
          .catch((error) => cleanupErrors.push(error instanceof Error ? error.message : String(error)));
      }
      if (handle.networkName) {
        await this.removeNetwork(handle.networkName)
          .then(() => { handle.networkName = undefined; })
          .catch((error) => cleanupErrors.push(error instanceof Error ? error.message : String(error)));
      }
      for (const volumeName of [...handle.volumeNames]) {
        await this.removeVolume(volumeName)
          .then(() => {
            handle.volumeNames = handle.volumeNames.filter((candidate) => candidate !== volumeName);
          })
          .catch((error) => cleanupErrors.push(error instanceof Error ? error.message : String(error)));
      }
      if (handle.hostRoot) {
        try {
          fs.rmSync(handle.hostRoot, { recursive: true, force: true });
          handle.hostRoot = undefined;
        } catch (error) {
          cleanupErrors.push(error instanceof Error ? error.message : String(error));
        }
      }
      this.removeInstanceRootIfEmpty();
      if (cleanupErrors.length > 0) {
        throw new AgentWorkspaceRuntimeError(
          'workspace_cleanup_failed',
          'OpenDesign session resources could not be fully cleaned',
          true,
          { cleanupErrors },
        );
      }
      this.handles.delete(sessionId);
      return;
    }
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
    handle.egressClientToken = '';
    const cleanupErrors: string[] = [];
    if (handle.egressContainerName) {
      await this.removeContainer(handle.egressContainerName)
        .then(() => { handle.egressContainerName = undefined; })
        .catch((error) => {
          cleanupErrors.push(error instanceof Error ? error.message : String(error));
        });
    }
    await this.removeContainer(handle.containerName).catch((error) => {
      cleanupErrors.push(error instanceof Error ? error.message : String(error));
    });
    await this.removeNetwork(handle.networkName).catch((error) => {
      cleanupErrors.push(error instanceof Error ? error.message : String(error));
    });
    for (const volumeName of [handle.workspaceVolumeName, handle.dataVolumeName]) {
      await this.removeVolume(volumeName).catch((error) => {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      });
    }
    try { fs.rmSync(handle.hostRoot, { recursive: true, force: true }); } catch (error) {
      cleanupErrors.push(error instanceof Error ? error.message : String(error));
    }
    this.removeInstanceRootIfEmpty();
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
    const parsed = new URL(normalizeAgentWorkspaceModelBaseUrl(model.baseUrl));
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

  private removeInstanceRootIfEmpty(): void {
    try {
      if (fs.existsSync(this.instanceRootDir) && fs.readdirSync(this.instanceRootDir).length === 0) {
        fs.rmdirSync(this.instanceRootDir);
      }
    } catch {
      // Best effort only; session-owned children have already been removed.
    }
  }

  private async startEgressProxy(
    handle: RuntimeHandle,
    modelBaseUrl: string,
    mapModelTicket: string,
    relayClientToken: string,
  ): Promise<string> {
    await this.stopEgressProxy(handle);
    if (!mapModelTicket || /[\0\r\n]/.test(mapModelTicket) || !relayClientToken || /[\0\r\n]/.test(relayClientToken)) {
      throw new AgentWorkspaceRuntimeError(
        'model_authority_invalid',
        'MAP model ticket is missing or malformed',
      );
    }
    const target = validateTransferUrl(modelBaseUrl, 'modelBaseUrl');
    const suffix = sha256(`${handle.sessionId}:${target.origin}:${target.pathname}`).slice(0, 16);
    const containerName = `cds-od-egress-${suffix}`;
    const env = [
      `TARGET_ORIGIN=${target.origin}`,
      `TARGET_PATH_PREFIX=${target.pathname}`,
      `PROXY_PORT=${EGRESS_PROXY_PORT}`,
      `MAP_MODEL_TICKET=${mapModelTicket}`,
      `RELAY_CLIENT_TOKEN=${relayClientToken}`,
      `CDS_EGRESS_PROXY_SCRIPT=${Buffer.from(EGRESS_PROXY_SCRIPT).toString('base64')}`,
    ].join('\n') + '\n';
    const envFilePath = path.join(handle.hostRoot, `.docker-env-${crypto.randomBytes(8).toString('hex')}`);
    fs.writeFileSync(envFilePath, env, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    const command = [
      'docker run --detach',
      '--pull never',
      `--name ${shellQuote(containerName)}`,
      '--restart no',
      '--read-only',
      '--network bridge',
      '--security-opt no-new-privileges:true',
      '--cap-drop ALL',
      '--pids-limit 64',
      '--memory 128m',
      '--cpus 0.25',
      '--tmpfs /tmp:rw,noexec,nosuid,size=16m,nr_inodes=256',
      `--label ${shellQuote('cds.managed=true')}`,
      `--label ${shellQuote('cds.type=agent-session')}`,
      `--label ${shellQuote(`cds.instance=${this.instanceId}`)}`,
      `--label ${shellQuote(`cds.agent.session=${handle.sessionId}`)}`,
      `--env-file ${shellQuote(envFilePath)}`,
      '--entrypoint node',
      shellQuote(this.image),
      '-e',
      shellQuote("eval(Buffer.from(process.env.CDS_EGRESS_PROXY_SCRIPT, 'base64').toString('utf8'))"),
    ].join(' ');
    // A Docker CLI timeout or non-zero exit does not prove that the daemon did
    // not create the named container. Register the cleanup target before the
    // command so every failure path removes it or retains a retry descriptor.
    handle.egressContainerName = containerName;
    let started: ExecResult | undefined;
    let startFailed = false;
    try {
      started = await this.shell.exec(command, { timeout: 30_000 });
      startFailed = started.exitCode !== 0;
    } catch {
      startFailed = true;
    } finally {
      fs.rmSync(envFilePath, { force: true });
    }
    if (startFailed || !started) {
      await this.failEgressAndCleanup(
        handle,
        'MAP-only egress relay could not be started; OpenDesign remains network-isolated',
      );
    }
    const connected = await this.shell.exec(
      `docker network connect --alias map-egress ${shellQuote(handle.networkName)} ${shellQuote(containerName)}`,
      { timeout: 30_000 },
    );
    if (connected.exitCode !== 0) {
      await this.failEgressAndCleanup(
        handle,
        'MAP-only egress relay could not join the isolated Agent network',
      );
    }
    let ready = false;
    const readyDeadline = Date.now() + 15_000;
    while (Date.now() < readyDeadline) {
      const probe = await this.shell.exec(
        `docker exec ${shellQuote(containerName)} node -e ${shellQuote(`fetch('http://127.0.0.1:${EGRESS_PROXY_PORT}/__health').then(r=>process.exit(r.status===204?0:1)).catch(()=>process.exit(1))`)}`,
        { timeout: 3000 },
      );
      if (probe.exitCode === 0) {
        ready = true;
        break;
      }
      await delay(Math.min(this.pollIntervalMs, 250));
    }
    if (!ready) {
      await this.failEgressAndCleanup(
        handle,
        'MAP-only egress relay did not become ready; OpenDesign remains network-isolated',
      );
    }
    const basePath = target.pathname === '/' ? '' : target.pathname.replace(/\/$/, '');
    return `http://map-egress:${EGRESS_PROXY_PORT}${basePath}`;
  }

  private async failEgressAndCleanup(handle: RuntimeHandle, message: string): Promise<never> {
    try {
      await this.stopEgressProxy(handle);
    } catch (cleanupError) {
      this.retainActiveHandleForPartialCleanup(handle);
      throw new AgentWorkspaceRuntimeError(
        'workspace_cleanup_failed',
        'MAP-only egress relay failed and allocated session resources could not be fully cleaned',
        true,
        {
          cleanupErrors: [cleanupError instanceof Error ? cleanupError.message : String(cleanupError)],
        },
      );
    }
    throw new AgentWorkspaceRuntimeError('workspace_egress_unavailable', message, true);
  }

  private retainActiveHandleForPartialCleanup(handle: RuntimeHandle): void {
    clearTimeout(handle.ttlTimer);
    handle.activeRunId = undefined;
    handle.daemonApiToken = '';
    handle.egressClientToken = '';
    this.handles.set(handle.sessionId, {
      kind: 'partial-cleanup',
      sessionId: handle.sessionId,
      hostRoot: handle.hostRoot,
      containerNames: [...new Set([
        ...(handle.egressContainerName ? [handle.egressContainerName] : []),
        handle.containerName,
      ])],
      networkName: handle.networkName,
      volumeNames: [handle.workspaceVolumeName, handle.dataVolumeName],
      onCleanupSettled: handle.onCleanupSettled,
    });
    this.scheduleCleanupRetry(handle.sessionId);
  }

  private async stopEgressProxy(handle: RuntimeHandle): Promise<void> {
    if (!handle.egressContainerName) return;
    const containerName = handle.egressContainerName;
    await this.removeContainer(containerName);
    handle.egressContainerName = undefined;
  }

  private async copyOutputsFromContainer(handle: RuntimeHandle): Promise<void> {
    await this.validateOutputsInContainer(handle);
    fs.rmSync(handle.outputDir, { recursive: true, force: true });
    fs.mkdirSync(handle.outputDir, { recursive: true, mode: 0o700 });
    const copied = await this.shell.exec(
      `docker cp ${shellQuote(`${handle.containerName}:/workspace/.`)} ${shellQuote(handle.outputDir)}`,
      { timeout: 90_000 },
    );
    if (copied.exitCode !== 0) {
      throw new AgentWorkspaceRuntimeError(
        'workspace_copy_failed',
        'OpenDesign output could not be copied out of the managed workspace volume',
        true,
      );
    }
  }

  private async validateOutputsInContainer(handle: RuntimeHandle): Promise<void> {
    const config = Buffer.from(JSON.stringify({
      allowedOutputPaths: handle.transfer.allowedOutputPaths,
      inputPaths: handle.inputPaths,
      ignoredRuntimePaths: [...IGNORED_RUNTIME_OUTPUT_PATHS],
      maxFileCount: MAX_OUTPUT_FILE_COUNT,
      maxWorkspaceFileCount: MAX_WORKSPACE_FILE_COUNT,
      maxNodeCount: MAX_WORKSPACE_NODE_COUNT,
      maxDirectoryDepth: MAX_WORKSPACE_DIRECTORY_DEPTH,
      maxOutputBytes: handle.transfer.maxOutputBytes,
    })).toString('base64');
    const validation = await this.shell.exec([
      'docker exec',
      `--env ${shellQuote('CDS_OUTPUT_PREFLIGHT=1')}`,
      `--env ${shellQuote(`CDS_OUTPUT_PREFLIGHT_CONFIG=${config}`)}`,
      shellQuote(handle.containerName),
      'node -e',
      shellQuote(OUTPUT_PREFLIGHT_SCRIPT),
    ].join(' '), { timeout: 30_000 });
    if (validation.exitCode === 0) return;
    const diagnostic = `${validation.stdout}\n${validation.stderr}`;
    if (diagnostic.includes('CDS_OUTPUT_PREFLIGHT:total_bytes')) {
      throw new AgentWorkspaceRuntimeError('design_output_too_large', 'OpenDesign output exceeds maxOutputBytes');
    }
    if (diagnostic.includes('CDS_OUTPUT_PREFLIGHT:file_count')) {
      throw new AgentWorkspaceRuntimeError(
        'design_output_too_many_files',
        `OpenDesign output exceeds the ${MAX_OUTPUT_FILE_COUNT}-file limit`,
      );
    }
    if (
      diagnostic.includes('CDS_OUTPUT_PREFLIGHT:workspace_file_count')
      || diagnostic.includes('CDS_OUTPUT_PREFLIGHT:node_count')
    ) {
      throw new AgentWorkspaceRuntimeError(
        'design_output_too_many_files',
        'OpenDesign workspace exceeds the bounded file or node limit',
      );
    }
    if (diagnostic.includes('CDS_OUTPUT_PREFLIGHT:directory_depth')) {
      throw new AgentWorkspaceRuntimeError(
        'design_output_invalid',
        `OpenDesign workspace exceeds the ${MAX_WORKSPACE_DIRECTORY_DEPTH}-level directory depth limit`,
      );
    }
    if (diagnostic.includes('CDS_OUTPUT_PREFLIGHT:special_file')) {
      throw new AgentWorkspaceRuntimeError(
        'design_output_invalid',
        'OpenDesign output contains a special file or symbolic link',
        false,
        outputPreflightRejectedPath(diagnostic, 'special_file'),
      );
    }
    if (diagnostic.includes('CDS_OUTPUT_PREFLIGHT:path_not_allowed')) {
      throw new AgentWorkspaceRuntimeError(
        'design_output_invalid',
        'OpenDesign output contains a path outside the transfer allowlist',
        false,
        outputPreflightRejectedPath(diagnostic, 'path_not_allowed'),
      );
    }
    throw new AgentWorkspaceRuntimeError(
      'workspace_output_validation_failed',
      'OpenDesign output could not be validated inside the managed workspace before transfer',
      true,
    );
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
    deadline: number,
    signal: AbortSignal | undefined,
    onStage: StageReporter,
  ): Promise<OpenDesignRunOutcome> {
    const startedAt = Date.now();
    let lastStatus = '';
    let lastProgressAt = 0;
    while (Date.now() < deadline) {
      if (signal?.aborted) {
        await this.cancelRun(handle, runId);
        throw new AgentWorkspaceRuntimeError('open_design_run_cancelled', 'OpenDesign run was cancelled');
      }
      const deadlineSignal = this.signalForDeadline(deadline, signal);
      let status: Record<string, unknown>;
      try {
        status = await this.odJson(handle, `/api/runs/${encodeURIComponent(runId)}`, {
          method: 'GET',
          signal: deadlineSignal,
        });
      } catch (error) {
        if (signal?.aborted) {
          await this.cancelRun(handle, runId);
          throw new AgentWorkspaceRuntimeError('open_design_run_cancelled', 'OpenDesign run was cancelled');
        }
        if (deadlineSignal.aborted || Date.now() >= deadline) {
          await this.cancelRun(handle, runId);
          throw new AgentWorkspaceRuntimeError('open_design_run_timeout', 'OpenDesign run exceeded the session timeout', true);
        }
        throw error;
      }
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
        return {
          deliverableValid: status.deliverableValid !== false,
          deliverableValidation: typeof status.deliverableValidation === 'string'
            ? status.deliverableValidation
            : undefined,
        };
      }
      if (value === 'failed' || value === 'canceled') {
        throw new AgentWorkspaceRuntimeError(
          value === 'failed' ? 'open_design_run_failed' : 'open_design_run_cancelled',
          typeof status.error === 'string' ? status.error : `OpenDesign run ended with status ${value}`,
        );
      }
      await delay(this.pollIntervalMs, undefined, { signal: deadlineSignal }).catch((error) => {
        if (deadlineSignal.aborted) return;
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
        const relative = path.relative(handle.outputDir, absolute).split(path.sep).join('/');
        normalizeRelativePath(relative);
        const stat = fs.lstatSync(absolute);
        if (stat.isSymbolicLink()) {
          throw new AgentWorkspaceRuntimeError('design_output_invalid', `symbolic links are not allowed: ${relative}`);
        }
        if (stat.isDirectory()) {
          walk(absolute);
          continue;
        }
        if (!stat.isFile()) {
          throw new AgentWorkspaceRuntimeError('design_output_invalid', `special files are not allowed: ${relative}`);
        }
        if (
          relative === 'manifest.json'
          || !isAllowedOutput(relative, handle.transfer.allowedOutputPaths)
        ) continue;
        if (results.length >= MAX_OUTPUT_FILE_COUNT - 1) {
          throw new AgentWorkspaceRuntimeError(
            'design_output_too_many_files',
            `OpenDesign output exceeds the ${MAX_OUTPUT_FILE_COUNT}-file limit`,
          );
        }
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
    walk(handle.outputDir);
    return results.sort((left, right) => left.path.localeCompare(right.path));
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

  private signalForDeadline(deadline: number, signal?: AbortSignal): AbortSignal {
    const deadlineSignal = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
    return signal ? AbortSignal.any([signal, deadlineSignal]) : deadlineSignal;
  }

  private async cancelRun(handle: RuntimeHandle, runId: string): Promise<void> {
    await this.odJson(handle, `/api/runs/${encodeURIComponent(runId)}/cancel`, {
      method: 'POST',
      body: {},
      signal: AbortSignal.timeout(3_000),
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

  private async removeVolume(volumeName: string): Promise<void> {
    const result = await this.shell.exec(`docker volume rm ${shellQuote(volumeName)}`, { timeout: 30_000 });
    if (result.exitCode !== 0 && !/No such volume/i.test(`${result.stderr}\n${result.stdout}`)) {
      throw new AgentWorkspaceRuntimeError(
        'workspace_volume_cleanup_failed',
        'OpenDesign session volume could not be removed',
        true,
      );
    }
  }
}

export function canAcceptUntrackedWorkspaceEdit(
  deliverableValidation: string | undefined,
  currentHtml: Buffer | undefined,
  outputHtml: Buffer,
): boolean {
  return deliverableValidation === 'no_artifact'
    && currentHtml !== undefined
    && currentHtml.length > 0
    && !currentHtml.equals(outputHtml);
}

function classifyQualityRepairReason(message: string): { code: string; instruction: string } | undefined {
  if (message === 'index.html contains visible placeholder or unfinished content') {
    return {
      code: 'visible_placeholder',
      instruction: 'Remove every visible placeholder or unfinished-content marker.',
    };
  }
  if (message === 'index.html contains a link without a target') {
    return {
      code: 'link_without_target',
      instruction: 'Remove or convert every visible link that has no target.',
    };
  }
  if (message === 'index.html contains an empty link target') {
    return {
      code: 'empty_link_target',
      instruction: 'Remove or correct every link with an empty target.',
    };
  }
  if (message === 'index.html contains a malformed fragment target') {
    return {
      code: 'malformed_fragment_target',
      instruction: 'Remove or correct every malformed in-page fragment link.',
    };
  }
  if (message.startsWith('index.html contains a missing fragment target:')) {
    return {
      code: 'missing_fragment_target',
      instruction: 'Remove or correct every in-page link whose fragment does not match an existing element id.',
    };
  }
  if (message === 'index.html contains an enabled button without provable declarative behavior') {
    return {
      code: 'inert_enabled_button',
      instruction: 'Remove, disable, or give provable declarative behavior to every enabled button.',
    };
  }
  if (message.startsWith('index.html contains an unsupported measured claim:')) {
    return {
      code: 'unsupported_measured_claim',
      instruction: 'Remove every measured claim that is not supported by the MAP knowledge sources.',
    };
  }
  if (message.startsWith('index.html contains an unsupported date, contact, or URL:')) {
    return {
      code: 'unsupported_fact',
      instruction: 'Remove every date, contact detail, or URL that is not supported by the MAP knowledge sources.',
    };
  }
  return undefined;
}

export function hardenSelfContainedHtml(html: string, evidenceText = ''): string {
  if (!DOCUMENT_ROOT_RE.test(html)) {
    throw new AgentWorkspaceRuntimeError(
      'design_output_invalid',
      'index.html must contain an explicit html root element so the security policy can be injected',
    );
  }
  html = convertRelativeKnowledgeAnchors(html);
  for (const tag of scanHtmlTags(html).filter((item) => !item.isClosing)) {
    const name = tag.name.toLowerCase();
    const attributes = parseHtmlAttributes(tag.attributes);
    for (const attribute of ['src', 'href']) {
      const rawValue = attributes.get(attribute);
      if (rawValue === undefined) continue;
      const value = decodeHtmlText(rawValue ?? '').trim();
      if (!value || value.startsWith('#')) continue;
      if (value.startsWith('data:') && name !== 'a' && name !== 'area') continue;
      throw new AgentWorkspaceRuntimeError(
        'design_output_not_self_contained',
        `index.html references a non-inline resource from <${name}>`,
      );
    }
    if (
      [...attributes.keys()].some((attribute) => (
        ['srcset', 'srcdoc', 'background', 'poster', 'ping', 'formaction'].includes(attribute)
        || attribute.startsWith('on')
      ))
      || /^(?:applet|base|iframe|frame|object|embed|form)$/i.test(name)
      || (name === 'meta' && attributes.has('http-equiv'))
    ) {
      throw new AgentWorkspaceRuntimeError(
        'design_output_not_self_contained',
        'index.html contains an embedded navigation or document primitive',
      );
    }
  }
  if (/@import\s+(?:url\s*\()?/i.test(html)) {
    throw new AgentWorkspaceRuntimeError(
      'design_output_not_self_contained',
      'index.html CSS contains a disallowed @import',
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
  if (scanHtmlTags(html).some((tag) => !tag.isClosing && tag.name.toLowerCase() === 'script')) {
    throw new AgentWorkspaceRuntimeError(
      'design_output_not_self_contained',
      'index.html contains executable script; the OpenDesign MVP accepts declarative HTML and CSS only',
    );
  }
  validateArtifactQuality(html, evidenceText);

  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}">`;
  const root = html.match(DOCUMENT_ROOT_RE);
  const head = html.slice(root![0].length).match(DOCUMENT_HEAD_RE);
  if (head) {
    const insertionIndex = root![0].length + head[0].length;
    return `${html.slice(0, insertionIndex)}${cspMeta}${html.slice(insertionIndex)}`;
  }
  return html.replace(DOCUMENT_ROOT_RE, (documentRoot) => `${documentRoot}<head>${cspMeta}</head>`);
}

function extractVisibleHtmlText(html: string): string {
  const markup = html.replace(
    /<!--[\s\S]*?-->|<head\b[^>]*>[\s\S]*?<\/head\s*>|<style\b[^>]*>[\s\S]*?<\/style\s*>|<script\b[^>]*>[\s\S]*?<\/script\s*>|<template\b[^>]*>[\s\S]*?<\/template\s*>|<noscript\b[^>]*>[\s\S]*?<\/noscript\s*>/gi,
    ' ',
  );
  return decodeHtmlText(extractVisibleTextFromMarkup(markup))
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeHtmlText(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_match, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&(?:nbsp|#160);/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function readHtmlAttribute(attributes: string, name: string): string | undefined {
  const value = parseHtmlAttributes(attributes).get(name.toLowerCase());
  return value === undefined ? undefined : decodeHtmlText(value ?? '');
}

function hasHtmlAttribute(attributes: string, name: string): boolean {
  return parseHtmlAttributes(attributes).has(name.toLowerCase());
}

interface HtmlTagToken {
  name: string;
  attributes: string;
  start: number;
  end: number;
  isClosing: boolean;
  isSelfClosing: boolean;
}

function scanHtmlTags(html: string): HtmlTagToken[] {
  const tags: HtmlTagToken[] = [];
  for (let index = 0; index < html.length; index += 1) {
    if (html[index] !== '<' || index + 1 >= html.length) continue;
    let cursor = index + 1;
    const isClosing = html[cursor] === '/';
    if (isClosing) cursor += 1;
    if (!/[A-Za-z]/.test(html[cursor] ?? '')) continue;
    const nameStart = cursor;
    while (cursor < html.length && /[A-Za-z0-9:-]/.test(html[cursor])) cursor += 1;
    const name = html.slice(nameStart, cursor);
    const attributesStart = cursor;
    let quote: string | undefined;
    while (cursor < html.length) {
      const current = html[cursor];
      if (quote) {
        if (current === quote) quote = undefined;
      } else if (current === '"' || current === "'") {
        quote = current;
      } else if (current === '>') {
        const attributes = html.slice(attributesStart, cursor);
        tags.push({
          name,
          attributes,
          start: index,
          end: cursor + 1,
          isClosing,
          isSelfClosing: attributes.trimEnd().endsWith('/'),
        });
        index = cursor;
        break;
      }
      cursor += 1;
    }
  }
  return tags;
}

function extractVisibleTextFromMarkup(html: string): string {
  const stack: Array<{ name: string; suppressed: boolean }> = [];
  let suppressedDepth = 0;
  let cursor = 0;
  let result = '';
  for (const tag of scanHtmlTags(html)) {
    if (tag.start > cursor && suppressedDepth === 0) result += html.slice(cursor, tag.start);
    const block = /^(?:address|article|aside|blockquote|dd|div|dl|dt|figcaption|figure|footer|h[1-6]|header|li|main|nav|ol|p|section|table|tbody|td|tfoot|th|thead|tr|ul)$/i.test(tag.name);
    if (tag.isClosing) {
      for (let index = stack.length - 1; index >= 0; index -= 1) {
        const frame = stack[index];
        stack.splice(index, 1);
        if (frame.suppressed) suppressedDepth -= 1;
        if (frame.name.toLowerCase() === tag.name.toLowerCase()) break;
      }
      if (block && suppressedDepth === 0) result += '。';
    } else {
      if (block && suppressedDepth === 0) result += '。';
      const style = readHtmlAttribute(tag.attributes, 'style') ?? '';
      const suppressed = hasHtmlAttribute(tag.attributes, 'hidden')
        || readHtmlAttribute(tag.attributes, 'aria-hidden')?.trim().toLowerCase() === 'true'
        || /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\s*(?:!important\s*)?(?:;|$)/i.test(style);
      const voidElement = /^(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/i.test(tag.name);
      if (!tag.isSelfClosing && !voidElement) {
        stack.push({ name: tag.name, suppressed });
        if (suppressed) suppressedDepth += 1;
      }
    }
    cursor = tag.end;
  }
  if (cursor < html.length && suppressedDepth === 0) result += html.slice(cursor);
  return result;
}

function parseHtmlAttributes(attributes: string): Map<string, string | undefined> {
  const parsed = new Map<string, string | undefined>();
  let index = 0;
  while (index < attributes.length) {
    while (index < attributes.length && (/\s/.test(attributes[index]) || attributes[index] === '/')) index += 1;
    const nameStart = index;
    while (index < attributes.length && !/[\s=>]/.test(attributes[index])) index += 1;
    if (index === nameStart) {
      index += 1;
      continue;
    }
    const attributeName = attributes.slice(nameStart, index).toLowerCase();
    while (index < attributes.length && /\s/.test(attributes[index])) index += 1;
    let value: string | undefined;
    if (attributes[index] === '=') {
      index += 1;
      while (index < attributes.length && /\s/.test(attributes[index])) index += 1;
      const quote = attributes[index] === '"' || attributes[index] === "'" ? attributes[index] : undefined;
      if (quote) {
        index += 1;
        const valueStart = index;
        while (index < attributes.length && attributes[index] !== quote) index += 1;
        value = attributes.slice(valueStart, index);
        if (index < attributes.length) index += 1;
      } else {
        const valueStart = index;
        while (index < attributes.length && !/[\s>]/.test(attributes[index])) index += 1;
        value = attributes.slice(valueStart, index);
      }
    }
    if (!parsed.has(attributeName)) parsed.set(attributeName, value);
  }
  return parsed;
}

interface MeasuredClaimContext {
  token: string;
  context: string;
  requiresContext: boolean;
  isStructural: boolean;
  entityKeys: Set<string>;
}

function measuredClaimContexts(text: string): MeasuredClaimContext[] {
  const claims: MeasuredClaimContext[] = [];
  for (const segment of text.split(/[\r\n。！？!?；;，,：:]+/)) {
    const patterns = [
      { regex: /(?<![A-Za-z0-9_])(\d+(?:[.,]\d+)*)\s*(%|％|分钟|小时|天|周|月|年|万字|元|美元|人民币|KB|MB|GB)(?![A-Za-z])/gi, numberIndex: 1, unitIndex: 2 },
      { regex: /([￥¥$])\s*(\d+(?:[.,]\d+)*)/gi, numberIndex: 2, unitIndex: 1 },
      { regex: /(?<![A-Za-z0-9_])(\d+(?:[.,]\d+)*)\s*(个|条|次|篇|字|人|位|家|项|例|份|种|类|层|步|章|节|页)(?![A-Za-z])/gi, numberIndex: 1, unitIndex: 2 },
    ];
    for (const pattern of patterns) {
      for (const match of segment.matchAll(pattern.regex)) {
        const rawNumber = match[pattern.numberIndex];
        const parsed = Number(rawNumber.replaceAll(',', ''));
        const number = Number.isFinite(parsed) ? String(parsed) : rawNumber;
        const rawUnit = match[pattern.unitIndex];
        const requiresContext = isCountUnit(rawUnit);
        const entityKeys = extractClaimEntityKeys(segment, rawUnit);
        const unit = normalizeClaimUnit(rawUnit, entityKeys);
        claims.push({
          token: `${number}|${unit}`,
          context: normalizeClaimContext(segment),
          requiresContext,
          isStructural: requiresContext && isStructuralCount(segment),
          entityKeys,
        });
      }
    }
  }
  return claims;
}

function normalizeClaimContext(value: string): string {
  return value.replace(
    /\d+(?:[.,]\d+)*|%|％|￥|¥|\$|分钟|小时|天|周|月|年|万字|元|美元|人民币|KB|MB|GB|个|条|次|篇|字|人|位|家|项|例|份|种|类|层|步|章|节|页|大约|约|只需|总共|预计|可达|达到|需要|耗时|时长|total|approximately|about|around/gi,
    '',
  );
}

function claimContextTokens(value: string): Set<string> {
  const tokens = new Set<string>();
  for (const word of value.matchAll(/[A-Za-z][A-Za-z0-9_-]{2,}/g)) tokens.add(word[0].toLowerCase());
  const chinese = [...value].filter((character) => /[\u4e00-\u9fff]/.test(character)).join('');
  for (let index = 0; index + 1 < chinese.length; index += 1) tokens.add(chinese.slice(index, index + 2));
  return tokens;
}

function hasClaimContextOverlap(
  left: string,
  right: string,
  requiresContext: boolean,
  leftEntities: Set<string>,
  rightEntities: Set<string>,
): boolean {
  if (!requiresContext) return true;
  const comparableLeftEntities = new Set([...leftEntities].filter((key) => key !== 'PERSON'));
  const comparableRightEntities = new Set([...rightEntities].filter((key) => key !== 'PERSON'));
  if (requiresContext && comparableLeftEntities.size > 0 && comparableRightEntities.size > 0) {
    return [...comparableRightEntities].some((key) => comparableLeftEntities.has(key));
  }
  const leftTokens = claimContextTokens(left);
  if (leftTokens.size === 0) return !requiresContext;
  const rightTokens = claimContextTokens(right);
  if (rightTokens.size === 0) return false;
  const overlap = [...rightTokens].filter((token) => leftTokens.has(token)).length;
  return Math.min(leftTokens.size, rightTokens.size) <= 1 ? overlap === 1 : overlap >= 2;
}

function normalizeClaimUnit(value: string, entityKeys: Set<string>): string {
  if (value === '％') return '%';
  if (value === '￥' || value === '¥' || value === '元' || value === '人民币') return 'CNY';
  if (value === '$' || value === '美元') return 'USD';
  if (value === '人' || value === '位' || (value === '个' && ['CUSTOMER', 'USER', 'CONSUMER', 'READER', 'EMPLOYEE'].some((key) => entityKeys.has(key)))) return 'PERSON';
  if (value === '篇' || (value === '个' && entityKeys.has('ARTICLE'))) return 'ARTICLE';
  if (value === '家' || (value === '个' && entityKeys.has('ORGANIZATION'))) return 'ORGANIZATION';
  if (value === '章' || value === '节' || (value === '个' && entityKeys.has('SECTION'))) return 'SECTION';
  if (value === '页') return 'PAGE';
  if (value === '个' && entityKeys.size === 1) return [...entityKeys][0];
  return value.toUpperCase();
}

function isCountUnit(unit: string): boolean {
  return new Set(['个', '条', '次', '篇', '字', '人', '位', '家', '项', '例', '份', '种', '类', '层', '步', '章', '节', '页']).has(unit);
}

function isStructuralCount(segment: string): boolean {
  return /(?:第\s*\d+\s*(?:步|章|节)(?:\b|。|，|,|：|:|$))|(?:(?:本文|本页|下文|以下|使用方式|操作流程|阅读路径|页面内容)[^\r\n。！？!?；;]{0,16}(?:分为|包括|包含|共有)\s*\d+(?:[.,]\d+)*\s*(?:个|条|项|种|类|层|步|章|节)?\s*(?:步骤|阶段|部分|章节|要点|原则|方式|层级|类别|模块|区块|栏目|操作)(?:\b|。|，|,|：|:|$))/i.test(segment);
}

function extractClaimEntityKeys(segment: string, unit: string): Set<string> {
  const keys = new Set<string>();
  for (const [key, pattern] of [
    ['PROJECT', /项目/],
    ['CUSTOMER', /客户/],
    ['USER', /用户/],
    ['CONSUMER', /消费者/],
    ['READER', /读者/],
    ['EMPLOYEE', /员工|成员/],
    ['CASE', /案例|样例/],
    ['ARTICLE', /文章|文档|知识|内容/],
    ['MODULE', /模块|功能/],
    ['CATEGORY', /类别|分类|种类/],
    ['OPERATION', /操作|流程|步骤/],
    ['SECTION', /章节|章|节/],
    ['COLUMN', /栏目|专栏/],
    ['ORGANIZATION', /企业|公司|机构|商家/],
  ] as const) {
    if (pattern.test(segment)) keys.add(key);
  }
  if (unit === '人' || unit === '位') keys.add('PERSON');
  if (unit === '篇') keys.add('ARTICLE');
  if (unit === '章' || unit === '节') keys.add('SECTION');
  if (unit === '家') keys.add('ORGANIZATION');
  if (unit === '页') keys.add('PAGE');
  return keys;
}

function validateArtifactQuality(html: string, evidenceText: string): void {
  const visible = extractVisibleHtmlText(html);
  if (/(?:图|图片|图示|插图|截图|内容|文案|数据|此处|位置)\s*(?:仍|仅|为|是|[:：·—-])?\s*占位|占位\s*(?:图|图片|图示|插图|截图|内容|文案|数据|[:：·—-])|待\s*(?:补充|替换|填写|完善)|\blorem\s+ipsum\b|\b(?:todo|tbd)\b/i.test(visible)) {
    throw new AgentWorkspaceRuntimeError('design_output_quality_rejected', 'index.html contains visible placeholder or unfinished content');
  }

  const targets = new Set<string>();
  const popoverTargets = new Set<string>();
  const tags = scanHtmlTags(html).filter((tag) => !tag.isClosing);
  for (const tag of tags) {
    const attributes = tag.attributes;
    const target = decodeHtmlText((readHtmlAttribute(attributes, 'id') ?? readHtmlAttribute(attributes, 'name') ?? '').trim());
    if (target) {
      targets.add(target);
      if (hasHtmlAttribute(attributes, 'popover')) popoverTargets.add(target);
    }
  }
  for (const tag of tags.filter((item) => item.name.toLowerCase() === 'a')) {
    const href = readHtmlAttribute(tag.attributes, 'href');
    if (href === undefined) {
      throw new AgentWorkspaceRuntimeError('design_output_quality_rejected', 'index.html contains a link without a target');
    }
    const normalized = href?.trim() ?? '';
    if (!normalized || normalized === '#') {
      throw new AgentWorkspaceRuntimeError('design_output_quality_rejected', 'index.html contains an empty link target');
    }
    if (normalized.startsWith('#')) {
      let fragment: string;
      try {
        fragment = decodeURIComponent(normalized.slice(1));
      } catch {
        throw new AgentWorkspaceRuntimeError('design_output_quality_rejected', 'index.html contains a malformed fragment target');
      }
      if (!fragment || !targets.has(fragment)) {
        throw new AgentWorkspaceRuntimeError('design_output_quality_rejected', `index.html contains a missing fragment target: #${fragment}`);
      }
    }
  }
  for (const tag of tags.filter((item) => item.name.toLowerCase() === 'button')) {
    const attributes = tag.attributes;
    if (hasHtmlAttribute(attributes, 'disabled')) continue;
    const popoverTarget = readHtmlAttribute(attributes, 'popovertarget')?.trim();
    if (popoverTarget && popoverTargets.has(popoverTarget)) continue;
    throw new AgentWorkspaceRuntimeError('design_output_quality_rejected', 'index.html contains an enabled button without provable declarative behavior');
  }

  const supportedClaims = measuredClaimContexts(evidenceText);
  for (const claim of measuredClaimContexts(visible)) {
    if (claim.isStructural) continue;
    const candidates = supportedClaims.filter((candidate) => candidate.token.toLowerCase() === claim.token.toLowerCase());
    if (candidates.some((candidate) => hasClaimContextOverlap(
      candidate.context,
      claim.context,
      claim.requiresContext,
      candidate.entityKeys,
      claim.entityKeys,
    ))) continue;
    const [number, unit] = claim.token.split('|');
    throw new AgentWorkspaceRuntimeError('design_output_quality_rejected', `index.html contains an unsupported measured claim: ${number}${unit}`);
  }
  const supportedFacts = sensitiveFacts(evidenceText);
  for (const fact of sensitiveFacts(visible)) {
    if (supportedFacts.has(fact)) continue;
    throw new AgentWorkspaceRuntimeError('design_output_quality_rejected', `index.html contains an unsupported date, contact, or URL: ${fact}`);
  }
}

function sensitiveFacts(text: string): Set<string> {
  const facts = new Set<string>();
  for (const match of text.matchAll(/https?:\/\/[^\s<>"']+|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|\b(?:19|20)\d{2}[-/.]\d{1,2}(?:[-/.]\d{1,2})?\b|(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d{9}(?!\d)|(?<!\d)0\d{2,3}-?\d{7,8}(?!\d)/gi)) {
    facts.add(match[0].replace(/[.,;:，。；：)\]}>`]+$/g, '').toLowerCase());
  }
  return facts;
}

function collectArtifactQualityEvidence(workspaceDir: string): string {
  const evidence: string[] = [];
  const taskPath = path.join(workspaceDir, 'brief', 'task.json');
  if (fs.existsSync(taskPath)) {
    try {
      const task = JSON.parse(fs.readFileSync(taskPath, 'utf8')) as Record<string, unknown>;
      for (const key of ['title', 'instruction']) {
        if (typeof task[key] === 'string') evidence.push(task[key] as string);
      }
    } catch {
      throw new AgentWorkspaceRuntimeError('workspace_package_invalid', 'brief/task.json is not valid JSON');
    }
  }
  const knowledgeDir = path.join(workspaceDir, 'knowledge');
  if (fs.existsSync(knowledgeDir)) {
    for (const entry of fs.readdirSync(knowledgeDir, { withFileTypes: true }).filter((item) => item.isFile())) {
      evidence.push(fs.readFileSync(path.join(knowledgeDir, entry.name), 'utf8'));
    }
  }
  const currentPath = path.join(workspaceDir, 'current', 'index.html');
  if (fs.existsSync(currentPath)) evidence.push(extractVisibleHtmlText(fs.readFileSync(currentPath, 'utf8')));
  return evidence.join('\n');
}

function convertRelativeKnowledgeAnchors(html: string): string {
  const quoted = /<a\b[^>]*\bhref\s*=\s*(["'])(\.\/[A-Za-z0-9_./-]+(?:#[A-Za-z0-9_.:-]+)?)\1[^>]*>([\s\S]*?)<\/a\s*>/gi;
  const unquoted = /<a\b[^>]*\bhref\s*=\s*(\.\/[A-Za-z0-9_./-]+(?:#[A-Za-z0-9_.:-]+)?)[^\s"'`=<>]*[^>]*>([\s\S]*?)<\/a\s*>/gi;
  const replace = (_match: string, value: string, body: string): string => {
    if (/(?:^|\/)\.\.(?:\/|$)/.test(value)) return _match;
    return `<span data-cds-source-reference="${value}">${body}</span>`;
  };
  return html
    .replace(quoted, (_match, _quote: string, value: string, body: string) => replace(_match, value, body))
    .replace(unquoted, (_match, value: string, body: string) => replace(_match, value, body));
}

function classifyImagePullFailure(stdout: string, stderr: string): string {
  const output = `${stdout}\n${stderr}`.toLowerCase();
  if (/unauthorized|denied|authentication required|credential/.test(output)) {
    return 'runtime image registry authentication failed';
  }
  if (/no matching manifest|unsupported platform|does not match the specified platform/.test(output)) {
    return 'runtime image does not support this CDS node architecture';
  }
  if (/no space left|insufficient disk|disk quota/.test(output)) {
    return 'runtime image pull failed because CDS node storage is exhausted';
  }
  if (/timeout|timed out|connection reset|temporary failure|network is unreachable|no such host/.test(output)) {
    return 'runtime image pull failed because the registry is temporarily unreachable';
  }
  return 'runtime image pull failed';
}
