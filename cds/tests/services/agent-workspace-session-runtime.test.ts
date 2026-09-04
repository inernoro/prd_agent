import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  AgentWorkspaceRuntimeError,
  AgentWorkspaceSessionRuntime,
  MAP_DESIGN_WORKSPACE_SCHEMA,
  normalizeWorkspaceTransfer,
} from '../../src/services/agent-workspace-session-runtime.js';
import type { ExecOptions, ExecResult, IShellExecutor } from '../../src/types.js';

function digest(value: Buffer | string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function result(stdout = '', stderr = '', exitCode = 0): ExecResult {
  return { stdout, stderr, exitCode };
}

class RecordingShell implements IShellExecutor {
  readonly calls: Array<{ command: string; options?: ExecOptions }> = [];
  workspaceDir = '';

  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    this.calls.push({ command, options });
    if (command.startsWith('docker version')) return result('27.0.0\n');
    if (command.startsWith('docker image inspect')) return result('sha256:image\n');
    if (command.includes('--entrypoint /bin/sh')) return result('/usr/local/bin/opencode\n');
    if (command.startsWith('docker network create')) return result('network-id\n');
    if (command.startsWith('docker run ')) {
      const mount = command.match(/type=bind,src=([^,']+),dst=\/workspace/);
      this.workspaceDir = mount?.[1] || '';
      return result('container-id\n');
    }
    if (command.startsWith('docker inspect ')) return result('127.0.0.1\n');
    if (command.startsWith('docker rm -f ')) return result('removed\n');
    if (command.startsWith('docker network rm ')) return result('removed\n');
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
    if (rootDir) fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('materializes a verified package, runs an isolated OpenDesign container, and commits only allowed outputs', async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-agent-workspace-test-'));
    const workspacePackage = buildPackage([
      { path: 'knowledge/source.md', content: 'Private knowledge body', mediaType: 'text/markdown' },
      { path: 'brief.txt', content: 'Build a launch page', mediaType: 'text/plain' },
    ]);
    const requests: Array<{ path: string; authorization: string; body?: any }> = [];
    const shell = new RecordingShell();
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
        return Response.json({ project: { id: 'od-project' }, conversationId: 'od-conversation' });
      }
      if (requestPath === '/api/runs' && init?.method === 'POST') {
          fs.writeFileSync(
            path.join(shell.workspaceDir, 'index.html'),
            '<!doctype html><html><body>Generated</body></html>',
          );
          fs.mkdirSync(path.join(shell.workspaceDir, 'assets'));
          fs.writeFileSync(path.join(shell.workspaceDir, 'assets', 'app.css'), 'body{color:blue}');
          fs.writeFileSync(path.join(shell.workspaceDir, 'manifest.json'), '{"untrusted":true}');
          fs.writeFileSync(path.join(shell.workspaceDir, 'not-allowed.txt'), 'must not leave CDS');
        return Response.json({ runId: 'od-run-1' }, { status: 202 });
      }
      if (requestPath === '/api/runs/od-run-1' && init?.method === 'GET') {
        return Response.json({ status: 'succeeded', deliverableValid: true });
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
    const runCommand = shell.calls.find((call) => call.command.startsWith('docker run --detach'));
    expect(runCommand?.command).toContain('--read-only');
    expect(runCommand?.command).toContain('--security-opt no-new-privileges:true');
    expect(runCommand?.command).toContain('--cap-drop ALL');
    expect(runCommand?.command).toContain('--pids-limit 256');
    expect(runCommand?.command).toContain('ghcr.io/inernoro/prd_agent/opendesign-runtime:od-0.21.1-opencode-1.18.28');
    expect(runCommand?.command).not.toContain('transfer-token');
    expect(runCommand?.command).not.toContain('model-secret');
    expect(runCommand?.options?.stdin).not.toContain('transfer-token');
    expect(runCommand?.options?.stdin).not.toContain('model-secret');

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
    const imported = requests.find((request) => request.path === '/api/import/folder');
    expect(imported?.body).toMatchObject({
      baseDir: '/workspace',
      orchestratorWorkspace: {
        kind: 'scratch',
        baseRevision: 'rev-1',
        writeback: 'external',
      },
    });
    const run = requests.find((request) => request.path === '/api/runs');
    expect(run?.body).toMatchObject({
      projectId: 'od-project',
      conversationId: 'od-conversation',
      agentId: 'byok-opencode',
      model: 'map-managed',
      message: 'Make the page visually polished.',
      byokProvider: {
        protocol: 'openai',
        apiKey: 'model-secret',
        model: 'map-managed',
      },
    });
    expect(JSON.stringify(run?.body)).not.toContain('Private knowledge body');
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

    await runtime.stop('session-test-1');
    expect(runtime.has('session-test-1')).toBe(false);
    expect(fs.existsSync(created.hostRoot)).toBe(false);
    expect(shell.calls.some((call) => call.command.startsWith('docker rm -f '))).toBe(true);
    expect(shell.calls.some((call) => call.command.startsWith('docker network rm '))).toBe(true);
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

  it('keeps OpenDesign unavailable when the configured image is not installed', async () => {
    const shell: IShellExecutor = {
      async exec(command: string): Promise<ExecResult> {
        if (command.startsWith('docker version')) return result('27.0.0\n');
        if (command.startsWith('docker image inspect')) return result('', 'No such image', 1);
        throw new Error(`unexpected command: ${command}`);
      },
    };
    const runtime = new AgentWorkspaceSessionRuntime(shell, { capabilityCacheMs: 0 });

    await expect(runtime.capability()).resolves.toEqual({
      available: false,
      resourcePolicyEnforcedPerSession: false,
      reason: 'OpenDesign image ghcr.io/inernoro/prd_agent/opendesign-runtime:od-0.21.1-opencode-1.18.28 is not installed on this CDS node',
    });
  });

  it('keeps OpenDesign unavailable when the image has no compatible Agent CLI', async () => {
    const shell: IShellExecutor = {
      async exec(command: string): Promise<ExecResult> {
        if (command.startsWith('docker version')) return result('27.0.0\n');
        if (command.startsWith('docker image inspect')) return result('sha256:image\n');
        if (command.includes('--entrypoint /bin/sh')) return result('', 'opencode not found', 1);
        throw new Error(`unexpected command: ${command}`);
      },
    };
    const runtime = new AgentWorkspaceSessionRuntime(shell, { capabilityCacheMs: 0 });

    await expect(runtime.capability()).resolves.toEqual({
      available: false,
      resourcePolicyEnforcedPerSession: false,
      reason: 'OpenDesign image ghcr.io/inernoro/prd_agent/opendesign-runtime:od-0.21.1-opencode-1.18.28 does not contain the required OpenCode Agent CLI',
    });
  });
});
