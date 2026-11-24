import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createDtsBridge, DTS_TOOLS } from '../src/dts-bridge.mjs';
let server, host, root; const requests = []; let version = 1, wrongProject = false, foreignService = false;
const projectId = 'p', key = 'cdsp_fixture_dts_key';
before(async () => {
  server = http.createServer(async (req, res) => {
    let raw = ''; for await (const b of req) raw += b;
    const body = raw ? JSON.parse(raw) : undefined; const url = new URL(req.url, 'http://localhost'); requests.push({ method: req.method, url, body, key: req.headers['x-ai-access-key'] });
    res.setHeader('content-type', 'application/json');
    if (req.headers['x-ai-access-key'] !== key || url.searchParams.get('projectId') !== projectId) { res.writeHead(403); res.end('{}'); return; }
    const resource = { projectId: wrongProject ? 'foreign' : projectId, id: 'run', plan: { id: 'plan' }, status: 'running' };
    const result = url.pathname.endsWith('/capabilities') ? { projectId, protocolVersion: version, tools: DTS_TOOLS.map(t => t.name) }
      : url.pathname.endsWith('/connections') ? { connections: [{ ...resource, id: 'source' }], services: [{ id: 'managed', projectId: foreignService ? 'foreign' : projectId }] }
      : url.pathname.endsWith('/plans') ? { plan: { ...resource, id: 'plan', insertCount: 1 } }
      : url.pathname.endsWith('/runs') && req.method === 'GET' ? { runs: [resource] }
      : url.pathname.endsWith('/policies') ? req.method === 'GET' ? { policies: [] } : { policy: resource }
      : { run: resource };
    res.end(JSON.stringify(result));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); host = `http://127.0.0.1:${server.address().port}`;
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'cds-dts-mcp-')); await fs.mkdir(path.join(root, '.git')); await fs.mkdir(path.join(root, '.cds'));
  await fs.writeFile(path.join(root, '.cds/credentials.json'), JSON.stringify({ version: 1, host, projectId, projectKey: key }));
});
after(async () => { await new Promise(r => server.close(r)); await fs.rm(root, { recursive: true, force: true }); });
const bridge = () => createDtsBridge({ host, projectId, projectKey: key });
test('DTS MCP preserves project scope, native comparison and stable idempotency', async () => {
  const b = bridge(); try {
    await b.call('cds_dts_plan', { sourceId: 'source', targetId: 'target' });
    const result = await b.call('cds_dts_start', { planId: 'plan', idempotencyKey: 'stable-operation' }); assert.equal(result.run.id, 'run');
    const call = requests.at(-1); assert.equal(call.body.projectId, projectId); assert.equal(call.body.idempotencyKey, 'stable-operation'); assert.equal(call.key, key);
  } finally { await b.close(); }
});
test('rejects caller-supplied host/project overrides before any request', async () => {
  const b = bridge(), count = requests.length; try { await assert.rejects(b.call('cds_dts_start', { planId: 'plan', idempotencyKey: 'same', host: 'https://foreign' })); assert.equal(requests.length, count); }
  finally { await b.close(); }
});
test('a changed protocol invalidates previously advertised write tools', async () => {
  const b = bridge(); try { await b.listTools(); version = 2; const before = requests.filter(r => r.method === 'POST').length;
    await assert.rejects(b.call('cds_dts_start', { planId: 'plan', idempotencyKey: 'same' }), /不兼容/); assert.equal(requests.filter(r => r.method === 'POST').length, before);
  } finally { version = 1; await b.close(); }
});
test('foreign task cannot be cancelled through a misleading read response', async () => {
  const b = bridge(); try { wrongProject = true; const before = requests.filter(r => r.method === 'POST').length;
    await assert.rejects(b.call('cds_dts_control', { runId: 'run', action: 'cancel' }), /其他项目/); assert.equal(requests.filter(r => r.method === 'POST').length, before);
  } finally { wrongProject = false; await b.close(); }
});
test('real stdio MCP discovers and calls DTS using existing project credentials', async () => {
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/server.mjs', import.meta.url)), '--dts'], cwd: root, stderr: 'pipe' });
  const client = new Client({ name: 'dts-drill', version: '1' });
  try { await client.connect(transport); const catalog = await client.listTools(); assert.equal(catalog.tools.length, 6);
    const result = await client.callTool({ name: 'cds_dts_connections', arguments: {} }); assert.equal(result.isError, undefined); assert.equal(JSON.parse(result.content[0].text).connections[0].projectId, projectId);
  } finally { await client.close(); }
});

test('managed service discovery refuses resources from another project', async () => {
  const b = bridge(); try { foreignService = true; await assert.rejects(b.call('cds_dts_connections', {}), /其他项目/); }
  finally { foreignService = false; await b.close(); }
});
