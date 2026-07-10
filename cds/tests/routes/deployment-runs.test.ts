import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDeploymentRunsRouter } from '../../src/routes/deployment-runs.js';
import { DeploymentRunService } from '../../src/services/deployment-run.js';
import { DeploymentVersionService } from '../../src/services/deployment-version.js';
import { DeploymentDiagnosisService } from '../../src/services/deployment-diagnosis.js';
import { StateService } from '../../src/services/state.js';

interface TestResponse {
  status: number;
  body: any;
  raw: string;
}

describe('Deployment runs router', () => {
  let tmpDir: string;
  let stateService: StateService;
  let runService: DeploymentRunService;
  let server: http.Server;
  let nextId: number;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-deployment-runs-route-'));
    stateService = new StateService(path.join(tmpDir, 'state.json'));
    stateService.load();
    for (const projectId of ['p1', 'p2']) {
      stateService.addProject({ id: projectId, slug: projectId, name: projectId } as any);
      stateService.addBranch({
        id: `b-${projectId}`,
        projectId,
        branch: `feat/${projectId}`,
        worktreePath: `/tmp/${projectId}`,
        services: {},
        status: 'idle',
        createdAt: '2026-07-10T00:00:00.000Z',
      });
    }
    nextId = 1;
    runService = new DeploymentRunService(stateService, {
      idFactory: () => `dr_${nextId++}`,
      now: () => new Date('2026-07-10T01:00:00.000Z'),
    });

    const app = express();
    app.use((req, _res, next) => {
      const projectId = req.header('x-test-project');
      if (projectId) (req as any).cdsProjectKey = { projectId, keyId: 'test' };
      next();
    });
    app.use('/api', createDeploymentRunsRouter({
      deploymentRunService: runService,
      deploymentDiagnosisService: new DeploymentDiagnosisService(
        runService,
        new DeploymentVersionService(stateService),
        { explain: async () => ({ summary: '结构化事实表明构建失败', actions: ['修复编译错误'] }) },
      ),
      assertProjectAccess: (req, projectId) => {
        const key = (req as any).cdsProjectKey as { projectId: string } | undefined;
        return !key || key.projectId === projectId
          ? null
          : { status: 403, body: { error: 'project_mismatch' } };
      },
      pollIntervalMs: 50,
      heartbeatIntervalMs: 1_000,
    }));
    server = app.listen(0);
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('scopes list results to a project key and omits event payloads', async () => {
    runService.begin({ projectId: 'p1', branchId: 'b-p1', trigger: 'manual' });
    runService.begin({ projectId: 'p2', branchId: 'b-p2', trigger: 'webhook' });

    const response = await request(server, 'GET', '/api/deployment-runs', undefined, {
      'x-test-project': 'p1',
    });

    expect(response.status).toBe(200);
    expect(response.body.total).toBe(1);
    expect(response.body.runs[0]).toMatchObject({ id: 'dr_1', projectId: 'p1', eventCount: 1 });
    expect(response.body.runs[0].latestEvent).toMatchObject({ seq: 1, status: 'pending' });
    expect(response.body.runs[0]).not.toHaveProperty('events');
  });

  it('rejects an invalid status filter', async () => {
    const response = await request(server, 'GET', '/api/deployment-runs?status=unknown');
    expect(response.status).toBe(400);
    expect(response.body.error).toContain('状态无效');
  });

  it('enforces project access for run detail', async () => {
    runService.begin({ projectId: 'p1', branchId: 'b-p1', trigger: 'manual' });
    const response = await request(server, 'GET', '/api/deployment-runs/dr_1', undefined, {
      'x-test-project': 'p2',
    });
    expect(response.status).toBe(403);
    expect(response.body.error).toBe('project_mismatch');
  });

  it('resumes terminal SSE output after the requested sequence', async () => {
    runService.begin({ projectId: 'p1', branchId: 'b-p1', trigger: 'manual' });
    runService.transition('dr_1', 'preparing', { phase: 'pull', message: '正在准备源码' });
    runService.fail('dr_1', {
      code: 'cds.test.failed',
      owner: 'code',
      retryable: false,
      summary: '测试失败',
      phase: 'pull',
      evidenceRefs: [],
    });

    const response = await request(server, 'GET', '/api/deployment-runs/dr_1/stream?afterSeq=1');

    expect(response.status).toBe(200);
    expect(response.raw).toContain('event: snapshot');
    expect(response.raw).toContain('id: 2');
    expect(response.raw).toContain('id: 3');
    expect(response.raw).not.toContain('id: 1\n');
    expect(response.raw).toContain('event: done');
    expect(response.raw).toContain('"status":"failed"');
  });

  it('returns deterministic diagnosis and streams visible AI explanation stages', async () => {
    runService.begin({ projectId: 'p1', branchId: 'b-p1', trigger: 'manual' });
    runService.fail('dr_1', {
      code: 'build.compile.typescript', owner: 'code', retryable: false,
      summary: 'TypeScript 编译失败', phase: 'build', evidenceRefs: ['deployment-run:dr_1:event:1'],
      suggestedAction: '修复首个类型错误',
    });

    const deterministic = await request(server, 'GET', '/api/deployment-runs/dr_1/diagnosis');
    expect(deterministic.status).toBe(200);
    expect(deterministic.body.diagnosis).toMatchObject({
      runId: 'dr_1',
      failure: { code: 'build.compile.typescript', owner: 'code' },
      ai: { status: 'ready' },
    });

    const stream = await request(server, 'GET', '/api/deployment-runs/dr_1/diagnosis/stream?ai=1');
    expect(stream.status).toBe(200);
    expect(stream.raw).toContain('event: facts-ready');
    expect(stream.raw).toContain('event: ai-stage');
    expect(stream.raw).toContain('AI Gateway 正在解释结构化部署事实');
    expect(stream.raw).toContain('event: explanation');
    expect(stream.raw).toContain('结构化事实表明构建失败');
    expect(stream.raw).toContain('event: complete');
  });
});

async function request(
  server: http.Server,
  method: string,
  urlPath: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const address = server.address() as { port: number };
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port: address.port,
      path: urlPath,
      method,
      headers: {
        Accept: 'application/json, text/event-stream',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers,
      },
    }, (res) => {
      let raw = '';
      res.on('data', (chunk: Buffer) => { raw += chunk.toString(); });
      res.on('end', () => {
        let parsed: any = raw;
        if (String(res.headers['content-type'] || '').includes('application/json') && raw) {
          parsed = JSON.parse(raw);
        }
        resolve({ status: res.statusCode || 0, body: parsed, raw });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
