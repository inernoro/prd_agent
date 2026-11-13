import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { executeStableSmokeArchive } from '../stable-smoke-run.mjs';

const input = {
  productionReadOnly: true, projectId: 'prd-agent',
  runId: 'stsmk-archive-regression', verdict: 'pass', reportPath: '/tmp/report.md',
  branch: 'codex/no-cds-deployment', commit: 'a'.repeat(40), folderPath: '稳定冒烟/回归',
};

test('[REG-stsmk-production-read-only-001] 归档只调用项目报告接口，不查询 CDS 分支', async () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'stable-smoke-archive-'));
  const reportPath = resolve(directory, 'readonly.md');
  writeFileSync(reportPath, '# 正式只读回归\n\n无部署分支的检查也必须能够归档。');
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({ method: request.method, path: request.url });
    response.setHeader('content-type', 'application/json');
    if (request.method !== 'POST' || request.url !== '/api/reports') {
      response.writeHead(503).end(JSON.stringify({ error: 'CDS branches unavailable' }));
      return;
    }
    const body = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(body.projectId, 'prd-agent');
    assert.equal(body.branchId, undefined);
    assert.equal(body.branch, input.branch);
    assert.equal(body.commitSha, input.commit);
    response.writeHead(201).end(JSON.stringify({ report: {
      id: 'readonly-report', projectId: body.projectId, folderId: 'readonly-folder',
    } }));
  });
  await new Promise(resolveListening => server.listen(0, '127.0.0.1', resolveListening));
  const port = server.address().port;
  try {
    let processResult;
    executeStableSmokeArchive({ ...input, reportPath }, (program, args, options) => {
      processResult = new Promise((resolveExit, reject) => {
        const child = spawn(program, args, { ...options, env: {
          ...options.env, CDS_HOST: `http://127.0.0.1:${port}`, AI_ACCESS_KEY: 'fixture-only',
          CDS_PROJECT_KEY: 'fixture-only', CDS_PROJECT_ID: 'prd-agent', CDSCLI_NO_DRIFT_CHECK: '1',
        } });
        let stdout = '', stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('error', reject);
        child.on('close', status => resolveExit({ status, stdout, stderr }));
      });
      return processResult;
    });
    const result = await processResult;
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /report=readonly-report/);
    assert.deepEqual(requests, [{ method: 'POST', path: '/api/reports' }]);
  } finally {
    await new Promise(resolveClosed => server.close(resolveClosed));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('[REG-stsmk-production-read-only-001] 缺项目身份时不创建无归属报告', () => {
  assert.throws(() => executeStableSmokeArchive({ ...input, projectId: '' }, () => {
    assert.fail('缺项目归属时不得发送归档请求');
  }), /缺少 CDS 项目归属/);
});
