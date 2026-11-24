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
  const demo = [{ screen: 'members', title: '打开成员', tip: '先查看成员清单。' }];
  const videos = [{ page: 'accept', file: 'videos/acceptance.mp4', title: '验收演示', artifactId: 'artifact-fixture',
    chapters: [{ method: 'compare', title: '对照图', start: 0 }] }];
  const methodSettings = { flow: { enabled: false, by: 'fixture-reviewer', at: '2026-11-25T00:00:00.000Z',
    reason: '合成流程环境正在恢复。' } };
  const versions = [{ version: 1, title: 'First draft' }, { version: 2, title: 'Second draft', demo, videos }];
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
      : { projectId: responseProject, permissions: { write },
        designs: [{ projectId, id: 'DSN-fixture', versions, methodSettings: { 2: methodSettings } }],
        frameworks: [{ projectId, id: 'FW-fixture', versions }] };
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
  const delivery = await bridge.call(read, { view: 'delivery', id: draft.designId, version: 2 });
  assert.deepEqual({ demo: delivery.demo, videos: delivery.videos, methodSettings: delivery.methodSettings },
    { demo, videos, methodSettings });
  const former = await bridge.call(read, { view: 'delivery', id: draft.designId, version: 1 });
  for (const key of ['demo', 'videos', 'methodSettings']) assert.equal(Object.hasOwn(former, key), false);
  await assert.rejects(bridge.call(publish, draft), /没有稿件发布权限/);
  assert.equal(writes.length, 0);

  write = true;
  assert.deepEqual((await bridge.listTools()).map(row => row.name), [read, publish]);
  await assert.rejects(bridge.call(read, { view: 'framework', id: 'FW-fixture', version: 99 }), /frameworks.*版本/);
  await assert.rejects(bridge.call(publish, { ...draft, sourceCommit: 'main' }), /sourceCommit/);
  await assert.rejects(bridge.call(publish, { ...draft, designId: 'DSN-unknown', zipPath: 'missing.zip' }), /designs.*原稿.*基线/);
  assert.equal(writes.length, 0);
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

