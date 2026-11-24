import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createDesignBridge } from '../src/design-bridge.mjs';

const publish = 'cds_design_publish';
const read = 'cds_design_read';

async function fixture(t) {
  const box = await mkdtemp(path.join(tmpdir(), 'bridge-fixture-'));
  const root = path.join(box, 'repo');
  await mkdir(root);
  const bytes = Buffer.from('fixture package bytes');
  await writeFile(path.join(root, 'draft.zip'), bytes);
  await writeFile(path.join(box, 'outside.zip'), Buffer.from('outside fixture'));
  await symlink(path.join(box, 'outside.zip'), path.join(root, 'escape.zip'));
  const projectId = 'private-bridge-fixture';
  const writeKey = 'cdsp_private_publish_fixture';
  const readKey = 'cdsp_private_read_fixture';
  const designId = 'DSN-fixture';
  const route = '/api/projects/' + projectId + '/design';
  const writes = [];
  const receipts = new Map();
  const versions = [{ version: 4, title: 'Fixture', sourceCommit: 'a'.repeat(40),
    sourceVerification: 'git', sourcePath: 'design/reports' }];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const key = request.headers['x-ai-access-key'];
    const write = key === writeKey;
    const latest = versions.at(-1);
    let status = 200;
    let value;
    if (request.method === 'GET' && url.pathname === route && [readKey, writeKey].includes(key)) {
      value = { projectId, permissions: { write }, frameworks: [], designs: [{ projectId, id: designId, versions }] };
    } else if (request.method === 'GET' && url.pathname === route + '/intake' && [readKey, writeKey].includes(key)) {
      value = { protocolVersion: 1, projectId, permissions: { write },
        designs: [{ designId, designKey: 'reports/summary', latestVersion: latest.version, sourceCommit: latest.sourceCommit,
          sourcePaths: ['design/reports'], canRevise: write }] };
    } else if (request.method === 'POST' && url.pathname === route + '/packages' && write) {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const query = Object.fromEntries(url.searchParams);
      writes.push({ query, body, key, contentType: request.headers['content-type'] });
      const prior = receipts.get(query.requestId);
      if (prior) {
        value = { ...prior, reused: true };
      } else if (Number(query.expectedVersion) !== latest.version) {
        status = 409;
        value = { error: 'design_intake_conflict' };
      } else {
        status = 201;
        const sourceVerification = query.sourceMode === 'private' ? 'private-upload' : 'git';
        const version = { version: latest.version + 1, title: 'Fixture', sourceCommit: query.sourceCommit,
          sourcePath: query.sourcePath, sourceVerification };
        versions.push(version);
        value = { projectId, reused: false, result: { type: 'package', designId, version: version.version } };
        receipts.set(query.requestId, value);
      }
    } else {
      status = 403;
      value = { error: 'fixture_unauthorized' };
    }
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(value));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const host = 'http://127.0.0.1:' + server.address().port;
  const writer = createDesignBridge({ root, host, projectId, projectKey: writeKey });
  const reader = createDesignBridge({ root, host, projectId, projectKey: readKey });
  t.after(async () => {
    await Promise.all([writer.close(), reader.close()]);
    await new Promise(resolve => server.close(resolve));
    await rm(box, { recursive: true, force: true });
  });
  const draft = { zipPath: 'draft.zip', sourceCommit: 'b'.repeat(40), sourcePath: 'design/reports', requestId: 'private-fixture-v5',
    intent: 'revise', designId, designKey: 'reports/summary', expectedVersion: 4 };
  return { writer, reader, draft, bytes, writes, projectId, writeKey };
}

test('MCP private revision preserves scope, baseline, controlled bytes and replay, then reads its provenance', async t => {
  const { writer, reader, draft, bytes, writes, projectId, writeKey } = await fixture(t);
  const input = { ...draft, sourceMode: 'private' };
  assert.deepEqual((await reader.listTools()).map(tool => tool.name), [read]);
  await assert.rejects(reader.call(publish, input));
  await assert.rejects(writer.call(publish, { ...input, zipPath: 'escape.zip' }));
  await assert.rejects(writer.call(publish, { ...input, projectId: 'another-fixture' }));
  await assert.rejects(writer.call(publish, { ...input, sourceMode: 'remote' }));
  await assert.rejects(writer.call(publish, { ...input, sourcePath: '.' }));
  await assert.rejects(writer.call(publish, { ...input, intent: undefined }));
  assert.equal(writes.length, 0);

  const first = await writer.call(publish, input);
  const replay = await writer.call(publish, input);
  assert.deepEqual(first, { projectId, reused: false, result: { type: 'package', designId: draft.designId, version: 5 } });
  assert.deepEqual(replay, { ...first, reused: true });
  const { zipPath: _zipPath, ...query } = input;
  const transmitted = Object.fromEntries(Object.entries(query).map(([key, value]) => [key, String(value)]));
  assert.deepEqual(writes, Array.from({ length: 2 }, () => ({ query: transmitted, body: bytes, key: writeKey, contentType: 'application/zip' })));
  const delivery = await reader.call(read, { view: 'delivery', id: draft.designId, version: 5 });
  assert.equal(delivery.sourceVerification, 'private-upload');
  assert.equal(delivery.sourceCommit, draft.sourceCommit);
  assert.equal(delivery.sourcePath, draft.sourcePath);
  const old = await reader.call(read, { view: 'design', id: draft.designId, version: 4 });
  assert.equal(old.version.sourceVerification, 'git');
});

test('MCP Git default still requests Git verification with intact revision intent', async t => {
  const { writer, draft, bytes, writes } = await fixture(t);
  const outcome = await writer.call(publish, draft);
  assert.equal(outcome.result.version, 5);
  assert.deepEqual(writes[0].body, bytes);
  assert.equal(writes[0].query.requireGit, 'true');
  assert.equal(writes[0].query.sourceMode, undefined);
  assert.equal(writes[0].query.expectedVersion, '4');
});
