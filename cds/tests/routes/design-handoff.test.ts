import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { createDesignWorkspaceRouter } from '../../src/routes/design-workspace.js';
import type { DesignHandoffExecutor } from '../../src/services/design-handoff-browser.js';
import { DesignWorkspaceService, type DesignActor, type DesignWorkspaceCommit } from '../../src/services/design-workspace.js';
import { FileProjectRevisionStore } from '../../src/services/project-revision-store.js';
import type { DesignHandoffCaseResult, DesignHandoffState } from '../../src/shared/design-handoff.js';
import { versionedDesignFixture } from '../helpers/versioned-design-fixture.js';

const project = 'fixture-handoff';
const otherProject = 'fixture-handoff-other';
const commits = ['a'.repeat(40), 'b'.repeat(40)];
const reviewer: DesignActor = { id: 'member', kind: 'human', label: 'Fixture reviewer', permissions: ['read', 'write', 'approve'] };
const designer: DesignActor = { id: 'designer', kind: 'agent', label: 'Fixture designer', permissions: ['read', 'write'] };

const fixtureCase = { id: 'open-entry', title: '打开入口后能读到回执', screenId: 'entry', ruleIds: ['A-01'], steps: [
  { action: 'click', selector: '#open' }, { action: 'expect', selector: '#receipt', check: 'text', equals: '已打开' },
] };
const handoffPlan = { cases: [fixtureCase] };
const prototype = `<!doctype html><main><button id="open">打开</button>
    <p id="receipt"></p></main><script>document.querySelector('#open').onclick = () => { document.querySelector('#receipt').textContent = '已打开' }</script>`;

function draft(version: number, extra: Record<string, unknown> = {}) {
  return versionedDesignFixture({
    project, title: '交接检查样例', screens: [{ id: 'entry', name: '入口', route: '#/entry', viewport: 'desktop', themes: ['light'], entryReadySelector: 'main' }],
    acceptance: [{ id: 'A-01', how: 'measure', screenId: 'entry', rule: '可以打开入口', expected: '打开后显示回执。检查：回执文字。' }],
    ...extra,
  }, '验证设计交接记录。', [{ name: 'dist/index.html', data: prototype }],
  version === 1 ? undefined : { commit: commits[0] });
}

