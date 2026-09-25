// 测试夹具：假的 OpenDesign daemon（进程内 HTTP 服务，按 0.21.1 的接口形状应答）、假的 MAP 公共传输、
// 任务包与任务请求构造器。服务本体一律走真实代码：真实的执行器、任务槽、HTTP 层、转发口、本地文件系统。
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import { createDesignRuntime, type DesignRuntime, type DesignRuntimeOverrides } from '../src/app.js';
import type { ServiceConfig } from '../src/config.js';
import type { DaemonExit, DaemonHandle, EngineDaemon } from '../src/engine/daemon.js';
import { MAP_DESIGN_WORKSPACE_SCHEMA } from '../src/workspace/transfer.js';

export const FIXTURES = path.join(__dirname, 'fixtures');

export function digest(value: Buffer | string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

export interface FakeRunOutcome {
  status: 'succeeded' | 'failed';
  deliverableValid?: boolean;
  deliverableValidation?: string;
  deliverableEntryFile?: string;
  error?: string;
}

export interface FakeRunContext {
  body: Record<string, unknown>;
  index: number;
  workspaceDir: string;
  signal: AbortSignal;
}

/** 假 OpenDesign：只在「被启动」时监听；每次启动换一组新令牌，与真实 daemon 的生命周期一致。 */
export class FakeOpenDesign implements EngineDaemon {
  starts = 0;
  stops = 0;
  freezes = 0;
  thaws = 0;
  healthStatus = 200;
  version = '0.21.1';
  readonly runBodies: Array<Record<string, unknown>> = [];
  readonly imports: Array<Record<string, unknown>> = [];
  readonly cancels: string[] = [];
  readonly tokensSeen: string[] = [];
  onRun: (context: FakeRunContext) => Promise<FakeRunOutcome> | FakeRunOutcome = () => ({ status: 'succeeded' });
  private server: http.Server | null = null;
  private handle: DaemonHandle | null = null;
  private readonly runs = new Map<string, { outcome?: FakeRunOutcome; status: string; abort: AbortController }>();
  private readonly listeners: Array<(exit: DaemonExit) => void> = [];
  private lastExit: DaemonExit | null = null;

  constructor(private readonly workspaceDir: string) {}

  async start(): Promise<DaemonHandle> {
    await this.stop();
    const apiToken = crypto.randomBytes(16).toString('hex');
    const server = http.createServer((req, res) => {
      this.route(apiToken, req, res).catch((error) => json(res, 500, { error: { message: String(error) } }));
    });
    const baseUrl = await listen(server);
    this.server = server;
    this.handle = { baseUrl, apiToken, modelPlaceholderToken: `od-placeholder-${crypto.randomBytes(8).toString('hex')}` };
    this.tokensSeen.push(apiToken);
    this.starts += 1;
    return this.handle;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    this.handle = null;
    for (const run of this.runs.values()) run.abort.abort();
    this.runs.clear();
    this.stops += 1;
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  }

  /** 模拟引擎进程自己挂掉：关端口、清句柄，并通知监听者（不是本服务发起的停止）。 */
  async crash(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.handle = null;
    for (const run of this.runs.values()) run.abort.abort();
    this.runs.clear();
    if (server) {
      await new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    }
    const exit: DaemonExit = { code: 1, signal: null, at: new Date().toISOString(), intentional: false };
    this.lastExit = exit;
    for (const listener of this.listeners) listener(exit);
  }

  current(): DaemonHandle | null {
    return this.handle;
  }

  freeze(): void {
    this.freezes += 1;
  }

  thaw(): void {
    this.thaws += 1;
  }

  onUnexpectedExit(listener: (exit: DaemonExit) => void): void {
    this.listeners.push(listener);
  }

  describe(): { running: boolean; pid: number | null; lastExit: DaemonExit | null } {
    return { running: this.server !== null, pid: null, lastExit: this.lastExit };
  }

  private async route(apiToken: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', 'http://od.local');
    if (req.headers.authorization !== `Bearer ${apiToken}`) {
      json(res, 401, { error: { message: 'bad token' } });
      return;
    }
    if (url.pathname === '/api/health') {
      json(res, this.healthStatus, { ok: this.healthStatus === 200, version: this.version });
      return;
    }
    if (url.pathname === '/api/import/folder' && req.method === 'POST') {
      this.imports.push(JSON.parse((await readBody(req)).toString('utf8')));
      json(res, 200, { project: { id: 'od-project', skillId: 'web-prototype' }, conversationId: 'od-conversation' });
      return;
    }
    if (url.pathname === '/api/runs' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString('utf8')) as Record<string, unknown>;
      this.runBodies.push(body);
      const index = this.runBodies.length;
      const runId = `od-run-${index}`;
      const abort = new AbortController();
      const record: { outcome?: FakeRunOutcome; status: string; abort: AbortController } = { status: 'running', abort };
      this.runs.set(runId, record);
      Promise.resolve(this.onRun({ body, index, workspaceDir: this.workspaceDir, signal: abort.signal }))
        .then((outcome) => {
          if (record.status !== 'running') return;
          record.outcome = outcome;
          record.status = outcome.status;
        })
        .catch(() => { record.status = 'failed'; });
      json(res, 202, { runId });
      return;
    }
    const cancel = /^\/api\/runs\/([^/]+)\/cancel$/.exec(url.pathname);
    if (cancel && req.method === 'POST') {
      this.cancels.push(cancel[1]);
      const run = this.runs.get(cancel[1]);
      if (run) {
        run.status = 'canceled';
        run.abort.abort();
      }
      json(res, 200, {});
      return;
    }
    const events = /^\/api\/runs\/([^/]+)\/events$/.exec(url.pathname);
    if (events) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('event: agent\ndata: {"type":"text_delta","delta":"working"}\n\n');
      return;
    }
    const status = /^\/api\/runs\/([^/]+)$/.exec(url.pathname);
    if (status) {
      const run = this.runs.get(status[1]);
      if (!run) {
        json(res, 404, { error: { message: 'no such run' } });
        return;
      }
      json(res, 200, {
        status: run.status,
        ...(run.outcome?.deliverableValid !== undefined ? { deliverableValid: run.outcome.deliverableValid } : {}),
        ...(run.outcome?.deliverableValidation ? { deliverableValidation: run.outcome.deliverableValidation } : {}),
        ...(run.outcome?.deliverableEntryFile ? { deliverableEntryFile: run.outcome.deliverableEntryFile } : {}),
        ...(run.outcome?.error ? { error: run.outcome.error } : {}),
      });
      return;
    }
    json(res, 404, { error: { message: 'not found' } });
  }
}

