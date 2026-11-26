import assert from 'node:assert/strict';
import test from 'node:test';
import { createDesignBridge } from '../src/design-bridge.mjs';

test('V17 evidence writes keep the same project, run, and evidence identifier', async t => {
  const projectId = 'fixture';
  const designId = 'DSN-fixture';
  const runId = 'RUN-fixture';
  const commit = 'a'.repeat(40);
  const commands = [];
  let canWrite = false;
  let alterId;
  const bridge = createDesignBridge({ root: process.cwd(), projectId, projectKey: 'cdsp_fixture', host: 'https://cds.example.test' }, {
    fetchImpl: async (url, request) => {
      const path = new URL(url).pathname;
      const route = `/api/projects/${projectId}/design`;
      if (request.method === 'GET') {
        assert.equal(path, route);
        return Response.json({ projectId, permissions: { write: canWrite, visual: canWrite }, frameworks: [], designs: [] });
      }
      assert.equal(path, route + '/commands');
      assert.equal(request.method, 'POST');
      const body = JSON.parse(request.body);
      commands.push(body);
      const id = alterId ?? body.dimension ?? body.issueId ?? 'K-fixture';
      return Response.json({ projectId, reused: false, result: {
        type: body.type, designId, id, ...(body.runId ? { runId, version: 17 } : {}),
      } });
    },
  });
  t.after(() => bridge.close());
  const base = { designId, runId, commit };
  const coverage = { ...base, requestId: 'coverage', type: 'acceptance.coverage', dimension: 'compatibility',
    risk: '窄屏出现横向滚动', ruleIds: ['A-13'] };
  const regress = { ...base, requestId: 'regress', type: 'acceptance.regress', issueId: 'K-fixture', status: 'passed',
    evidence: '窄屏 853px，页面宽度也是 853px' };
  const known = { designId, requestId: 'known', type: 'known.create', problem: '滚动入口损坏', how: 'measure',
    check: '比较内容和视口宽度', sources: [{ kind: 'feedback', ref: 'FDB-fixture', count: 2 }], screenIds: ['screen'] };
  const tool = 'cds_design_acceptance';
  await assert.rejects(bridge.call(tool, coverage), /权限/);
  assert.equal(commands.length, 0);

  canWrite = true;
  for (const entry of [coverage, regress, known]) assert((await bridge.call(tool, entry)).result.id);
  assert.deepEqual(commands, [coverage, regress, known]);
  for (const invalid of [{ ...coverage, reason: '不适用' }, { ...coverage, ruleIds: [] },
    { ...regress, status: 'unverified' }, { ...known, sources: [] }, { ...known, projectId: 'foreign' }]) {
    await assert.rejects(bridge.call(tool, invalid), /参数无效/);
  }
  assert.equal(commands.length, 3);
  alterId = 'another-issue';
  await assert.rejects(bridge.call(tool, regress), /回执/);
});
