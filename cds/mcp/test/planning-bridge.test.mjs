import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createPlanningBridge } from '../src/planning-bridge.mjs';

const projectId = 'planning-fixture';
const projectKey = 'cdsp_planning_fixture_key';
const basePath = `/api/projects/${projectId}/planning`;
const readTool = 'cds_planning_read';
const proposeTool = 'cds_planning_propose';
const recordTool = 'cds_planning_record_debt';
const source = { type: 'manual', ref: 'fixture:confirmed-tradeoff-1' };
const proposal = {
  requestId: 'planning-fixture:proposal-1',
  kind: 'debt',
  draft: { title: '补齐导出测试', whyDebt: '经确认安排下个版本' },
  source,
};
const directDebt = { requestId: 'planning-fixture:debt-1', title: '补齐导出测试', source };

async function fixture(t) {
  const state = {
    permissions: ['read', 'propose', 'write'],
    requests: [],
    committed: new Map(),
    responseProject: projectId,
    protocolVersion: 1,
    dropWriteResponse: false,
    rejectWrite: false,
  };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined;
    const url = new URL(req.url, 'http://127.0.0.1');
    state.requests.push({ method: req.method, url, body, key: req.headers['x-ai-access-key'] });
    const send = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    if (req.headers['x-ai-access-key'] !== projectKey) {
      send(401, { message: '未认证' });
      return;
    }
    const debt = { id: 'D-0001', projectId: state.responseProject, title: directDebt.title };
    switch (url.pathname) {
      case `${basePath}/capabilities`:
        send(200, { projectId, protocolVersion: state.protocolVersion, permissions: state.permissions });
        break;
      case basePath:
        send(200, { projectId, capabilities: state.permissions, decisions: [], proposals: [], plans: [] });
        break;
      case `${basePath}/debts`:
        send(200, { projectId, items: [debt], nextCursor: null });
        break;
      case `${basePath}/duplicates`:
        send(200, { projectId: state.responseProject, items: [{ id: debt.id, title: debt.title, status: 'open', similarity: 1 }] });
        break;
      case `${basePath}/debts/D-0001`:
        send(200, { projectId, debt, events: [] });
        break;
      case `${basePath}/commands`: {
        if (state.rejectWrite) {
          send(403, { error: 'write_forbidden', message: projectKey, details: 'upstream fixture detail' });
          break;
        }
        const kind = body.type === 'proposal.submit' ? 'proposal' : 'debt';
        const old = state.committed.get(body.requestId);
        if (old && JSON.stringify(old.body) !== JSON.stringify(body)) {
          send(409, { error: 'idempotency_conflict' });
          break;
        }
        const result = old?.result ?? {
          id: kind === 'proposal' ? 'P-0001' : debt.id,
          projectId: state.responseProject,
          status: kind === 'proposal' ? 'pending' : 'open',
        };
        state.committed.set(body.requestId, { body, result });
        if (state.dropWriteResponse) {
          state.dropWriteResponse = false;
          req.socket.destroy();
        } else {
          send(old ? 200 : 201, { projectId, result, reused: Boolean(old) });
        }
        break;
      }
      default:
        send(404, { error: 'not_found' });
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const credentials = { host: `http://127.0.0.1:${server.address().port}`, projectId, projectKey };
  const bridge = createPlanningBridge(credentials);
  t.after(() => bridge.close());
  return { state, bridge, credentials };
}

test('discovers read and proposal tools from current permissions and refreshes on write', async t => {
  const { state, bridge } = await fixture(t);
  state.permissions = ['read', 'propose'];
  const names = async () => (await bridge.listTools()).map(tool => tool.name).sort();
  assert.deepEqual(await names(), [proposeTool, readTool].sort());
  const receipt = await bridge.call(proposeTool, proposal);
  assert.equal(receipt.result.id, 'P-0001');
  assert.equal(receipt.result.status, 'pending');
  assert.deepEqual(state.requests.at(-1).body, { type: 'proposal.submit', ...proposal });
  assert.equal(state.requests.at(-1).key, projectKey);

  state.permissions = ['read'];
  await assert.rejects(bridge.call(proposeTool, { ...proposal, requestId: 'revoked-proposal' }));
  await assert.rejects(bridge.call(recordTool, directDebt));
  assert.equal(state.requests.filter(call => call.method === 'POST').length, 1);
  assert.deepEqual(await names(), [readTool]);
});

test('submits real skill context and ADR links through the existing proposal tool', async t => {
  const { state, bridge } = await fixture(t);
  const input = {
    requestId: 'adr-file:export:fixture', kind: 'decision', skill: 'cds-plan', confidence: 0.9,
    decisionChange: { decisionId: 'ADR-1', expectedVersion: 2, change: 'amended' },
    source: { type: 'adr', ref: 'docs/adr/export.md@fixture', url: 'https://example.com/adr.md', excerpt: '采用导出任务。' },
    draft: { title: '采用导出任务', links: [{ type: 'adr', title: '导出 ADR', url: 'https://example.com/adr.md' }],
      decisionKind: 'forward', options: [{ title: '异步导出', benefits: '避免长请求' }], chosenOption: '异步导出', consequences: '增加任务队列',
      pullRequest: { url: 'https://github.com/org/repo/pull/42', target: { label: '报表', path: '/reports' } } },
  };
  await bridge.call(proposeTool, input);
  assert.deepEqual(state.requests.at(-1).body, { type: 'proposal.submit', ...input });
  await assert.rejects(bridge.call(proposeTool, { ...input, confidence: 1.1 }));
  await assert.rejects(bridge.call(proposeTool, { ...input, suggest: { dupOf: 'other-debt' } }));
  await assert.rejects(bridge.call(proposeTool, { ...input, decisionChange: { ...input.decisionChange, change: 'deprecated' } }));
  assert.equal(state.requests.filter(call => call.method === 'POST').length, 1);
});

test('forwards debt modules and a proposed delivery plan start date', async t => {
  const { state, bridge } = await fixture(t);
  const module = '导出与报表';
  await bridge.call(readTool, { view: 'debts', module });
  assert.equal(state.requests.at(-1).url.searchParams.get('module'), module);
  await bridge.call(recordTool, { ...directDebt, module });
  assert.equal(state.requests.at(-1).body.module, module);
  const input = { requestId: 'fixture-debt-module', kind: 'debt', source, draft: { title: directDebt.title, module } };
  await bridge.call(proposeTool, input);
  assert.equal(state.requests.at(-1).body.draft.module, module);
  const delivery = { requestId: 'fixture-plan-start', kind: 'plan', source,
    draft: { title: '分阶段交付导出', startAt: '2026-11-24', dueAt: '2026-12-12', debtIds: ['D-0001', 'D-0002'] } };
  await bridge.call(proposeTool, delivery);
  assert.deepEqual(state.requests.at(-1).body.draft, delivery.draft);
  await assert.rejects(bridge.call(proposeTool, { ...delivery, draft: { ...delivery.draft, debtIds: ['D-0001', 'D-0001'] } }));
});

test('reads duplicate candidates and submits only the caller’s explicit distinction', async t => {
  const { state, bridge } = await fixture(t);
  const check = await bridge.call(readTool, { view: 'duplicates', title: directDebt.title });
  assert.equal(check.items[0].id, 'D-0001');
  assert.equal(state.requests.at(-1).url.pathname, `${basePath}/duplicates`);
  assert.equal(state.requests.at(-1).url.searchParams.get('title'), directDebt.title);
  const distinction = { debtIds: ['D-0001'], reason: '独立接口使用不同队列' };
  await assert.rejects(bridge.call(recordTool, { ...directDebt, distinction: { ...distinction, reason: '' } }));
  assert.ok(state.requests.every(request => request.method === 'GET'));
  await bridge.call(recordTool, { ...directDebt, distinction });
  assert.deepEqual(state.requests.at(-1).body.distinction, distinction);
  state.responseProject = 'other-project';
  await assert.rejects(bridge.call(readTool, { view: 'duplicates', title: directDebt.title }));
});

test('rejects unexpected protocol versions, caller overrides, and blank submissions before any write', async t => {
  const { state, bridge } = await fixture(t);
  for (const args of [
    { ...proposal, projectId: 'other-project' },
    { ...proposal, host: 'https://other.example.invalid' },
    { ...proposal, type: 'proposal.accept' },
    { ...proposal, requestId: ' ' },
    { ...proposal, draft: { title: ' ' } },
    { ...proposal, draft: { ...proposal.draft, projectId: 'other-project' } },
    { ...proposal, source: { ...source, ref: ' ' } },
  ]) {
    await assert.rejects(bridge.call(proposeTool, args));
  }
  await bridge.listTools();
  state.protocolVersion = 2;
  await assert.rejects(bridge.call(recordTool, directDebt));
  assert.equal(state.requests.filter(call => call.method === 'POST').length, 0);
});

test('pins read queries and verifies returned records against the project', async t => {
  const { state, bridge } = await fixture(t);
  const result = await bridge.call(readTool, { view: 'debts', q: '导出 & 回归', cursor: 'page-2' });
  assert.equal(result.items[0].id, 'D-0001');
  const read = state.requests.at(-1);
  assert.equal(read.url.pathname, `${basePath}/debts`);
  assert.equal(read.url.searchParams.get('q'), '导出 & 回归');
  assert.equal(read.url.searchParams.get('cursor'), 'page-2');

  state.responseProject = 'other-project';
  await assert.rejects(bridge.call(readTool, { view: 'debts' }));
  await assert.rejects(bridge.call(readTool, { view: 'debt', debtId: 'D-0001' }));
  await assert.rejects(bridge.call(recordTool, directDebt));
});

test('response loss leaves a write uncertain and explicit retry keeps the same request key', async t => {
  const { state, bridge } = await fixture(t);
  state.dropWriteResponse = true;
  await assert.rejects(bridge.call(recordTool, directDebt));
  assert.equal(state.requests.filter(call => call.method === 'POST').length, 1);
  const receipt = await bridge.call(recordTool, directDebt);
  assert.equal(receipt.result.id, 'D-0001');
  assert.equal(receipt.reused, true);
  const writes = state.requests.filter(call => call.method === 'POST');
  assert.deepEqual(writes.map(call => call.body), [0, 1].map(() => ({ type: 'debt.create', ...directDebt })));
  assert.equal(state.committed.size, 1);
  await assert.rejects(bridge.call(recordTool, { ...directDebt, title: '请求键不能复用于其他内容' }), /409/);
});

test('reports an authorization failure without echoing upstream response details or credentials', async t => {
  const { state, bridge } = await fixture(t);
  state.rejectWrite = true;
  await assert.rejects(bridge.call(recordTool, directDebt), error => {
    assert.match(error.message, /403/);
    assert.ok(!error.message.includes(projectKey));
    assert.ok(!error.message.includes('upstream fixture detail'));
    return true;
  });
});

test('real stdio MCP discovers planning tools and returns a scoped proposal receipt', async t => {
  const { state, credentials } = await fixture(t);
  state.permissions = ['read', 'propose'];
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cds-planning-mcp-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, '.git'));
  await fs.mkdir(path.join(root, '.cds'));
  await fs.writeFile(path.join(root, '.cds', 'credentials.json'), JSON.stringify({ version: 1, ...credentials }));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../src/server.mjs', import.meta.url)), '--planning'],
    cwd: root,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'planning-fixture', version: '1' });
  try {
    await client.connect(transport);
    const catalog = await client.listTools();
    assert.deepEqual(catalog.tools.map(tool => tool.name).sort(), [proposeTool, readTool].sort());
    const response = await client.callTool({ name: proposeTool, arguments: proposal });
    assert.notEqual(response.isError, true, response.content[0]?.text);
    const receipt = JSON.parse(response.content[0].text);
    assert.equal(receipt.projectId, projectId);
    assert.equal(receipt.result.id, 'P-0001');
    assert.equal(receipt.reused, false);
  } finally {
    await client.close();
  }
});