describe('设计交接服务端门禁', () => {
  let directory: string;
  let servers: Server[];
  let checkHandoff: Mock<DesignHandoffExecutor>;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'cds-design-handoff-'));
    servers = [];
    checkHandoff = vi.fn<DesignHandoffExecutor>().mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await Promise.all(servers.map(server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))));
    await rm(directory, { force: true, recursive: true });
  });

  async function openApi(gate: 'enabled' | 'legacy' | 'unavailable' = 'enabled', executor: DesignHandoffExecutor = checkHandoff) {
    const dependencies = { now: () => new Date('2026-11-26T08:00:00Z'),
      ...(gate === 'legacy' ? {} : { handoff: gate === 'enabled' ? { check: executor } : {} }),
    };
    const service = new DesignWorkspaceService(new FileProjectRevisionStore<DesignWorkspaceCommit>(directory), dependencies);
    const app = express();
    app.use('/api', createDesignWorkspaceRouter({ service, resolveAccess: (req, target) => {
      if (target !== project && target !== otherProject) return null;
      switch (req.get('x-fixture-actor')) {
        case 'reviewer': return reviewer;
        case 'designer': return designer;
        case 'collaborator': return target === project ? { ...designer, id: 'shared-project-key', label: 'Project collaboration fixture', projectCollaborator: true } : null;
        case 'publisher': return { ...designer, gitPublishOnly: true };
        case 'other-publisher': return { ...designer, id: 'other-designer', gitPublishOnly: true };
        case 'outside': return target === otherProject ? reviewer : null;
        default: return null;
      }
    } }));
    const server = app.listen(0, '127.0.0.1');
    servers.push(server);
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('缺少验收服务地址');
    const endpoint = (target = project) => `http://127.0.0.1:${address.port}/api/projects/${target}/design`;
    const get = (suffix = '', target = project, actor = 'reviewer') => fetch(endpoint(target) + suffix, { headers: { 'x-fixture-actor': actor } });
    const read = async (designId: string, version: number) => {
      const response = await get(`?designId=${designId}&version=${version}`);
      expect(response.status).toBe(200);
      const { designs } = await response.json();
      expect(designs).toHaveLength(1);
      return designs[0];
    };
    const readHandoff = async (id: string, version: number, status?: DesignHandoffState['status']) => {
      const readSelected = async () => (await read(id, version)).versions.find((row: { version: number }) => row.version === version)?.handoff;
      if (!status) return readSelected();
      return vi.waitFor(async () => {
        const handoff = await readSelected();
        expect(handoff?.status).toBe(status);
        return handoff;
      }, { timeout: 2_000 });
    };
    const command = (type: string, fields: object, target = project, actor = 'reviewer', requestId: string = randomUUID()) => fetch(
      endpoint(target) + (type === 'handoff.check' ? '/handoff/check' : '/commands'), {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-fixture-actor': actor },
      body: JSON.stringify({ type, requestId, ...fields }),
    });
    const submit = (archive: Buffer, target?: string, key = 'handoff') => {
      const query = new URLSearchParams({ requestId: randomUUID(), sourceMode: 'private', sourcePath: `design/${key}`,
        ...(target ? { intent: 'revise', designId: target, expectedVersion: '1', sourceCommit: commits[1] }
          : { intent: 'create', designKey: `fixture/${key}`, sourceCommit: commits[0] }),
      });
      return fetch(endpoint() + `/packages?${query}`, { method: 'POST',
        headers: { 'Content-Type': 'application/zip', 'x-fixture-actor': 'designer' }, body: new Uint8Array(archive),
      });
    };
    const publish = async (archive: Buffer, target?: string, key?: string): Promise<string> => {
      const response = await submit(archive, target, key);
      const body = await response.json();
      expect(response.status, JSON.stringify(body)).toBe(201);
      expect(body.result).toMatchObject({ designId: expect.any(String), version: target ? 2 : 1 });
      return body.result.designId;
    };
    return { get, read, readHandoff, command, submit, publish };
  }

  it.each(['design.freeze', 'implementation.start'])('缺少交接计划时保留草稿，并通过 %s 阻止建立实施基线', async type => {
    const api = await openApi();
    const archive = draft(1);
    const designId = await api.publish(archive);
    const blocked = await api.command(type, { designId, version: 1, expectedBaseline: null });
    expect(blocked.status).toBe(409);
    const entry = await api.read(designId, 1);
    expect(entry.frozen).toBeUndefined();
    expect(entry.upgrade).toBeUndefined();
    expect(entry.versions[0].handoff).toMatchObject({ status: 'missing-plan' });
    const saved = await api.get('/artifacts/' + entry.versions[0].delivery.archiveId);
    expect(saved.status).toBe(200);
    expect(Buffer.from(await saved.arrayBuffer())).toEqual(archive);
    expect(checkHandoff).not.toHaveBeenCalled();
  });

  it('交接检查严格按项目、稿件和版本定位，不借用其他范围的记录', async () => {
    const api = await openApi();
    const designId = await api.publish(draft(1, { handoff: handoffPlan }));
    const before = await api.readHandoff(designId, 1, 'unavailable');
    const target = { designId, version: 1 };
    for (const denied of [
      await api.command('handoff.check', { ...target, designId: 'DSN-unknown' }),
      await api.command('handoff.check', target, otherProject),
      await api.command('handoff.check', target, project, 'outside'),
      await api.command('handoff.check', { ...target, version: 2 }),
    ]) {
      expect(denied.status).toBe(404);
      expect(await denied.json()).toMatchObject({ error: 'design_not_found' });
    }
    expect(await api.readHandoff(designId, 1)).toEqual(before);
    expect(checkHandoff).toHaveBeenCalledTimes(1);
  });

  it('本项目的设计发布凭据可以重跑协作者提交的固定版本', async () => {
    const api = await openApi();
    const designId = await api.publish(draft(1, { handoff: handoffPlan }));
    const fields = { designId, version: 1 };
    await api.readHandoff(designId, 1, 'unavailable');
    expect(checkHandoff).toHaveBeenCalledTimes(1);

    checkHandoff.mockResolvedValueOnce([{ caseId: fixtureCase.id, status: 'passed' }]);
    const allowed = await api.command('handoff.check', fields, project, 'other-publisher');
    expect(allowed.status).toBe(201);
    await api.readHandoff(designId, 1, 'passed');
    expect(checkHandoff).toHaveBeenCalledTimes(2);
  });

  it('uses a shared project credential for handoff while preserving program gates and attribution', async () => {
    const api = await openApi();
    const designId = await api.publish(draft(1, { handoff: handoffPlan }));
    const target = { designId, version: 1 };
    const command = (type: string, fields = {}) => api.command(type, { ...target, ...fields }, project, 'collaborator');
    await api.readHandoff(designId, 1, 'unavailable');
    const pending = await command('design.freeze', { expectedBaseline: null });
    expect(pending.status).toBe(409);
    expect(await pending.json()).toMatchObject({ error: 'design_handoff_required' });
    const screens = [{ screenId: 'entry', path: '/fixture-entry', readySelector: 'main' }];
    expect((await command('implementation.bind', { screens })).status).toBe(409);
    checkHandoff.mockResolvedValueOnce([{ caseId: fixtureCase.id, status: 'passed' }]);
    expect((await command('handoff.check')).status).toBe(201);
    await api.readHandoff(designId, 1, 'passed');
    expect((await command('design.freeze')).status).toBe(400);
    expect((await api.command('design.freeze', { ...target, expectedBaseline: null }, project, 'designer')).status).toBe(403);
    expect((await api.command('design.freeze', { ...target, expectedBaseline: null }, otherProject, 'collaborator')).status).toBe(404);
    expect((await command('design.freeze', { expectedBaseline: null })).status).toBe(201);
    expect((await api.read(designId, 1)).freezes.at(-1)).toMatchObject({ version: 1, by: 'Project collaboration fixture' });
    expect((await command('implementation.start', { expectedBaseline: null })).status).toBe(409);
    const locked = await command('implementation.start', { expectedBaseline: 1 });
    expect(locked.status).toBe(201);
    const { upgradeId } = (await locked.json()).result;
    expect((await api.read(designId, 1)).upgrade).toMatchObject({ targetVersion: 1, startedBy: 'shared-project-key' });
    expect((await command('implementation.bind', { screens })).status).toBe(201);
    const bound = await api.read(designId, 1);
    expect(bound.versions[0].screens[0].impl).toBe('/fixture-entry');
    expect(bound.implementedVersion).toBeUndefined();
    expect((await command('design.unfreeze')).status).toBe(409);
    expect((await api.command('implementation.cancel', { designId, upgradeId, reason: '验证撤回' }, project, 'collaborator')).status).toBe(201);
    expect((await command('design.unfreeze')).status).toBe(201);
    expect((await api.read(designId, 1)).frozen).toBeUndefined();
  });

  it('拒绝提交者在稿件或执行请求里声明检查已通过', async () => {
    const api = await openApi();
    const forged = { status: 'passed', result: { status: 'passed' } };
    const archive = await api.submit(draft(1, { handoff: { ...handoffPlan, ...forged } }));
    expect(archive.status).toBe(400);
    expect((await (await api.get('/intake')).json()).designs).toEqual([]);
    expect(checkHandoff).not.toHaveBeenCalled();
    const designId = await api.publish(draft(1, { handoff: handoffPlan }));
    const before = await api.readHandoff(designId, 1, 'unavailable');
    const request = await api.command('handoff.check', { designId, version: 1, ...forged }, project, 'designer');
    expect(request.status).toBe(400);
    expect(await api.readHandoff(designId, 1)).toEqual(before);
    expect(checkHandoff).toHaveBeenCalledTimes(1);
  });

  it('兼容已经定稿的旧版本并允许按理由回退到历史基线', async () => {
    const legacy = await openApi('legacy');
    const designId = await legacy.publish(draft(1));
    expect((await legacy.command('design.freeze', { designId, version: 1 })).status).toBe(201);
    await legacy.publish(draft(2), designId);
    expect((await legacy.command('design.freeze', { designId, version: 2, expectedBaseline: 1 })).status).toBe(201);

    const api = await openApi();
    expect(await api.read(designId, 2)).toMatchObject({ frozen: 2, versions: expect.arrayContaining([expect.objectContaining({ version: 2 })]) });
    await api.readHandoff(designId, 1, 'legacy');
    expect((await api.command('design.freeze', { designId, version: 1, expectedBaseline: 2, reason: '当前实施需要回到原定稿。' })).status).toBe(201);
    expect((await api.command('implementation.start', { designId, version: 1, expectedBaseline: 1 })).status).toBe(201);
    expect(await api.read(designId, 1)).toMatchObject({ frozen: 1, upgrade: { targetVersion: 1, status: 'active' } });
    expect(checkHandoff).not.toHaveBeenCalled();
  });

  it('区分稿件错误和平台错误，局部重试保留通过的证据，同一请求不会重跑', async () => {
    const cases = [fixtureCase,
      { ...fixtureCase, id: 'read-receipt', title: '打开后能核对详情' },
      { ...fixtureCase, id: 'full-screen', title: '打开后能进入全屏', steps: [fixtureCase.steps[0],
        { action: 'expect', selector: 'main', check: 'fullscreen', equals: true }] },
    ];
    checkHandoff.mockResolvedValueOnce([
      { caseId: 'open-entry', status: 'passed' },
      { caseId: 'read-receipt', status: 'failed', step: 2, code: 'expectation' },
      { caseId: 'full-screen', status: 'unavailable', step: 2, code: 'host-capability' },
    ]);
    let finish!: (results: DesignHandoffCaseResult[]) => void;
    checkHandoff.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const api = await openApi();
    const designId = await api.publish(draft(1, { handoff: { cases } }));
    const target = { designId, version: 1 };
    const initial = await api.readHandoff(designId, 1, 'failed');
    expect(initial.cases).toEqual(expect.arrayContaining([
      expect.objectContaining({ caseId: 'open-entry', status: 'passed', title: fixtureCase.title, ruleIds: ['A-01'], screenId: 'entry', theme: 'light' }),
      expect.objectContaining({ caseId: 'read-receipt', status: 'failed', step: 2, code: 'expectation', owner: 'design', message: expect.any(String) }),
      expect.objectContaining({ caseId: 'full-screen', status: 'unavailable', step: 2, code: 'host-capability', owner: 'cds', message: expect.any(String) }),
    ]));
    expect((await api.command('implementation.start', target)).status).toBe(409);
    expect(checkHandoff).toHaveBeenNthCalledWith(1, expect.objectContaining({ prototype: Buffer.from(prototype),
      cases: cases.map(row => expect.objectContaining(row)),
      screens: [expect.objectContaining({ id: 'entry', route: '#/entry', entryReadySelector: 'main' })] }));

    const retry = () => api.command('handoff.check', target, project, 'designer', 'retry-remaining');
    const recovered: DesignHandoffCaseResult[] = [{ caseId: 'read-receipt', status: 'passed' }, { caseId: 'full-screen', status: 'passed' }];
    try {
      const requested = await retry();
      expect(requested.status).toBe(201);
      const original = await requested.json();
      await api.readHandoff(designId, 1, 'running');
      await vi.waitFor(() => expect(checkHandoff).toHaveBeenCalledTimes(2));
      expect(checkHandoff.mock.calls[1][0].cases.map(row => row.id)).toEqual(['read-receipt', 'full-screen']);

      const replay = await retry();
      expect(replay.status).toBe(200);
      expect(await replay.json()).toMatchObject({ reused: true, result: original.result });
    } finally {
      finish(recovered);
    }
    const passed = await api.readHandoff(designId, 1, 'passed');
    expect(passed.cases).toHaveLength(3);
    expect(passed.cases.map((item: DesignHandoffCaseResult) => item.status)).toEqual(['passed', 'passed', 'passed']);
    expect(passed.cases).toContainEqual(initial.cases.find((item: DesignHandoffCaseResult) => item.caseId === 'open-entry'));
    expect((await retry()).status).toBe(200);
    expect(checkHandoff).toHaveBeenCalledTimes(2);
    expect((await api.command('design.freeze', { ...target, expectedBaseline: null })).status).toBe(201);
    expect((await api.command('implementation.start', { ...target, expectedBaseline: 1 })).status).toBe(201);
  });

  it('同一画面和场景编号在续版仍须重新检查，旧版的通过与基线保持独立', async () => {
    const runnerError = 'synthetic browser failure with a local path';
    checkHandoff.mockResolvedValueOnce([{ caseId: 'open-entry', status: 'passed' }]).mockRejectedValueOnce(new Error(runnerError));
    const api = await openApi();
    const designId = await api.publish(draft(1, { handoff: handoffPlan }));
    const original = await api.readHandoff(designId, 1, 'passed');
    expect(original).toMatchObject({ policy: 'prototype-v1', binding: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect((await api.command('design.freeze', { designId, version: 1, expectedBaseline: null })).status).toBe(201);
    await api.publish(draft(2, { handoff: handoffPlan }), designId);

    const revision = await api.readHandoff(designId, 2, 'unavailable');
    expect(revision.cases).toMatchObject([{ caseId: 'open-entry', status: 'unavailable', code: 'runtime' }]);
    expect(revision.binding).not.toBe(original.binding);
    expect(JSON.stringify(revision)).not.toContain(runnerError);
    expect(checkHandoff).toHaveBeenCalledTimes(2);
    expect(await api.readHandoff(designId, 1)).toEqual(original);
    const target = { designId, version: 2, expectedBaseline: 1 };
    expect((await api.command('design.freeze', target)).status).toBe(409);
    expect((await api.command('implementation.start', target)).status).toBe(409);
    expect((await api.read(designId, 2)).frozen).toBe(1);
  });

  it('没有可用的渲染器时保留稿件，回执显示平台不可用且实施仍被拦截', async () => {
    const api = await openApi('unavailable');
    const designId = await api.publish(draft(1, { handoff: handoffPlan }));
    await api.readHandoff(designId, 1, 'unavailable');
    expect((await api.command('design.freeze', { designId, version: 1, expectedBaseline: null })).status).toBe(409);
    expect(checkHandoff).not.toHaveBeenCalled();
  });

  it('环境队列满时沿用原请求编号，腾出空间后应重跑失败的交接场景', async () => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    checkHandoff.mockResolvedValueOnce([{ caseId: 'open-entry', status: 'failed', code: 'expectation', step: 2 }])
      .mockImplementation(async ({ cases }) => {
        await blocked;
        return cases.map(test => ({ caseId: test.id, status: 'passed' }));
      });
    const api = await openApi();
    const bundle = draft(1, { handoff: handoffPlan });
    const designId = await api.publish(bundle);
    await api.readHandoff(designId, 1, 'failed');
    const occupied = [];
    const retry = () => api.command('handoff.check', { designId, version: 1 }, project, 'designer', 'capacity-retry');
    try {
      for (let index = 0; index < 8; index++) occupied.push(await api.publish(bundle, undefined, `handoff-queue-${index}`));
      await Promise.all(occupied.map(id => api.readHandoff(id, 1, 'running')));
      const busy = await retry();
      expect(busy.status).toBe(503);
      expect(await busy.json()).toMatchObject({ error: 'design_handoff_busy' });
    } finally {
      release();
    }
    await Promise.all(occupied.map(id => api.readHandoff(id, 1, 'passed')));
    expect((await retry()).ok).toBe(true);
    await api.readHandoff(designId, 1, 'passed');
    expect(checkHandoff).toHaveBeenCalledTimes(10);
  });

  it('同一版的迟到检查不能覆盖另一实例已保存的通过项和失败定位', async () => {
    const cases = [fixtureCase, { ...fixtureCase, id: 'follow-up', title: '检查后续入口' }];
    const newerCheck = vi.fn<DesignHandoffExecutor>().mockResolvedValue([
      { caseId: 'open-entry', status: 'passed' }, { caseId: 'follow-up', status: 'failed', step: 2, code: 'expectation' },
    ]);
    let finish!: (results: DesignHandoffCaseResult[]) => void;
    checkHandoff.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const original = await openApi();
    const newer = await openApi('enabled', newerCheck);
    const designId = await original.publish(draft(1, { handoff: { cases } }));
    let saved;
    try {
      await vi.waitFor(() => expect(checkHandoff).toHaveBeenCalledTimes(1));
      expect((await newer.command('handoff.check', { designId, version: 1 }, project, 'designer')).status).toBe(201);
      saved = await newer.readHandoff(designId, 1, 'failed');
      expect(newerCheck).toHaveBeenCalledTimes(1);
      expect(saved.cases).toMatchObject([{ caseId: 'open-entry', status: 'passed' },
        { caseId: 'follow-up', status: 'failed', step: 2, code: 'expectation' }]);
    } finally {
      finish([{ caseId: 'open-entry', status: 'failed', step: 0, code: 'entry' }, { caseId: 'follow-up', status: 'failed', step: 1, code: 'control' }]);
    }
    expect(await original.readHandoff(designId, 1, 'failed')).toEqual(saved);
  });
});
