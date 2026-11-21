import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createDesignBridge } from '../src/design-bridge.mjs';

test('design tools read fixed versions and upload Git-bound bytes only with publish access', async t => {
  const projectId = 'fixture-design';
  const projectKey = 'cdsp_fixture_design_key';
  const root = await mkdtemp(path.join(tmpdir(), 'cds-design-mcp-'));
  const bytes = Buffer.from('fixture package bytes');
  await writeFile(path.join(root, 'draft.zip'), bytes);
  const versions = [{ version: 1, title: 'First draft' }, { version: 2, title: 'Second draft' }];
  let write = false;
  let responseProject = projectId;
  const writes = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (request.method === 'POST') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      writes.push({ url, type: request.headers['content-type'], key: request.headers['x-ai-access-key'], bytes: Buffer.concat(chunks) });
    }
    const value = request.method === 'POST' ? { projectId, reused: writes.length > 1,
      result: { type: 'package', designId: 'DSN-fixture', version: 2 } }
      : { projectId: responseProject, permissions: { write }, designs: [], frameworks: [{ projectId, id: 'FW-fixture', versions }] };
    response.writeHead(request.method === 'POST' && writes.length === 1 ? 201 : 200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(value));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const bridge = createDesignBridge({ root, projectId, projectKey, host: `http://127.0.0.1:${server.address().port}` });
  t.after(async () => {
    await bridge.close();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const read = 'cds_design_read';
  const publish = 'cds_design_publish';
  const draft = { designId: 'DSN-fixture', zipPath: 'draft.zip', sourceCommit: 'a'.repeat(40), sourcePath: 'design/draft', requestId: 'fixture-v2' };

  assert.deepEqual((await bridge.listTools()).map(row => row.name), [read]);
  assert.deepEqual(await bridge.call(read, { view: 'framework', id: 'FW-fixture', version: 1 }), { projectId, id: 'FW-fixture', version: versions[0] });
  await assert.rejects(bridge.call(publish, draft), /没有稿件发布权限/);
  assert.equal(writes.length, 0);

  write = true;
  assert.deepEqual((await bridge.listTools()).map(row => row.name), [read, publish]);
  await assert.rejects(bridge.call(publish, { ...draft, sourceCommit: 'main' }));
  await assert.rejects(bridge.call(publish, { ...draft, projectId: 'other' }));
  assert.equal((await bridge.call(publish, draft)).reused, false);
  assert.equal((await bridge.call(publish, draft)).reused, true);
  for (const upload of writes) {
    assert.equal(upload.url.pathname, `/api/projects/${projectId}/design/packages`);
    assert.equal(upload.url.searchParams.get('requireGit'), 'true');
    assert.equal(upload.url.searchParams.get('requestId'), draft.requestId);
    assert.equal(upload.url.searchParams.has('zipPath'), false);
    assert.equal(upload.type, 'application/zip');
    assert.equal(upload.key, projectKey);
    assert.deepEqual(upload.bytes, bytes);
  }
  responseProject = 'other';
  await assert.rejects(bridge.call(read, { view: 'frameworks' }), /当前项目/);
  assert.equal(writes.length, 2);
});
