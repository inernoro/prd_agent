import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDesignWorkspaceRouter } from '../../src/routes/design-workspace.js';
import { DesignWorkspaceService, type DesignActor, type DesignWorkspaceCommit } from '../../src/services/design-workspace.js';
import { FileProjectRevisionStore } from '../../src/services/project-revision-store.js';
import type { DesignVisualChecks } from '../../src/shared/design-visual.js';
import type { DesignRun, DesignVersion } from '../../src/shared/design-workspace.js';
import { crc32 } from '../../src/utils/zip.js';

const projectId = 'fixture-program-proof';
const designId = 'DSN-program-proof';
const runId = 'RUN-program-proof';
const commit = 'c'.repeat(40);
const frozenAt = '2026-11-25T02:00:00.000Z';
const previewUrl = 'https://fixture-proof.test/';
const implementation = '/design?screen=main';
const slot = 'desktop-light';
const comparison = { screenId: 'main', slot };
const fixtureDigest = 'f'.repeat(64);
const dataset = '9'.repeat(64);
const demoData = { files: ['src/fixtures.ts', 'src/data-design.ts'], sha256: dataset };
const provenance = { dataset, commit, capturedBy: 'cds' };
const prototype = Buffer.from('<main data-ready="fixture">合成验收原型</main>');
const implementer: DesignActor = {
  kind: 'human', id: 'implementer', label: '合成实现成员', permissions: ['read', 'write', 'approve'],
};
const designer: DesignActor = {
  kind: 'human', id: 'designer', label: '合成设计成员', permissions: ['read', 'write', 'approve'],
};
const designCredential: DesignActor = {
  ...designer, kind: 'agent', permissions: ['read', 'write'], gitPublishOnly: true,
};
const member: DesignActor = { ...implementer, label: '合成项目成员', id: 'member' };
const notApplicable = { applicable: false, reason: '这个合成稿件只验证程序证据门槛。' };
const directories: string[] = [];
const checks: DesignVisualChecks = {
  'V-01': { status: 'passed', evidence: '页头、标签、主体、浮层与底部同处对应区域。' },
  'V-02': { status: 'passed', evidence: '同排按钮 y 坐标偏差 0 px。' },
  'V-03': { status: 'passed', evidence: '浮层与内容重叠面积 0 px。' },
  'V-04': { status: 'passed', evidence: '实测宽度 1280 px，横向溢出 0 px。' },
  'V-05': { status: 'passed', evidence: '合成页面正文无原样内容。' },
  'V-06': { status: 'passed', evidence: '徽标和列表均为同样的数据。' },
  'V-07': { status: 'passed', evidence: '夹具正文与背景对比度为 5.2。' },
  'V-08': { status: 'passed', evidence: '当前视口画面的主体完整显示。' },
  'V-09': { status: 'passed', evidence: '画面显示清单已加载状态。' },
  'V-10': { status: 'passed', evidence: '合成清单完整显示长标题。' },
};

function screenshot() {
  const chunk = (name: string, data: Buffer) => {
    const bytes = Buffer.alloc(data.length + 12);
    bytes.writeUInt32BE(data.length);
    bytes.write(name, 4);
    data.copy(bytes, 8);
    bytes.writeUInt32BE(crc32(bytes.subarray(4, data.length + 8)), data.length + 8);
    return bytes;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1280, 0);
  header.writeUInt32BE(800, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.alloc((1280 * 3 + 1) * 800))), chunk('IEND', Buffer.alloc(0)),
  ]);
}

function observed() {
  const pixels = screenshot();
  return {
    fixtureDigest, reference: pixels, implementation: pixels, checks,
    rules: { 'A-1': { status: 'passed' as const, actual: '实际宽度 1280 px，横向溢出 0 px。' } },
  };
}

afterEach(async () => {
  const finished = directories.splice(0);
  await Promise.all(finished.map(directory => rm(directory, { recursive: true, force: true })));
});

