import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('real stdio design MCP keeps capture and independent review within their own scopes', async t => {
  const tool = 'cds_design_acceptance';
  const projectId = 'program-proof-fixture';
  const projectKey = 'cdsp_program_proof_fixture';
  const route = `/api/projects/${projectId}/design`;
  const target = { designId: 'DSN-fixture', runId: 'RUN-fixture', screenId: 'members', slot: 'phone-dark' };
  const commands = [];
  let permissions = { write: true, visual: false, programRecheck: true };
  let replyProject = projectId;
  let replyFields = {};
  const server = createServer(async (request, response) => {
    const endpoint = new URL(request.url, 'http://127.0.0.1').pathname;
    const send = (status, data) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(data));
    };
    if (request.headers['x-ai-access-key'] !== projectKey) return send(401, { error: 'fixture_key' });
    if (request.method === 'GET' && endpoint === route) return send(200, { projectId, permissions, frameworks: [], designs: [] });
    if (request.method !== 'POST' || ![route + '/acceptance/recheck', route + '/commands'].includes(endpoint)) {
      return send(404, { error: 'fixture_route' });
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    const reused = commands.some(command => command.body.requestId === body.requestId);
    commands.push({ path: endpoint, body });
    const { requestId: _requestId, ...result } = body;
    send(reused ? 200 : 201, { projectId: replyProject, reused, result: { ...result, version: 22, ...replyFields } });
  });
  const root = await mkdtemp(path.join(tmpdir(), 'cds-design-program-mcp-'));
  const client = new Client({ name: 'design-program-fixture', version: '1' });
  t.after(async () => {
    await client.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  await mkdir(path.join(root, '.git'));
  await mkdir(path.join(root, '.cds'));
  const host = `http://127.0.0.1:${server.address().port}`;
  await writeFile(path.join(root, '.cds', 'credentials.json'), JSON.stringify({ version: 1, host, projectId, projectKey }), { mode: 0o600 });
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: [fileURLToPath(new URL('../src/server.mjs', import.meta.url)), '--design'],
    cwd: root, stderr: 'pipe',
  }));
  async function call(input) {
    const response = await client.callTool({ name: tool, arguments: input });
    if (response.isError) throw new Error(response.content[0].text);
    return JSON.parse(response.content[0].text);
  }
  const capture = { ...target, type: 'acceptance.capture', requestId: 'capture-key' };
  const recheck = { ...target, type: 'acceptance.recheck', requestId: 'recheck-key' };

  assert((await client.listTools()).tools.some(item => item.name === tool));
  await assert.rejects(call(capture), /权限/);
  await assert.rejects(call({ ...recheck, commit: 'a'.repeat(40) }), /参数无效/);
  await assert.rejects(call({ ...recheck, projectId: 'foreign-fixture' }), /参数无效/);
  assert.equal(commands.length, 0);

  for (const reused of [false, true]) {
    assert.deepEqual(await call(recheck), { projectId, reused,
      result: { ...target, type: recheck.type, version: 22 } });
  }
  const sentRecheck = { path: route + '/acceptance/recheck', body: recheck };
  assert.deepEqual(commands, [sentRecheck, sentRecheck]);

  permissions = { write: true, visual: true, programRecheck: false };
  assert.deepEqual(await call(capture), { projectId, reused: false,
    result: { ...target, type: capture.type, version: 22 } });
  assert.deepEqual(commands.at(-1), { path: route + '/commands', body: capture });
  for (const patch of [{ runId: 'RUN-other' }, { screenId: 'other-screen' }, { slot: 'desktop-light' }]) {
    replyFields = patch;
    await assert.rejects(call(capture), /回执/);
  }
  replyFields = {};
  replyProject = 'foreign-fixture';
  await assert.rejects(call(recheck), /回执/);

  permissions = { write: false, visual: false, programRecheck: false };
  assert(!(await client.listTools()).tools.some(item => item.name === tool));
  const posted = commands.length;
  await assert.rejects(call(recheck), /权限/);
  assert.equal(commands.length, posted);
});
