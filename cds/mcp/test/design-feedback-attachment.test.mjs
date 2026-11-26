import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createDesignBridge } from '../src/design-bridge.mjs';

test('feedback-only MCP sends reference PNG to the dedicated attachment route', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cds-feedback-mcp-v2-'));
  const projectId = 'fixture';
  const route = '/api/projects/fixture/design';
  const authorKey = 'cdsp_synthetic_feedback';
  const readKey = 'cdsp_synthetic_reader';
  const writeLog = [];
  let wrongReceipt = false;
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/17sAAAAASUVORK5CYII=', 'base64');
  await writeFile(join(root, 'sample.png'), png);
  const server = createServer(async (req, res) => {
    const feedback = req.headers['x-ai-access-key'] === authorKey;
    const current = { projectId, permissions: { write: false, feedback }, frameworks: [], designs: [] };
    let output = req.url === route + '/intake' ? { ...current, protocolVersion: 1 } : current;
    let status = 200;
    if (req.method === 'POST') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const parsed = JSON.parse(Buffer.concat(chunks).toString());
      writeLog.push({ path: req.url, body: parsed });
      if (req.url !== route + '/feedback/attachments' || !feedback) {
        status = 403;
        output = { error: 'unexpected_synthetic_route' };
      } else {
        status = 201;
        output = { projectId, reused: false, result: { type: 'feedback.attach', designId: 'DSN-fixture',
          id: 'FDB-fixture', version: wrongReceipt ? 1 : 2, artifactId: 'ASSET-png' } };
      }
    }
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(output));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const host = `http://127.0.0.1:${server.address().port}`;
  const writer = createDesignBridge({ projectId, root, host, projectKey: authorKey });
  const reader = createDesignBridge({ projectId, root, host, projectKey: readKey });
  t.after(async () => {
    await Promise.all([writer.close(), reader.close()]);
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });

  const tool = 'cds_design_feedback';
  const args = { type: 'feedback.attach', requestId: 'synthetic-evidence', designId: 'DSN-fixture',
    feedbackId: 'FDB-fixture', version: 2, title: 'Proof', screenId: 'sample', slot: 'phone-dark', imagePath: 'sample.png' };
  assert.deepEqual((await writer.listTools()).map(item => item.name), ['cds_design_read', tool]);
  assert.deepEqual((await reader.listTools()).map(item => item.name), ['cds_design_read']);
  await assert.rejects(reader.call(tool, args), /没有设计反馈权限/);
  assert.equal(writeLog.length, 0);

  const receipt = await writer.call(tool, args);
  assert.equal(receipt.result.version, 2);
  assert.equal(receipt.result.artifactId, 'ASSET-png');
  assert.equal(writeLog[0].path, route + '/feedback/attachments');
  const sent = writeLog[0].body;
  assert.equal(sent.requestId, args.requestId);
  assert.equal(sent.version, 2);
  assert.equal(sent.screenId, 'sample');
  assert.equal(sent.slot, 'phone-dark');
  assert.equal(Object.hasOwn(sent, 'imagePath'), false);
  assert.equal(sent.image, `data:image/png;base64,${png.toString('base64')}`);
  wrongReceipt = true;
  await assert.rejects(writer.call(tool, args), /反馈回执/);
});
