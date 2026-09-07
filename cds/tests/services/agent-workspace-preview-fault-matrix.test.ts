import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  AgentWorkspaceSessionRuntime,
  MAP_DESIGN_WORKSPACE_SCHEMA,
} from '../../src/services/agent-workspace-session-runtime.js';
import type { ExecOptions, ExecResult, IShellExecutor } from '../../src/types.js';

const MATRIX_CASES = [
  'relay-unavailable',
  'run-timeout',
  'corrupted-runtime-manifest',
  'commit-retry-on-same-session',
] as const;

function digest(value: Buffer | string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function execResult(stdout = '', stderr = '', exitCode = 0): ExecResult {
  return { stdout, stderr, exitCode };
}

function buildInputPackage() {
  const task = JSON.stringify({
    schemaVersion: MAP_DESIGN_WORKSPACE_SCHEMA,
    runId: 'map-fault-matrix-run',
    operation: 'generate',
    input: {
      userSupplied: {
        instruction: '生成故障验收页面',
        contentHash: null,
        authority: 'user-supplied',
      },
      serverKnowledge: {
        authority: 'server-authoritative-snapshot',
        references: [],
      },
      currentHtml: null,
    },
    inputAuthority: 'user-supplied',
    title: '故障验收页面',
    baseRevision: 'fault-matrix-revision',
    responseContract: {
      requiredFile: 'index.html',
      manifestFile: 'manifest.json',
      writeback: 'external',
    },
    qualityContract: {
      schemaVersion: 'map-design-artifact-quality-v1',
      factualSources: [],
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
  });
  const taskBytes = Buffer.from(task);
  const body = {
    schemaVersion: MAP_DESIGN_WORKSPACE_SCHEMA,
    runId: 'map-fault-matrix-run',
    baseRevision: 'fault-matrix-revision',
    files: [{
      path: 'brief/task.json',
      contentBase64: taskBytes.toString('base64'),
      sha256: digest(taskBytes),
      size: taskBytes.byteLength,
      mediaType: 'application/json',
    }],
  };
  const serialized = Buffer.from(JSON.stringify(body));
  return { serialized, sha256: digest(serialized) };
}

class FaultMatrixShell implements IShellExecutor {
  readonly calls: Array<{ command: string; options?: ExecOptions }> = [];
  workspaceDir = '';
  relayConnectFails = false;

  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    this.calls.push({ command, options });
    if (command.startsWith('docker version')) return execResult('27.0.0\n');
    if (command.startsWith('docker image inspect')) return execResult('sha256:fault-matrix-image\n');
    if (command.includes('/cds-storage-probe') && command.startsWith('docker run --rm')) {
      return execResult('hard-limit-enforced\n');
    }
    if (command.includes('--entrypoint /bin/sh') && !command.includes('--cap-add CHOWN')) {
      return execResult('/usr/local/bin/opencode\n');
    }
    if (command.startsWith('docker network create')) return execResult('network-id\n');
    if (command.startsWith('docker volume create')) return execResult('volume-id\n');
    if (command.startsWith('docker create ')) return execResult('container-id\n');
    if (command.startsWith('docker run ') && command.includes('CDS_OUTPUT_PREFLIGHT=1')) {
      const outputDir = command.match(/type=bind,src=([^,']+),dst=\/cds-output/)?.[1];
      if (outputDir && this.workspaceDir) {
        for (const relative of ['index.html', 'manifest.json', 'assets']) {
          const source = path.join(this.workspaceDir, relative);
          if (!fs.existsSync(source)) continue;
          fs.cpSync(source, path.join(outputDir, relative), { recursive: true });
        }
      }
      return execResult('exported\n');
    }
    if (command.startsWith('docker run ')) return execResult('container-id\n');
    if (command.startsWith('docker start ')) return execResult('started\n');
    if (command.startsWith('docker pause ')) return execResult('paused\n');
    if (command.startsWith('docker unpause ')) return execResult('resumed\n');
    if (command.startsWith('docker network connect ')) {
      return this.relayConnectFails
        ? execResult('', 'relay connect rejected', 1)
        : execResult('connected\n');
    }
    if (command.startsWith('docker cp ')) {
      const inbound = command.match(/^docker cp '([^']+)\/\.' 'cds-od-[^']+:\/workspace\/'$/);
      if (inbound) this.workspaceDir = inbound[1];
      const outbound = command.match(/^docker cp 'cds-od-[^']+:\/workspace\/\.' '([^']+)'$/);
      if (outbound && this.workspaceDir) fs.cpSync(this.workspaceDir, outbound[1], { recursive: true });
      return execResult('copied\n');
    }
    if (command.startsWith('docker exec ')) return execResult('ready\n');
    if (command.startsWith('docker inspect ')) return execResult('127.0.0.1\n');
    if (command.startsWith('docker kill ')) return execResult('killed\n');
    if (command.startsWith('docker rm -f ')) return execResult('removed\n');
    if (command.startsWith('docker network rm ')) return execResult('removed\n');
    if (command.startsWith('docker volume rm ')) return execResult('removed\n');
    throw new Error(`fault matrix received an unregistered shell command: ${command}`);
  }
}

type RuntimeFixture = {
  runtime: AgentWorkspaceSessionRuntime;
  shell: FaultMatrixShell;
  sessionId: string;
  requests: string[];
  committedBodies: Array<Record<string, unknown>>;
  stages: string[];
  setRunAlwaysPending(value: boolean): void;
  setCommitFailures(value: number): void;
};

describe('Agent workspace preview fault matrix', () => {
  const roots: string[] = [];
  const sessions: Array<{ runtime: AgentWorkspaceSessionRuntime; sessionId: string }> = [];

  afterEach(async () => {
    for (const { runtime, sessionId } of sessions.splice(0)) {
      await runtime.stop(sessionId, 'fault_matrix_finally').catch(() => undefined);
    }
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  async function createFixture(caseId: typeof MATRIX_CASES[number]): Promise<RuntimeFixture> {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-preview-fault-matrix-'));
    roots.push(rootDir);
    const input = buildInputPackage();
    const shell = new FaultMatrixShell();
    const requests: string[] = [];
    const committedBodies: Array<Record<string, unknown>> = [];
    const stages: string[] = [];
    let runAlwaysPending = false;
    let commitFailures = 0;
    let runNumber = 0;
    const fetchImpl: typeof fetch = async (inputValue, init) => {
      const url = new URL(typeof inputValue === 'string'
        ? inputValue
        : inputValue instanceof URL
          ? inputValue
          : inputValue.url);
      requests.push(url.pathname);
      if (url.pathname === '/input') return new Response(input.serialized, { status: 200 });
      if (url.pathname === '/api/health') return Response.json({ ok: true });
      if (url.pathname === '/api/import/folder') {
        return Response.json({
          project: { id: 'fault-matrix-project', skillId: 'web-prototype' },
          conversationId: 'fault-matrix-conversation',
        });
      }
      if (url.pathname === '/api/runs' && init?.method === 'POST') {
        runNumber += 1;
        fs.writeFileSync(
          path.join(shell.workspaceDir, 'index.html'),
          '<!doctype html><html lang="zh-CN"><head><title>故障验收页面</title></head><body><main><h1>故障验收页面</h1></main></body></html>',
        );
        if (caseId === 'corrupted-runtime-manifest') {
          fs.writeFileSync(path.join(shell.workspaceDir, 'manifest.json'), '{"untrusted":true');
        }
        return Response.json({ runId: `fault-matrix-run-${runNumber}` }, { status: 202 });
      }
      if (/^\/api\/runs\/fault-matrix-run-\d+$/.test(url.pathname)) {
        return Response.json(runAlwaysPending
          ? { status: 'running' }
          : { status: 'succeeded', deliverableValid: true });
      }
      if (url.pathname.endsWith('/cancel')) return Response.json({ canceled: true });
      if (url.pathname === '/commit') {
        const raw = typeof init?.body === 'string' ? init.body : '';
        committedBodies.push(JSON.parse(raw) as Record<string, unknown>);
        if (commitFailures > 0) {
          commitFailures -= 1;
          return Response.json({ message: 'temporary commit outage' }, { status: 503 });
        }
        return Response.json({ artifactRef: 'artifact:fault-matrix', resultSha256: digest(raw) });
      }
      return new Response('', { status: 404 });
    };
    const runtime = new AgentWorkspaceSessionRuntime(shell, {
      rootDir,
      instanceId: 'fault-matrix-instance',
      daemonPort: 7456,
      fetchImpl,
      pollIntervalMs: 5,
      capabilityCacheMs: 0,
      containerUid: process.getuid?.() ?? 1001,
      containerGid: process.getgid?.() ?? 1001,
    });
    const sessionId = `fault-matrix-${caseId}`;
    await runtime.create(sessionId, {
      schemaVersion: MAP_DESIGN_WORKSPACE_SCHEMA,
      inputPackageUrl: 'https://map.example.test/input',
      resultCommitUrl: 'https://map.example.test/commit',
      transferToken: 'transfer-token',
      inputSha256: input.sha256,
      baseRevision: 'fault-matrix-revision',
      maxInputBytes: 1024 * 1024,
      maxOutputBytes: 1024 * 1024,
      allowedOutputPaths: ['index.html', 'manifest.json', 'assets/**'],
    }, {
      cpuCores: 1,
      memoryMb: 768,
      timeoutSeconds: caseId === 'run-timeout' ? 1 : 30,
      networkPolicy: 'egress-only',
      autoCleanupMinutes: 3,
    });
    sessions.push({ runtime, sessionId });
    return {
      runtime,
      shell,
      sessionId,
      requests,
      committedBodies,
      stages,
      setRunAlwaysPending(value) { runAlwaysPending = value; },
      setCommitFailures(value) { commitFailures = value; },
    };
  }

  const execute = (fixture: RuntimeFixture) => fixture.runtime.execute(
    fixture.sessionId,
    '生成完整页面',
    {
      baseUrl: 'https://map.example.test/api/design-artifacts/runtime/fault-matrix/llm/v1',
      protocol: 'openai',
      apiKey: 'model-secret',
      model: 'map-managed',
    },
    'transfer-token',
    undefined,
    (stage) => fixture.stages.push(stage),
  );

  it('locks the bounded matrix to four existing injection paths', () => {
    expect(MATRIX_CASES).toEqual([
      'relay-unavailable',
      'run-timeout',
      'corrupted-runtime-manifest',
      'commit-retry-on-same-session',
    ]);
  });

  it('fails closed before any OpenDesign run when the relay cannot join the isolated network', async () => {
    const fixture = await createFixture('relay-unavailable');
    fixture.shell.relayConnectFails = true;

    await expect(execute(fixture)).rejects.toMatchObject({
      code: 'workspace_egress_unavailable',
      retryable: true,
    });

    expect(fixture.requests).not.toContain('/api/runs');
    expect(fixture.shell.calls.some((call) => call.command.startsWith('docker rm -f ')
      && call.command.includes('cds-od-egress-'))).toBe(true);
  });

  it('cancels the active OpenDesign run when the session deadline expires', async () => {
    const fixture = await createFixture('run-timeout');
    fixture.setRunAlwaysPending(true);

    await expect(execute(fixture)).rejects.toMatchObject({
      code: 'open_design_run_timeout',
      retryable: true,
    });

    expect(fixture.requests.some((requestPath) => requestPath.endsWith('/cancel'))).toBe(true);
    expect(fixture.committedBodies).toHaveLength(0);
  });

  it('discards a corrupted runtime manifest and commits the CDS-attested manifest', async () => {
    const fixture = await createFixture('corrupted-runtime-manifest');

    const executed = await execute(fixture);
    expect(executed.artifactRef).toBe('artifact:fault-matrix');
    expect(executed.files[0]).toMatchObject({ path: 'assets/accessibility-static-report.json' });

    expect(fixture.committedBodies).toHaveLength(1);
    const files = fixture.committedBodies[0].files as Array<Record<string, unknown>>;
    expect(files.map((file) => file.path)).toEqual([
      'assets/accessibility-static-report.json',
      'assets/design-tokens.json',
      'assets/page-outline.json',
      'assets/provenance.json',
      'index.html',
      'manifest.json',
    ]);
    const manifestFile = files.find((file) => file.path === 'manifest.json');
    const manifestText = Buffer.from(String(manifestFile?.contentBase64), 'base64').toString('utf8');
    expect(JSON.parse(manifestText)).toMatchObject({
      schemaVersion: 'map-design-artifact-public-manifest-v2',
      artifactRevision: expect.stringMatching(/^[a-f0-9]{64}$/),
      entryFile: 'index.html',
    });
    expect(manifestText).not.toContain('fault-matrix-revision');
    expect(manifestText).not.toContain('untrusted');
  });

  it('releases committing state after a transient MAP failure and reuses the same managed session', async () => {
    const fixture = await createFixture('commit-retry-on-same-session');
    fixture.setCommitFailures(1);

    await expect(execute(fixture)).rejects.toMatchObject({
      code: 'workspace_commit_failed',
      retryable: true,
    });
    await expect(execute(fixture)).resolves.toMatchObject({
      artifactRef: 'artifact:fault-matrix',
    });

    expect(fixture.committedBodies).toHaveLength(2);
    expect(fixture.stages.filter((stage) => stage === 'workspace_committing')).toHaveLength(2);
    expect(fixture.shell.calls.filter((call) => call.command.startsWith('docker network connect '))).toHaveLength(2);
    expect(fixture.runtime.has(fixture.sessionId)).toBe(true);
  });
});