export function buildPackage(
  files: Array<{ path: string; content: string | Buffer; mediaType: string }>,
  options: { runId?: string; baseRevision?: string; taskExtras?: Record<string, unknown> } = {},
) {
  const runId = options.runId ?? 'map-run-1';
  const baseRevision = options.baseRevision ?? 'rev-1';
  const hasCurrentPage = files.some((file) => file.path === 'current/index.html');
  const normalizedFiles = files.some((file) => file.path === 'brief/task.json')
    ? files
    : [
        {
          path: 'brief/task.json',
          content: JSON.stringify({
            schemaVersion: MAP_DESIGN_WORKSPACE_SCHEMA,
            runId,
            operation: hasCurrentPage ? 'edit' : 'generate',
            input: {
              userSupplied: { instruction: 'Build a launch page', contentHash: null, authority: 'user-supplied' },
              serverKnowledge: {
                authority: 'server-authoritative-snapshot',
                references: files.filter((file) => file.path.startsWith('knowledge/')).map((file) => ({
                  entryId: file.path,
                  storeId: null,
                  contentHash: digest(Buffer.from(file.content)),
                })),
              },
              currentHtml: hasCurrentPage
                ? {
                    authority: 'server-owned-current-artifact',
                    contentHash: digest(Buffer.from(files.find((file) => file.path === 'current/index.html')!.content)),
                  }
                : null,
            },
            inputAuthority: 'user-supplied',
            title: 'Launch page',
            baseRevision,
            responseContract: { requiredFile: 'index.html', manifestFile: 'manifest.json', writeback: 'external' },
            qualityContract: {
              schemaVersion: 'map-design-artifact-quality-v1',
              factualSources: [
                ...(files.some((file) => file.path.startsWith('knowledge/')) ? ['server-knowledge'] : []),
                ...(hasCurrentPage ? ['server-current-visible-content'] : []),
              ],
              userSuppliedInputsAreFactualProvenance: false,
              measuredClaimsRequireSource: true,
              sensitiveFactsRequireSource: true,
              contextBoundMetricsReviewRequired: true,
              visibleDraftMarkersAllowed: false,
              emptyOrMissingFragmentTargetsAllowed: false,
              inertEnabledButtonsAllowed: false,
              finalReviewRequired: true,
              visibleTextOccurrenceConstraints: [],
            },
            ...(options.taskExtras ?? {}),
          }),
          mediaType: 'application/json',
        },
        ...files,
      ];
  const body = {
    schemaVersion: MAP_DESIGN_WORKSPACE_SCHEMA,
    runId,
    baseRevision,
    files: normalizedFiles.map((file) => {
      const bytes = Buffer.from(file.content);
      return { path: file.path, contentBase64: bytes.toString('base64'), sha256: digest(bytes), size: bytes.byteLength, mediaType: file.mediaType };
    }),
  };
  const serialized = Buffer.from(JSON.stringify(body));
  return { body, serialized, sha256: digest(serialized), runId, baseRevision };
}

export type BuiltPackage = ReturnType<typeof buildPackage>;

export interface FakeMap {
  origin: string;
  commits: Array<Record<string, any>>;
  previews: Array<{ html: string; revision: number }>;
  inputRequests: number;
  /** 测试可以改：输入包响应（例如 302 重定向）。 */
  inputResponder?: (res: http.ServerResponse) => void;
  previewStatus: number;
  close(): Promise<void>;
}