async function intakeFixture(t) {
  const projectId = 'fixture-design-intake';
  const readKey = 'cdsp_fixture_intake_read';
  const writeKey = 'cdsp_fixture_intake_publish';
  const root = await mkdtemp(path.join(tmpdir(), 'cds-design-intake-'));
  const bytes = Buffer.from('fixture intake zip');
  await writeFile(path.join(root, 'draft.zip'), bytes);
  const route = `/api/projects/${projectId}/design`;
  const calls = [];
  const writes = [];
  const stored = { designId: 'DSN-existing', designKey: 'accounts/summary', latestVersion: 4,
    sourceCommit: 'a'.repeat(40), sourcePaths: ['design/accounts', 'design/moved-accounts'] };
  const former = { designId: 'DSN-legacy', latestVersion: 2, sourceCommit: 'b'.repeat(40), sourcePaths: ['design/profile'] };
  let intakeProject = projectId;
  let protocolVersion = 1;
  const intake = write => ({ protocolVersion, projectId: intakeProject, permissions: { write },
    designs: [{ ...stored, canRevise: write }, { ...former, canRevise: false }] });
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const key = request.headers['x-ai-access-key'];
    const write = key === writeKey;
    calls.push({ method: request.method, path: url.pathname, key });
    let value;
    let status = 200;
    if (request.method === 'GET' && url.pathname === `${route}/intake`) {
      value = intake(write);
    } else if (request.method === 'GET' && url.pathname === route) {
      value = { projectId, permissions: { write }, frameworks: [], designs: [stored, former].map(row => ({ projectId, id: row.designId,
        versions: [{ version: row.latestVersion, title: row.designId, sourceCommit: row.sourceCommit }] })) };
    } else if (request.method === 'POST' && url.pathname === `${route}/packages` && write) {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      writes.push({ query: url.searchParams, bytes: Buffer.concat(chunks), header: request.headers['content-type'], key });
      const intent = url.searchParams.get('intent');
      value = { projectId, reused: false, result: { type: 'package', designId: intent === 'create' ? 'DSN-created' : stored.designId,
        version: intent === 'create' ? 1 : 5 } };
      status = 201;
      if (url.searchParams.get('requestId') === 'intake-fixture-conflict') {
        status = 409;
        value = { error: 'design_intake_conflict', message: '本地夹具的私有上游明细' };
      }
      if (url.searchParams.get('requestId') === 'intake-fixture-gate') {
        status = 400;
        value = { error: 'G-07', message: '本地夹具的私有上游明细' };
      }
    } else {
      status = write || request.method === 'GET' ? 404 : 403;
      value = { error: 'fixture_route_error' };
    }
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(value));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const host = `http://127.0.0.1:${server.address().port}`;
  const reader = createDesignBridge({ root, projectId, projectKey: readKey, host });
  const publisher = createDesignBridge({ root, projectId, projectKey: writeKey, host });
  t.after(async () => {
    await Promise.all([reader.close(), publisher.close()]);
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const base = { zipPath: 'draft.zip', sourceCommit: 'c'.repeat(40), sourcePath: 'design/accounts', requestId: 'intake-fixture-release' };
  return { projectId, route, calls, writes, stored, bytes, writeKey, readKey, intake, reader, publisher, base,
    setIntakeProject: value => { intakeProject = value; }, setProtocolVersion: value => { protocolVersion = value; } };
}

test('intake reads the authoritative project endpoint and scopes the result to the bound credential', async t => {
  const { projectId, route, calls, writes, readKey, writeKey, reader, publisher, intake, base, setIntakeProject, setProtocolVersion } = await intakeFixture(t);
  const tool = 'cds_design_read';
  assert.deepEqual((await reader.listTools()).map(row => row.name), [tool]);
  assert.deepEqual((await publisher.listTools()).map(row => row.name), [tool, 'cds_design_publish']);
  for (const [bridge, key, write] of [[reader, readKey, false], [publisher, writeKey, true]]) {
    const count = calls.length;
    assert.deepEqual(await bridge.call(tool, { view: 'intake' }), intake(write));
    assert(calls.slice(count).some(call => call.method === 'GET' && call.path === `${route}/intake` && call.key === key));
  }
  const fixed = await reader.call(tool, { view: 'design', id: 'DSN-existing', version: 4 });
  assert.equal(fixed.version.version, 4);
  await assert.rejects(reader.call('cds_design_publish', { ...base, intent: 'create', designKey: 'reports/detail' }));
  assert(calls.every(call => call.method === 'GET'));
  setIntakeProject('foreign-project');
  await assert.rejects(reader.call(tool, { view: 'intake' }));
  setIntakeProject(projectId);
  setProtocolVersion(2);
  await assert.rejects(reader.call(tool, { view: 'intake' }));
  assert.equal(writes.length, 0);
});

test('publish forwards create and revision identity through the Git-bound package route', async t => {
  const { writes, stored, bytes, writeKey, publisher, base } = await intakeFixture(t);
  const tool = 'cds_design_publish';
  const create = { ...base, intent: 'create', designKey: 'reports/detail', sourcePath: 'design/reports' };
  const revise = { ...base, requestId: 'intake-fixture-revision', intent: 'revise', designId: stored.designId,
    designKey: stored.designKey, expectedVersion: stored.latestVersion };
  const unkeyedRevision = { ...base, requestId: 'intake-fixture-unkeyed-revision', intent: 'revise', designId: stored.designId,
    expectedVersion: stored.latestVersion };
  for (const invalid of [
    { ...create, designId: stored.designId }, { ...create, expectedVersion: 1 }, { ...create, designKey: undefined },
    { ...create, designKey: 'Reports/detail' }, { ...create, designKey: 'reports/detail/variant' },
    { ...revise, expectedVersion: undefined }, { ...revise, expectedVersion: 0 }, { ...revise, designId: undefined },
  ]) await assert.rejects(publisher.call(tool, invalid));
  assert.equal(writes.length, 0);

  assert.deepEqual((await publisher.call(tool, create)).result, { type: 'package', designId: 'DSN-created', version: 1 });
  assert.deepEqual((await publisher.call(tool, revise)).result, { type: 'package', designId: stored.designId, version: 5 });
  assert.deepEqual((await publisher.call(tool, unkeyedRevision)).result, { type: 'package', designId: stored.designId, version: 5 });
  assert.equal(writes.length, 3);
  for (const [index, upload] of writes.entries()) {
    const { zipPath: _zipPath, ...fields } = [create, revise, unkeyedRevision][index];
    const query = new URLSearchParams({ requireGit: 'true' });
    for (const [key, value] of Object.entries(fields)) if (value !== undefined) query.set(key, String(value));
    assert.deepEqual(Object.fromEntries(upload.query), Object.fromEntries(query));
    assert.deepEqual(upload.bytes, bytes);
    assert.equal(upload.header, 'application/zip');
    assert.equal(upload.key, writeKey);
  }
});


test('intake conflicts direct the agent to the authoritative baseline without echoing server details', async t => {
  const { publisher, base, stored } = await intakeFixture(t);
  await assert.rejects(publisher.call('cds_design_publish', { ...base, intent: 'revise', designId: stored.designId,
    expectedVersion: 3, requestId: 'intake-fixture-conflict' }), error => {
    assert.match(error.message, /intake.*最新版本/);
    assert.doesNotMatch(error.message, /私有上游明细/);
    return true;
  });
});

test('publish preserves an actionable gate code without echoing archived contents', async t => {
  const { publisher, base, stored } = await intakeFixture(t);
  await assert.rejects(publisher.call('cds_design_publish', { ...base, intent: 'revise', designId: stored.designId,
    expectedVersion: stored.latestVersion, requestId: 'intake-fixture-gate' }), error => {
    assert.match(error.message, /G-07/);
    assert.doesNotMatch(error.message, /私有上游明细/);
    return true;
  });
});

test('visual acceptance is limited to the bound project and validates the exact returned row', async t => {
  const projectId = 'fixture-visual';
  const designId = 'DSN-visual';
  const runId = 'RUN-visual';
  const projectKey = 'cdsp_fixture_visual';
  const root = await mkdtemp(path.join(tmpdir(), 'cds-design-visual-'));
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR1sAAAAASUVORK5CYII=', 'base64');
  await writeFile(path.join(root, 'implementation.png'), bytes);
  const route = `/api/projects/${projectId}/design`;
  const run = { id: runId, version: 9, pullRequest: 42, commit: 'a'.repeat(40), createdAt: '2026-11-23T00:00:00.000Z',
    verdict: 'needs_evidence', cells: [], previewUrl: 'https://preview.example.test/', issues: {} };
  const command = { type: 'acceptance.visual', designId, requestId: 'visual-fixture', runId, commit: run.commit,
    screenId: 'members', slot: 'desktop-light', checks: { 'V-01': { status: 'passed', evidence: '页头、标签、主体、浮层和底部依次核对' } },
    imagePath: 'implementation.png', measured: { width: 1280, height: 800, theme: 'light', path: '/members' } };
  let canRecord = false;
  let returnedSlot = command.slot;
  const writes = [];
  const bridge = createDesignBridge({ root, projectId, projectKey, host: 'https://cds.example.test' }, {
    fetchImpl: async (url, options) => {
      assert.equal(options.headers['X-AI-Access-Key'], projectKey);
      const parsed = new URL(url);
      if (options.method === 'GET') {
        assert.equal(parsed.pathname, route);
        return Response.json({ projectId, permissions: { write: true, visual: canRecord }, frameworks: [],
          designs: [{ projectId, id: designId, versions: [{ version: 9 }], runs: [run] }] });
      }
      assert.equal(options.method, 'POST');
      assert.equal(parsed.pathname, `${route}/commands`);
      const body = JSON.parse(options.body);
      writes.push(body);
      return Response.json({ projectId, reused: writes.length > 1,
        result: { type: command.type, designId, runId, version: 9, screenId: command.screenId, slot: returnedSlot } });
    },
  });
  t.after(async () => {
    await bridge.close();
    await rm(root, { recursive: true, force: true });
  });

  const tool = 'cds_design_acceptance';
  assert(!(await bridge.listTools()).some(row => row.name === tool));
  await assert.rejects(bridge.call(tool, command), /权限|授权/);
  assert.equal(writes.length, 0);

  canRecord = true;
  assert((await bridge.listTools()).some(row => row.name === tool));
  assert.deepEqual(await bridge.call('cds_design_read', { view: 'run', id: designId, runId }), { projectId, id: designId, run });
  assert.deepEqual(await bridge.call('cds_design_read', { view: 'run', id: designId }), { projectId, id: designId, run });
  await assert.rejects(bridge.call('cds_design_read', { view: 'run', id: designId, runId: 'RUN-other' }));
  for (const invalid of [
    { ...command, projectId: 'another-project' },
    { ...command, checks: { 'V-11': { status: 'passed', evidence: 'Fixture check' } } },
    { ...command, imagePath: '../outside.png' },
  ]) await assert.rejects(bridge.call(tool, invalid));
  assert.equal(writes.length, 0);

  const { imagePath: _localOnly, ...fields } = command;
  const expectedBody = { ...fields, image: `data:image/png;base64,${bytes.toString('base64')}` };
  assert.equal((await bridge.call(tool, command)).reused, false);
  assert.equal((await bridge.call(tool, command)).reused, true);
  assert.deepEqual(writes, [expectedBody, expectedBody]);
  returnedSlot = 'phone-dark';
  await assert.rejects(bridge.call(tool, command), /回执/);
});

test('flow and smoke records share project-scoped acceptance tools and match their returned identifiers', async t => {
  const projectId = 'fixture-execution';
  const projectKey = 'cdsp_fixture_execution';
  const designId = 'DSN-execution';
  const runId = 'RUN-execution';
  const commit = 'b'.repeat(40);
  const route = `/api/projects/${projectId}/design`;
  const flow = { id: 'new-member', title: '新成员流程', dimension: 'correctness', role: '成员',
    steps: [{ action: '打开本项目的成员页', expected: '显示成员列表', actual: '显示 3 个夹具成员', status: 'passed' }] };
  const smoke = { id: 'members-page', title: '成员页冒烟', dimension: 'experience', target: 'page', path: '/members/',
    expected: '显示页面标题', actual: '显示成员管理', status: 'passed' };
  const recordFlow = { type: 'acceptance.flow', requestId: 'flow-fixture', designId, runId, commit, flow };
  const recordSmoke = { type: 'acceptance.smoke', requestId: 'smoke-fixture', designId, runId, commit, smoke };
  const run = { id: runId, version: 11, commit, cells: [] };
  const writes = [];
  let canRecord = false;
  let overrideReceipt = {};
  const bridge = createDesignBridge({ projectId, projectKey, host: 'https://cds.example.test' }, {
    fetchImpl: async (url, options) => {
      assert.equal(options.headers['X-AI-Access-Key'], projectKey);
      const parsed = new URL(url);
      if (options.method === 'GET') {
        assert.equal(parsed.pathname, route);
        return Response.json({ projectId, permissions: { write: true, visual: canRecord }, frameworks: [],
          designs: [{ projectId, id: designId, versions: [{ version: 11 }], runs: [run] }] });
      }
      assert.equal(options.method, 'POST');
      assert.equal(parsed.pathname, `${route}/commands`);
      const body = JSON.parse(options.body);
      writes.push(body);
      if (body.flow) run.flows = [body.flow];
      if (body.smoke) run.smoke = [body.smoke];
      return Response.json({ projectId, reused: false,
        result: { type: body.type, designId, runId, version: run.version, id: (body.flow ?? body.smoke).id, ...overrideReceipt } });
    },
  });
  t.after(async () => { await bridge.close(); });

  const tool = 'cds_design_acceptance';
  assert(!(await bridge.listTools()).some(row => row.name === tool));
  await assert.rejects(bridge.call(tool, recordFlow), /权限|授权/);
  await assert.rejects(bridge.call(tool, recordSmoke), /权限|授权/);
  canRecord = true;
  assert((await bridge.listTools()).some(row => row.name === tool));
  for (const invalid of [
    { ...recordFlow, projectId: 'another-project' },
    { ...recordFlow, flow: { ...flow, dimension: 'other' } },
    { ...recordFlow, flow: { ...flow, steps: [{ ...flow.steps[0], status: 'unverified' }] } },
    { ...recordSmoke, smoke: { ...smoke, target: 'browser' } },
    { ...recordSmoke, smoke: { ...smoke, path: 'https://legacy.example.test/' } },
    { ...recordSmoke, flow },
  ]) await assert.rejects(bridge.call(tool, invalid));
  assert.equal(writes.length, 0);

  assert.equal((await bridge.call(tool, recordFlow)).result.id, flow.id);
  assert.equal((await bridge.call(tool, recordSmoke)).result.id, smoke.id);
  assert.deepEqual(writes, [recordFlow, recordSmoke]);
  assert.deepEqual(await bridge.call('cds_design_read', { view: 'run', id: designId, runId }), {
    projectId, id: designId, run: { id: runId, version: 11, commit, cells: [], flows: [flow], smoke: [smoke] },
  });
  overrideReceipt = { id: 'another-check' };
  await assert.rejects(bridge.call(tool, recordFlow), /回执/);
  await assert.rejects(bridge.call(tool, recordSmoke), /回执/);
  overrideReceipt = { runId: 'RUN-another' };
  await assert.rejects(bridge.call(tool, recordSmoke), /回执/);
});
