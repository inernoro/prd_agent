import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createDesignBridge } from '../src/design-bridge.mjs';

const projectId = 'acceptance-standard-fixture';
const endpoint = `/api/projects/${projectId}/design`;
const methods = { mece: 'MECE 覆盖', compare: '对照图', visual: '视觉', regress: '历史易错',
  flow: '流程', human: '人工', smoke: '冒烟', debt: '验收债务' };
const dimensions = { correctness: '正确性', compatibility: '兼容性', performance: '性能容量',
  security: '安全合规', operations: '运维部署', experience: '用户体验' };
const catalog = values => Object.entries(values).map(([id, label]) => ({ id, label }));
const acceptancePolicy = { version: 1, gate: 'G-11', methods: catalog(methods), dimensions: catalog(dimensions) };
const privateDiagnostic = 'synthetic-private-upstream-diagnostic';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'cds-design-acceptance-'));
  const contents = Buffer.from('synthetic design archive');
  await writeFile(path.join(root, 'draft.zip'), contents);
  const intake = { protocolVersion: 1, projectId, permissions: { write: true }, frameworks: [], designs: [], acceptancePolicy };
  const calls = [];
  const packages = [];
  const server = createServer(async (request, response) => {
    const target = new URL(request.url, 'http://127.0.0.1');
    calls.push([request.method, target.pathname]);
    let status = 404;
    let payload = { error: 'fixture_route_missing' };
    if (request.method === 'GET' && target.pathname === `${endpoint}/intake`) {
      status = 200;
      payload = intake;
    } else if (request.method === 'POST' && target.pathname === `${endpoint}/packages`) {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      packages.push({ body: Buffer.concat(chunks), query: Object.fromEntries(target.searchParams) });
      status = 400;
      payload = {
        error: 'G-11', message: privateDiagnostic,
        issues: [
          { field: 'acceptancePlan.human', code: 'required_method', reason: privateDiagnostic },
          { field: 'acceptance[0].dimension', code: 'invalid_dimension', ruleId: 'A-01' },
          { field: 'risks.security', code: 'missing_coverage' },
          { field: `acceptancePlan.${privateDiagnostic}`, code: 'missing_method' },
          { field: 'acceptance[1].dimension', code: 'invalid_dimension', ruleId: privateDiagnostic },
          { field: 'acceptancePlan.flow', code: privateDiagnostic },
        ],
      };
    }
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(payload));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const host = `http://127.0.0.1:${server.address().port}`;
  const bridge = createDesignBridge({ root, host, projectId, projectKey: 'cdsp_fixture_only' });
  t.after(async () => {
    await bridge.close();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  return { bridge, calls, packages, contents };
}

test('MCP design intake returns the current acceptance policy from the bound CDS project', async t => {
  const { bridge, calls } = await fixture(t);
  const intake = await bridge.call('cds_design_read', { view: 'intake' });
  assert.deepEqual(intake.acceptancePolicy, acceptancePolicy);
  assert.deepEqual(calls, [['GET', `${endpoint}/intake`]]);
});

test('MCP publication returns only safe acceptance fields and rule ids from CDS', async t => {
  const { bridge, calls, packages, contents } = await fixture(t);
  await assert.rejects(bridge.call('cds_design_publish', {
    zipPath: 'draft.zip', sourcePath: 'design/overview', sourceCommit: 'a'.repeat(40),
    sourceMode: 'private', intent: 'create', designKey: 'fixture/overview', requestId: 'acceptance-repair',
  }), error => {
    assert.match(error.message, /G-11/);
    assert.match(error.message, /acceptancePlan\.human/);
    assert.match(error.message, /acceptance\[0\]\.dimension/);
    assert.match(error.message, /A-01/);
    assert.match(error.message, /risks\.security/);
    assert.ok(!error.message.includes(privateDiagnostic));
    return true;
  });
  assert.deepEqual(calls, [['GET', `${endpoint}/intake`], ['POST', `${endpoint}/packages`]]);
  assert.deepEqual(packages[0].body, contents);
  assert.equal(packages[0].query.requestId, 'acceptance-repair');
});