function published(version: number): DesignVersion {
  const acceptance: DesignVersion['acceptance'] = [{
    id: 'A-1', rule: '主区无横向溢出', how: 'measure', priority: 'high',
    screenId: 'main', slots: ['desktop-light'], expected: '检查：主区宽度不超过视口。',
  }];
  if (version >= 22) acceptance.push({
    id: 'A-71', rule: '对照证据来自程序', how: 'human', priority: 'high',
    screenId: 'main', slots: ['desktop-light'],
    expected: '证据只认程序产生的。同一份演示数据和提交。签收前设计方独立重跑。',
  });
  return {
    version, title: '程序取证合成稿件', sourceCommit: 'a'.repeat(40), sha256: 'd'.repeat(64),
    prototypeId: 'test-prototype', createdAt: frozenAt, publisher: { id: designer.id, label: designer.label },
    prototypeSha256: createHash('sha256').update(prototype).digest('hex'),
    acceptanceMode: 'objective',
    ...(version === 23 ? { demoData, goals: [{ id: 'G-01', goal: '完整显示主区', doneWhen: '主区滑动正常。', items: ['A-1'] }] } : {}),
    acceptancePlan: { mece: notApplicable, compare: notApplicable, visual: notApplicable, regress: notApplicable },
    screens: [{ id: 'main', name: '主区', route: '#main', viewport: 'desktop', themes: ['light'], impl: implementation }],
    acceptance, rationale: '合成的验收范围。', spec: {}, tags: [], decisionIds: [], resolves: {},
  };
}

async function setup(version = 22, captureAcceptance?: () => Promise<ReturnType<typeof observed> | undefined>, bothThemes = false) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cds-design-evidence-'));
  directories.push(directory);
  const store = new FileProjectRevisionStore<DesignWorkspaceCommit>(directory);
  const draft = published(version);
  if (bothThemes) {
    draft.screens[0].themes.push('dark');
    draft.acceptance[0].slots = ['desktop-light', 'desktop-dark'];
  }
  const run: DesignRun = {
    id: runId, version, target: 'installed', commit, previewUrl, createdAt: frozenAt, verdict: 'passed', issues: {},
    cells: draft.acceptance.flatMap(rule => rule.slots.map(slot => ({
      itemId: rule.id, slot,
      ...(version === 23 ? { status: 'unverified' as const, actual: '待程序取证。' } : {
        status: 'passed' as const, actual: '合成旧式手工验收结果', recordedBy: implementer.label, imageId: 'manual-shot',
        measured: { width: 1280, height: 800, theme: slot.endsWith('-light') ? 'light' as const : 'dark' as const, path: implementation },
      }),
    }))),
  };
  await store.append({
    projectId, revision: 1,
    request: { key: 'published', fingerprint: 'published', result: { type: 'fixture' } },
    assets: [{ id: draft.prototypeId, mime: 'text/html', base64: prototype.toString('base64') }],
    design: { id: designId, version: draft, frozen: version, run },
  });
  let installedCommit = commit;
  const service = new DesignWorkspaceService(store, {
    ...(captureAcceptance && { captureAcceptance }),
    resolveInstalled: async id => id === projectId ? { commit: installedCommit, url: previewUrl } : undefined,
  });
  let sequence = 0;
  return {
    store,
    service,
    deploy(nextCommit: string) { installedCommit = nextCommit; },
    command(type: string, actor = implementer, fields: Record<string, unknown> = {}) {
      return service.command(projectId, actor, { designId, runId, type, requestId: `proof-${++sequence}`, ...fields });
    },
    async entry() {
      return (await service.workspace(projectId, implementer)).designs[0];
    },
  };
}

