import assert from 'node:assert/strict';
import test from 'node:test';
import { createDesignBridge } from '../src/design-bridge.mjs';

test('version diff reads the two requested versions through the bound project API', async t => {
  const projectId = 'fixture-design';
  const designId = 'DSN-fixture';
  const projectKey = 'cdsp_fixture_read_only';
  const calls = [];
  const changes = { added: [], removed: [], changed: [] };
  const diff = { acceptance: changes, files: changes, screens: { ...changes, added: [{ id: 'members' }] } };
  let alterReceipt = {};
  const bridge = createDesignBridge({ root: process.cwd(), projectId, projectKey, host: 'https://cds.example.test' }, {
    fetchImpl: async (url, request) => {
      const parsed = new URL(url);
      calls.push({ url: parsed, options: request });
      return Response.json({ projectId, designId, fromVersion: Number(parsed.searchParams.get('from')),
        toVersion: Number(parsed.searchParams.get('to')), ...diff, ...alterReceipt });
    },
  });
  t.after(() => bridge.close());
  const input = { view: 'diff', id: designId, fromVersion: 11, toVersion: 17 };
  assert.deepEqual(await bridge.call('cds_design_read', input), {
    projectId, designId, fromVersion: 11, toVersion: 17, ...diff,
  });
  await bridge.call('cds_design_read', { ...input, fromVersion: 17, toVersion: 11 });
  assert.equal(calls.length, 2);
  for (const [index, call] of calls.entries()) {
    assert.equal(call.options.method, 'GET');
    assert.equal(call.options.body, undefined);
    assert.equal(call.options.headers['X-AI-Access-Key'], projectKey);
    assert.equal(call.url.pathname, `/api/projects/${projectId}/design/diff`);
    assert.deepEqual(Object.fromEntries(call.url.searchParams), {
      designId, from: index === 0 ? '11' : '17', to: index === 0 ? '17' : '11',
    });
  }
  for (const invalid of [{ ...input, fromVersion: undefined }, { ...input, toVersion: 0 },
    { ...input, toVersion: 'latest' }, { ...input, fromVersion: 11.5 }, { ...input, projectId: 'other' }]) {
    await assert.rejects(bridge.call('cds_design_read', invalid), /参数无效/);
  }
  assert.equal(calls.length, 2);
  for (const invalid of [{ projectId: 'other' }, { designId: 'DSN-other' }, { fromVersion: 12 }, { toVersion: 18 }, { files: {} }]) {
    alterReceipt = invalid;
    await assert.rejects(bridge.call('cds_design_read', input), /项目|稿件|版本/);
  }
});

test('design reads preserve server-owned implementation and locked target state with historical versions', async t => {
  const projectId = 'fixture-design';
  const designId = 'DSN-fixture';
  const versions = [{ version: 11, title: 'Former' }, { version: 17, title: 'Locked' }, { version: 18, title: 'Latest' }];
  const state = { baselineVersion: 17, implementedVersion: 11, versionGap: { direction: 'behind', count: 6 },
    upgrade: { id: 'UPG-fixture', fromVersion: 11, targetVersion: 17, status: 'active' } };
  const bridge = createDesignBridge({ root: process.cwd(), projectId, projectKey: 'cdsp_fixture_read_only', host: 'https://cds.example.test' }, {
    fetchImpl: async () => Response.json({ projectId, permissions: { write: false }, frameworks: [], designs: [{
      projectId, id: designId, versions, frozen: state.baselineVersion, implementedVersion: state.implementedVersion,
      versionGap: state.versionGap, upgrade: state.upgrade,
    }] }),
  });
  t.after(() => bridge.close());
  const draft = await bridge.call('cds_design_read', { view: 'design', id: designId, version: 17 });
  assert.deepEqual(draft, { projectId, id: designId, version: versions[1], ...state });
  const listing = await bridge.call('cds_design_read', { view: 'designs' });
  assert.deepEqual(listing.items[0], { id: designId, latest: 18, title: 'Latest', versions: [11, 17, 18], ...state });
});

test('the existing project binding can send implementation workflow commands and verifies the version receipt', async t => {
  const projectId = 'fixture-design';
  const designId = 'DSN-fixture';
  const projectKey = 'cdsp_fixture_shared';
  const calls = [];
  let responseVersion = 6;
  const bridge = createDesignBridge({ root: process.cwd(), projectId, projectKey, host: 'https://cds.example.test' }, {
    fetchImpl: async (url, request) => {
      const body = JSON.parse(request.body);
      calls.push({ path: new URL(url).pathname, key: request.headers['X-AI-Access-Key'], body });
      return Response.json({ projectId, reused: false, result: { type: body.type, designId, version: responseVersion } });
    },
  });
  t.after(() => bridge.close());
  const command = { type: 'design.freeze', designId, version: 6, expectedBaseline: null, requestId: 'freeze-fixture' };
  const receipt = await bridge.call('cds_design_acceptance', command);
  assert.equal(receipt.result.version, 6);
  assert.deepEqual(calls, [{ path: `/api/projects/${projectId}/design/commands`, key: projectKey, body: command }]);
  responseVersion = 7;
  await assert.rejects(bridge.call('cds_design_acceptance', command), /版本|回执/);
});