export async function startFakeMap(pkg: BuiltPackage, transferToken = 'transfer-token-secret'): Promise<FakeMap> {
  const state: FakeMap = {
    origin: '',
    commits: [],
    previews: [],
    inputRequests: 0,
    previewStatus: 200,
    close: async () => undefined,
  };
  const prefix = `/api/design-artifacts/runtime/${pkg.runId}`;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://map.local');
    if (req.headers.authorization !== `Bearer ${transferToken}`) {
      json(res, 401, { message: 'bad transfer token' });
      return;
    }
    if (url.pathname === `${prefix}/workspace/input`) {
      state.inputRequests += 1;
      if (state.inputResponder) {
        state.inputResponder(res);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(pkg.serialized);
      return;
    }
    if (url.pathname === `${prefix}/workspace/result` && req.method === 'POST') {
      const body = await readBody(req);
      state.commits.push(JSON.parse(body.toString('utf8')));
      json(res, 200, { artifactRef: `map://design-artifact/${pkg.runId}/result`, resultSha256: digest(body) });
      return;
    }
    if (url.pathname === `${prefix}/workspace/preview` && req.method === 'POST') {
      state.previews.push(JSON.parse((await readBody(req)).toString('utf8')));
      json(res, state.previewStatus, { accepted: true });
      return;
    }
    json(res, 404, { message: 'not found' });
  });
  state.origin = await listen(server);
  state.close = () => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
  return state;
}

export function taskRequest(map: FakeMap, pkg: BuiltPackage, overrides: Record<string, unknown> = {}) {
  const prefix = `${map.origin}/api/design-artifacts/runtime/${pkg.runId}`;
  return {
    taskId: pkg.runId,
    transfer: {
      schemaVersion: MAP_DESIGN_WORKSPACE_SCHEMA,
      inputPackageUrl: `${prefix}/workspace/input`,
      inputSha256: pkg.sha256,
      resultCommitUrl: `${prefix}/workspace/result`,
      transferToken: 'transfer-token-secret',
      baseRevision: pkg.baseRevision,
      maxInputBytes: 1024 * 1024,
      maxOutputBytes: 6 * 1024 * 1024,
      allowedOutputPaths: ['index.html', 'manifest.json', 'assets/**'],
    },
    model: {
      baseUrl: `${prefix}/llm/v1`,
      protocol: 'openai',
      apiKey: 'model-ticket-secret',
      model: 'map-managed',
    },
    timeoutSeconds: 60,
    envelope: {
      schemaVersion: 'map-design-artifact-command-v2',
      runtimeProtocol: 'cds-design-artifact-events-v1',
      runId: pkg.runId,
      workspaceTask: '/workspace/brief/task.json',
      command: 'Read the workspace task and referenced files, then implement it now.',
    },
    ...overrides,
  };
}

export interface Harness {
  root: string;
  config: ServiceConfig;
  daemon: FakeOpenDesign;
  runtime: DesignRuntime;
  baseUrl: string;
  request(method: string, pathname: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any; headers: Headers }>;
  close(): Promise<void>;
}

export const API_KEY = 'service-api-key-for-tests';

export async function startHarness(options: { apiKey?: string; overrides?: DesignRuntimeOverrides } = {}): Promise<Harness> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'design-runtime-test-'));
  const config: ServiceConfig = {
    port: 0,
    apiKey: options.apiKey ?? API_KEY,
    workspaceDir: path.join(root, 'workspace'),
    odDataDir: path.join(root, 'od-data'),
    templatesDir: path.join(root, 'design-templates'),
    outputDir: path.join(root, 'output'),
    webPrototypeSourceDir: path.join(FIXTURES, 'web-prototype'),
    designSystemsDir: path.join(FIXTURES, 'design-systems'),
    odPort: 0,
    odCommand: [],
    odCwd: root,
    engineHome: root,
    egressPort: 0,
    codexBin: 'codex',
  };
  const daemon = new FakeOpenDesign(config.workspaceDir);
  const runtime = await createDesignRuntime(config, {
    daemon,
    pollIntervalMs: 5,
    resetRetryBaseMs: 20,
    selfCheck: {
      codexVersion: 'codex-cli 0.143.0',
      codexMatches: true,
      codexObservation: 'codex-cli 0.143.0',
      missingSkillFiles: [],
      designSystems: ['default', 'editorial'],
    },
    log: () => undefined,
    ...options.overrides,
  });
  const baseUrl = await listen(runtime.server);
  await runtime.start();
  return {
    root,
    config,
    daemon,
    runtime,
    baseUrl,
    async request(method, pathname, body, headers = {}) {
      const response = await fetch(`${baseUrl}${pathname}`, {
        method,
        headers: {
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const text = await response.text();
      let parsed: any = text;
      try { parsed = JSON.parse(text); } catch { /* keep text */ }
      return { status: response.status, body: parsed, headers: response.headers };
    },
    async close() {
      await runtime.shutdown();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

export const auth = { Authorization: `Bearer ${API_KEY}` };

/** 轮询直到条件成立（上限 10 秒）。 */
export async function waitFor<T>(probe: () => T | Promise<T>, label: string, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export function directoryEntries(directory: string): string[] {
  try {
    return fs.readdirSync(directory);
  } catch {
    return [];
  }
}