async function recheckOverHttp(service: DesignWorkspaceService) {
  const app = express();
  app.use('/api', createDesignWorkspaceRouter({
    service,
    resolveAccess: (req, id) => id === projectId && req.get('x-draft-member') === 'fixture-publisher' ? designCredential : null,
  }));
  const server = app.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects/${projectId}/design`;
    const request = () => fetch(origin + '/acceptance/recheck', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-draft-member': 'fixture-publisher' },
      body: JSON.stringify({ type: 'acceptance.recheck', requestId: 'recheck-over-http', designId, runId, ...comparison }),
    });
    const recorded = await request();
    expect(recorded.status).toBe(201);
    expect(recorded.headers.get('cache-control')).toBe('private, no-store');
    const result = await recorded.json();
    expect(result).toMatchObject({ reused: false, result: { type: 'acceptance.recheck', designId, runId, ...comparison } });
    const replay = await request();
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ ...result, reused: true });
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

describe('程序验收的签收门槛', () => {
  it('要求 CDS 采集证据，即使每个验收格都有旧式手工截图和通过结论', async () => {
    const fixture = await setup();
    expect((await fixture.entry()).runs[0].cells.every(cell => cell.status === 'passed' && cell.imageId)).toBe(true);
    await expect(fixture.command('acceptance.sign')).rejects.toMatchObject({ status: 409 });
    expect((await fixture.entry()).implementedVersion).toBeUndefined();
    expect((await fixture.entry()).runs[0].signed).toBeUndefined();
    expect(await fixture.store.read(projectId, 1)).toEqual([]);
  });

  it('采集器不可用时返回服务状态，并保留原运行', async () => {
    const fixture = await setup();
    await expect(fixture.command('acceptance.capture', implementer, comparison))
      .rejects.toMatchObject({ status: 503, code: 'design_capture_unavailable' });
    expect(await fixture.store.read(projectId, 1)).toEqual([]);
  });

  it('部署提交已经推进时仍拒绝签收冻结在旧提交的运行', async () => {
    const fixture = await setup();
    fixture.deploy('e'.repeat(40));
    await expect(fixture.command('acceptance.sign')).rejects.toMatchObject({ status: 409, message: expect.stringContaining('预览已经变化') });
    expect(await fixture.store.read(projectId, 1)).toEqual([]);
  });

  it('保留没有程序取证要求的历史版本签收与实施版本写入', async () => {
    const fixture = await setup(20);
    const receipt = await fixture.command('acceptance.sign');
    expect(receipt.result).toMatchObject({ version: 20, implementedVersion: 20 });
    expect(await fixture.entry()).toMatchObject({
      implementedVersion: 20, runs: [{ id: runId, signed: { by: implementer.id, verdict: 'passed' } }],
    });
  });

  it('只有同一提交的程序取证与独立设计方复验一致后才签收', async () => {
    const capture = vi.fn(async () => observed());
    const fixture = await setup(22, capture);
    await expect(fixture.command('acceptance.capture', designCredential, comparison)).rejects.toMatchObject({ status: 403 });
    await fixture.command('acceptance.capture', implementer, comparison);
    expect(capture).toHaveBeenNthCalledWith(1, expect.objectContaining({
      commit, prototype, screen: expect.objectContaining({ id: 'main', impl: implementation }), theme: 'light',
      rules: expect.arrayContaining([expect.objectContaining({ id: 'A-1' })]),
    }));
    const read = async () => (await fixture.entry()).runs[0];
    expect(await read()).toMatchObject({
      programEvidence: { 'main/desktop-light': {
        by: implementer.id, commit, fixtureDigest, digest: expect.stringMatching(/^[a-f0-9]{64}$/),
      } },
      visual: { 'main/desktop-light': {
        imageId: expect.any(String), referenceImageId: expect.any(String), checks,
      } },
      cells: expect.arrayContaining([expect.objectContaining({ itemId: 'A-1', status: 'passed', actual: observed().rules['A-1'].actual })]),
    });
    await expect(fixture.command('acceptance.sign')).rejects.toMatchObject({ status: 409 });
    await expect(fixture.command('acceptance.recheck', member, comparison)).rejects.toMatchObject({ status: 403 });
    expect(capture).toHaveBeenCalledTimes(1);

    await recheckOverHttp(fixture.service);
    expect(capture).toHaveBeenCalledTimes(2);
    expect(capture.mock.calls[1]).toEqual(capture.mock.calls[0]);
    expect(await read()).toMatchObject({
      programEvidence: { 'main/desktop-light': { review: { by: designer.id, matched: true } } },
    });
    const signed = await fixture.command('acceptance.sign');
    expect(signed.result).toMatchObject({ runId, implementedVersion: 22 });
    expect(await read()).toMatchObject({
      commit, signed: { by: implementer.id, verdict: 'passed' },
    });
  });

  it('拒绝让同一名设计成员为自己完成的程序取证复验', async () => {
    const capture = vi.fn(async () => observed());
    const fixture = await setup(22, capture);
    await fixture.command('acceptance.capture', designer, comparison);
    await expect(fixture.command('acceptance.recheck', designer, comparison)).rejects.toMatchObject({ status: 403 });
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it('手工截图和手填结论不能覆盖程序的画面、读数及复验状态', async () => {
    const result = observed();
    const fixture = await setup(22, async () => result);
    await fixture.command('acceptance.capture', implementer, comparison);
    await fixture.command('acceptance.recheck', designer, comparison);
    const before = (await fixture.entry()).runs[0];
    const image = `data:image/png;base64,${result.implementation.toString('base64')}`;
    const measured = { width: 1280, height: 800, theme: 'light', path: implementation };
    await expect(fixture.command('acceptance.record', implementer, {
      commit, cells: [{ itemId: 'A-1', slot, status: 'passed', actual: '手工读数用于说明', image, measured }],
    })).rejects.toMatchObject({ status: 409 });
    await expect(fixture.command('acceptance.visual', implementer, {
      ...comparison, commit, image, measured, checks,
    })).rejects.toMatchObject({ status: 409 });
    expect((await fixture.entry()).runs[0]).toEqual(before);
  });

  it('多个画面的演示数据指纹不一致时停止复验并拒绝签收', async () => {
    const result = observed();
    const capture = vi.fn(async () => result)
      .mockResolvedValueOnce(result).mockResolvedValueOnce(result);
    const otherData = { ...result, fixtureDigest: 'e'.repeat(64) };
    capture.mockResolvedValueOnce(otherData);
    const fixture = await setup(22, capture, true);
    await fixture.command('acceptance.capture', implementer, comparison);
    await fixture.command('acceptance.recheck', designer, comparison);
    const dark = { ...comparison, slot: 'desktop-dark' };
    await fixture.command('acceptance.capture', implementer, dark);
    await expect(fixture.command('acceptance.recheck', designer, dark)).rejects.toMatchObject({ status: 409 });
    expect(capture).toHaveBeenCalledTimes(3);
    expect((await fixture.entry()).runs[0]).toMatchObject({
      programEvidence: {
        'main/desktop-light': { fixtureDigest, review: { matched: true } },
        'main/desktop-dark': { fixtureDigest: otherData.fixtureDigest },
      },
    });
    await expect(fixture.command('acceptance.sign')).rejects.toMatchObject({ status: 409 });
  });

  it('对照手段不适用时，程序签收仍要求所有声明画面的视觉证据', async () => {
    const result = observed();
    const fixture = await setup(23, async () => ({
      ...result, checks: { ...result.checks, 'V-01': { status: 'missing', evidence: '待核对页面区域。' } },
    }));
    await fixture.command('acceptance.capture', implementer, comparison);
    await fixture.command('acceptance.recheck', designer, comparison);
    expect((await fixture.entry()).runs[0].verdict).toBe('needs_evidence');
    await expect(fixture.command('acceptance.sign')).rejects.toMatchObject({ status: 409 });
  });

  it('取证过程中部署提交改变时，丢弃本次浏览结果', async () => {
    let finishCapture!: (result: ReturnType<typeof observed>) => void;
    let startCapture!: () => void;
    const started = new Promise<void>(resolve => { startCapture = resolve; });
    const captured = new Promise<ReturnType<typeof observed>>(resolve => { finishCapture = resolve; });
    const fixture = await setup(22, () => { startCapture(); return captured; });
    const pending = fixture.command('acceptance.capture', implementer, comparison);
    await Promise.race([started, pending]);
    fixture.deploy('e'.repeat(40));
    finishCapture(observed());
    await expect(pending).rejects.toMatchObject({ status: 409, message: expect.stringContaining('预览已经变化') });
    expect(await fixture.store.read(projectId, 1)).toEqual([]);
  });

  it.each([
    ['演示数据指纹不同', () => ({ ...observed(), fixtureDigest: 'e'.repeat(64) })],
    ['逐项测量不同', () => ({
      ...observed(), rules: { 'A-1': { status: 'passed' as const, actual: '实际宽度 1279 px，横向溢出 0 px。' } },
    })],
  ] as const)('独立复验发现%s时记下差异，整次运行不能签收', async (_difference, changed) => {
    const capture = vi.fn(async () => observed()).mockImplementationOnce(async () => observed())
      .mockImplementationOnce(async () => changed());
    const fixture = await setup(22, capture);
    await fixture.command('acceptance.capture', implementer, comparison);
    await fixture.command('acceptance.recheck', designer, comparison);
    expect((await fixture.entry()).runs[0]).toMatchObject({
      programEvidence: { 'main/desktop-light': { review: { by: designer.id, matched: false } } },
    });
    await expect(fixture.command('acceptance.recheck', designer, comparison)).rejects.toMatchObject({ status: 409 });
    expect(capture).toHaveBeenCalledTimes(2);
    await expect(fixture.command('acceptance.sign')).rejects.toMatchObject({ status: 409 });
    expect((await fixture.entry()).implementedVersion).toBeUndefined();
  });
});

describe('V23 签收使用稿件声明的数据和程序证据', () => {
  async function captured() {
    const fixture = await setup(23, async () => observed());
    await fixture.command('acceptance.capture', implementer, comparison);
    await fixture.command('acceptance.recheck', designer, comparison);
    const run = (await fixture.entry()).runs[0];
    return { fixture, run };
  }

  it('取证由 CDS 记录数据集、提交和来源，独立复验后可签收', async () => {
    const { fixture, run } = await captured();
    expect(run.programEvidence?.['main/desktop-light']).toMatchObject({ ...provenance, fixtureDigest });
    expect(run.visual?.['main/desktop-light']).toMatchObject(provenance);
    expect(run.cells.find(cell => cell.itemId === 'A-1')).toMatchObject(provenance);
    await expect(fixture.command('acceptance.sign')).resolves.toMatchObject({ result: { implementedVersion: 23 } });
  });

  const differences = [
    ['dataset', '8'.repeat(64)],
    ['commit', 'b'.repeat(40)],
    ['capturedBy', 'manual'],
  ] as const;
  const incomplete = differences.flatMap(([field, incorrect]) => [
    { field, incorrect: undefined, explanation: '缺少' + field },
    { field, incorrect, explanation: field + '与运行和稿件不符' },
  ]);
  const cases = (['规则证据', '画面对照', '程序回执'] as const).flatMap(scope => incomplete.map(value => ({ scope, ...value })));

  it.each(cases)('$scope $explanation 时拒绝签收', async ({ scope, field, incorrect }) => {
    const { fixture, run } = await captured();
    const proof = run.programEvidence?.['main/desktop-light'];
    const visual = run.visual?.['main/desktop-light'];
    const cell = run.cells.find(row => row.itemId === 'A-1');
    if (!proof || !visual || !cell) throw new Error('取证夹具未准备好');
    for (const row of [proof, visual, ...run.cells]) Object.assign(row, provenance);
    const target = { '规则证据': cell, '画面对照': visual, '程序回执': proof }[scope];
    if (incorrect === undefined) Reflect.deleteProperty(target, field);
    else Reflect.set(target, field, incorrect);

    const history = await fixture.store.read(projectId, 0);
    await fixture.store.append({
      projectId, revision: history.length + 1,
      request: { key: 'stored-evidence-fixture', fingerprint: 'fixture', result: { type: 'fixture' } },
      design: { id: designId, run },
    });
    await expect(fixture.command('acceptance.sign')).rejects.toMatchObject({ status: 409 });
    expect((await fixture.entry()).implementedVersion).toBeUndefined();
  });
});
