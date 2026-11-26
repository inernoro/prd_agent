import { createHash } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { deflateSync } from 'node:zlib';
import express from 'express';
import { describe, expect, it, vi } from 'vitest';
import { createDesignWorkspaceRouter } from '../../src/routes/design-workspace.js';
import type { DesignReferenceCapture } from '../../src/services/design-framework-browser.js';
import { readDesignPackage } from '../../src/services/design-package.js';
import { DesignWorkspaceService, type DesignActor, type DesignWorkspaceCommit } from '../../src/services/design-workspace.js';
import type { ProjectRevisionStore } from '../../src/services/project-revision-store.js';
import { designMethodsState } from '../../src/shared/design-methods.js';
import type { DesignEntry, DesignRun, DesignVersion, DesignWorkspace } from '../../src/shared/design-workspace.js';
import { buildZip, crc32 } from '../../src/utils/zip.js';
import { withAcceptanceStandard } from '../helpers/versioned-design-fixture.js';

const project = 'design-v20-fixture';
const designId = 'DSN-v20';
const otherDesignId = 'DSN-other';
const commit = 'b'.repeat(40);
const preview = { commit, url: 'https://design-fixture.test/' };
const publishedAt = '2026-11-25T00:00:00.000Z';
const disabledAt = '2026-11-25T01:00:00.000Z';
const enabledAt = '2026-11-25T02:00:00.000Z';
const reviewer: DesignActor = { kind: 'human', id: 'v20-reviewer', label: '合成审核员', permissions: ['read', 'write', 'approve'] };
const reason = '合成流程环境正在重新准备，停用后保留原验收记录。';
const notApplicable = { applicable: false, reason: '本夹具只验证验收方法开关。' };

function published(version: number): DesignVersion {
  return {
    version, title: `验收稿 V${version}`, sourceCommit: 'a'.repeat(40), sha256: 'c'.repeat(64),
    prototypeId: `prototype-${version}`, createdAt: publishedAt, publisher: { id: 'publisher', label: '合成出稿人' },
    acceptanceMode: 'objective',
    acceptancePlan: { mece: notApplicable, compare: notApplicable, visual: notApplicable, regress: notApplicable, flow: { applicable: true } },
    screens: [{ id: 'main', name: '实施画面', route: '#main', viewport: 'desktop', themes: ['light'], impl: '/implementation' }],
    acceptance: [{
      id: 'A-measure', rule: `实施画面验收条目 V${version}`, screenId: 'main', how: 'measure', priority: 'high',
      slots: ['desktop-light'], expected: '检查：主体可见。',
    }],
    rationale: '只在打开版本后读取的完整思路。'.repeat(80),
    spec: { rules: `版本 ${version} 的完整组件规范。`.repeat(80) },
    delivery: { archiveId: `archive-${version}`, archiveRoot: '', warnings: [], files: [{
      id: `document-${version}`, path: `fixture-private-appendix-${version}.md`,
      kind: 'document', size: 123, sha256: 'd'.repeat(64), text: true,
    }] },
    tags: ['验收'], decisionIds: [], resolves: {},
  };
}

const originalRun: DesignRun = {
  id: 'RUN-v20', version: 20, target: 'installed', commit, previewUrl: preview.url, createdAt: publishedAt,
  cells: [{ itemId: 'A-measure', slot: 'desktop-light', status: 'passed', actual: '实测主体可见。' }],
  flows: [{
    id: 'first-flow', title: '示例流程', role: '评审成员', dimension: 'correctness', by: 'publisher', at: publishedAt, status: 'failed',
    steps: [{ action: '打开手段', expected: '结果可见', actual: '夹具记录了未显示的结果', status: 'failed' }],
  }],
  verdict: 'failed', issues: {},
};

function memoryStore(rows: DesignWorkspaceCommit[] = []): ProjectRevisionStore<DesignWorkspaceCommit> {
  return {
    async read(projectId, after) {
      return structuredClone(rows.filter(row => row.projectId === projectId && row.revision > after));
    },
    async append(row) {
      if (row.revision !== rows.length + 1) return false;
      rows.push(structuredClone(row));
      return true;
    },
    async readAsset(projectId, revision, id) {
      const asset = rows.find(row => row.projectId === projectId && row.revision === revision)?.assets?.find(asset => asset.id === id);
      return asset && structuredClone(asset);
    },
  };
}

function fixture() {
  const rows: DesignWorkspaceCommit[] = [];
  function seed(design: DesignWorkspaceCommit['design']) {
    const revision = rows.length + 1;
    rows.push({ projectId: project, revision, request: {
      key: `fixture-${revision}`, fingerprint: `fixture-${revision}`, result: { type: 'fixture' },
    }, design: structuredClone(design) });
  }
  seed({ id: designId, version: published(18) });
  seed({ id: designId, version: published(19), implementation: {
    version: 19, screens: [{ screenId: 'main', path: '/verified-implementation', readySelector: '#verified', at: publishedAt, by: 'publisher' }],
  } });
  seed({ id: designId, version: published(20), frozen: 20, run: originalRun });
  seed({ id: otherDesignId, version: published(1) });
  const store = memoryStore(rows);
  let time = disabledAt;
  const service = new DesignWorkspaceService(store, {
    now: () => new Date(time),
    resolveInstalled: async (id, expected) => id === project && (!expected || expected === commit) ? preview : undefined,
  });
  let sequence = 0;
  return {
    service, store, now(at: string) { time = at; },
    command(type: string, fields: object = {}, actor = reviewer) {
      return service.command(project, actor, { designId, requestId: `request-${++sequence}`, type, ...fields });
    },
    async entry() {
      return (await service.workspace(project, reviewer)).designs.find(row => row.id === designId)!;
    },
  };
}

function flowState(entry: DesignEntry, run = entry.runs.at(-1)) {
  return designMethodsState(entry.versions.find(version => version.version === run?.version)!, run, entry)
    .methods.find(method => method.id === 'flow');
}

describe('V20 验收手段开关', () => {
  const flow = { version: 20, method: 'flow' };

  it('拒绝空理由、无确认权限和非实施基线版本', async () => {
    const f = fixture();
    await expect(f.command('acceptance.disable', flow)).rejects.toMatchObject({ status: 400 });
    await expect(f.command('acceptance.disable', { ...flow, reason: '  ' })).rejects.toMatchObject({ status: 400 });
    await expect(f.command('acceptance.disable', { ...flow, reason }, { ...reviewer, permissions: ['read', 'write'] }))
      .rejects.toMatchObject({ status: 403 });
    await expect(f.command('acceptance.disable', { ...flow, reason }, { ...reviewer, kind: 'agent' }))
      .rejects.toMatchObject({ status: 403 });
    await expect(f.command('acceptance.disable', { ...flow, version: 19, reason })).rejects.toMatchObject({ status: 409 });
    expect(flowState(await f.entry())).toMatchObject({ status: 'failed' });
  });

  it('停用和重新启用会重算结论，保留原证据和审计记录', async () => {
    const f = fixture();
    expect(flowState(await f.entry())).toMatchObject({ status: 'failed' });
    const receipt = await f.command('acceptance.disable', { ...flow, reason });
    expect(receipt.result).toMatchObject({ type: 'acceptance.disable', designId, version: 20 });
    let entry = await f.entry();
    expect(flowState(entry)).toMatchObject({ status: 'disabled', reason });
    expect(entry.runs[0]).toMatchObject({ verdict: 'passed', flows: originalRun.flows });
    const stopped = JSON.stringify((await f.store.read(project, 0)).at(-1)?.design);
    expect(stopped).toContain(disabledAt);
    expect(stopped).toContain(reason);
    expect(stopped).toMatch(/v20-reviewer|合成审核员/);
    const { by: _by, at: _at, status: _status, ...unfinishedFlow } = originalRun.flows![0];
    await expect(f.command('acceptance.flow', { runId: originalRun.id, commit, flow: unfinishedFlow }))
      .rejects.toMatchObject({ status: 409 });

    f.now(enabledAt);
    expect((await f.command('acceptance.enable', flow)).result).toMatchObject({ type: 'acceptance.enable', designId, version: 20 });
    entry = await f.entry();
    expect(flowState(entry)).toMatchObject({ status: 'failed', progress: { failed: 1, total: 1 } });
    expect(entry.runs[0].flows).toEqual(originalRun.flows);
    const resumed = JSON.stringify((await f.store.read(project, 0)).at(-1)?.design);
    expect(resumed).toContain(enabledAt);
    expect(resumed).toMatch(/v20-reviewer|合成审核员/);
  });

  it('重新开跑后的设置不会改写已签收运行的结论和停用状态', async () => {
    const f = fixture();
    await f.command('acceptance.disable', { ...flow, reason });
    await f.command('acceptance.sign', { runId: originalRun.id });
    const signed = (await f.entry()).runs[0];
    expect(signed.signed).toMatchObject({ verdict: 'passed', by: reviewer.id });
    await expect(f.command('acceptance.enable', flow)).rejects.toMatchObject({ status: 409 });
    await f.command('acceptance.start', { version: 20, target: 'installed', commit });
    f.now(enabledAt);
    await f.command('acceptance.enable', flow);
    const entry = await f.entry();
    expect(entry.runs[0]).toEqual(signed);
    expect(flowState(entry, entry.runs[0])).toMatchObject({ status: 'disabled', reason });
    expect(flowState(entry)).toMatchObject({ status: 'notrun' });
  });
});

describe('V20 设计工作区投影', () => {
  it('列表只返回各稿件最新摘要，详情只载入被打开和对照的版本', async () => {
    const { service } = fixture();
    const full = await service.workspace(project, reviewer);
    expect(full.designs.find(row => row.id === designId)?.versions.map(row => row.version)).toEqual([18, 19, 20]);
    expect(JSON.stringify(full)).toContain('fixture-private-appendix-20.md');

    const summary = await service.workspace(project, reviewer, { summary: true });
    expect(summary.designs.map(row => [row.id, row.versions.map(version => version.version)])).toEqual([
      [designId, [20]], [otherDesignId, [1]],
    ]);
    expect(summary.designs[0].versions[0].title).toBe('验收稿 V20');
    expect(JSON.stringify(summary)).not.toContain('fixture-private-appendix');
    expect(JSON.stringify(summary)).not.toContain('实施画面验收条目');
    expect(JSON.stringify(summary).length).toBeLessThan(JSON.stringify(full).length);

    const detail = await service.workspace(project, reviewer, { designId, version: 19, fromVersion: 18 });
    expect(detail.designs.map(row => row.id)).toEqual([designId]);
    const [comparison, selected, latest] = detail.designs[0].versions;
    expect(comparison).toMatchObject({ version: 18, delivery: { archiveId: 'archive-18' } });
    expect(selected).toMatchObject({ version: 19, delivery: { archiveId: 'archive-19' },
      screens: [{ id: 'main', impl: '/verified-implementation', readySelector: '#verified' }] });
    expect(latest).toMatchObject({ version: 20, title: '验收稿 V20' });
    expect(JSON.stringify(latest)).not.toContain('fixture-private-appendix');
    expect(JSON.stringify(latest)).not.toContain('实施画面验收条目');
    expect(await service.workspace(project, reviewer)).toEqual(full);
  });

  it('在项目鉴权后的同一路由选择摘要或按需版本', async () => {
    const { service } = fixture();
    const app = express();
    app.use('/api', createDesignWorkspaceRouter({ service, resolveAccess: (req, id) =>
      id === project && req.get('x-fixture-member') === 'allowed' ? reviewer : null }));
    const server = app.listen(0, '127.0.0.1');
    try {
      await once(server, 'listening');
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects/${project}/design`;
      const headers = { 'x-fixture-member': 'allowed' };
      expect((await fetch(origin + '?view=summary')).status).toBe(404);
      const collection = await fetch(origin + '?view=summary', { headers });
      expect(collection.headers.get('cache-control')).toBe('private, no-store');
      expect(collection.status).toBe(200);
      const summary = await collection.json() as DesignWorkspace;
      expect(summary.designs[0].versions.map(version => version.version)).toEqual([20]);
      const detail = await fetch(origin + `?designId=${designId}&version=19&fromVersion=18`, { headers });
      expect(detail.status).toBe(200);
      expect((await detail.json() as DesignWorkspace).designs.map(row => row.id)).toEqual([designId]);
      expect((await fetch(origin + `?designId=${designId}&version=19x`, { headers })).status).toBe(400);
      expect((await fetch(origin + '?designId=DSN-missing&version=20', { headers })).status).toBe(404);
      const thumbnails = `?view=thumbnails&designId=${designId}&version=19`;
      expect((await fetch(origin + thumbnails)).status).toBe(404);
      expect((await fetch(origin.replace(project, 'outside-project') + thumbnails, { headers })).status).toBe(404);
      const unavailable = await fetch(origin + thumbnails, { headers });
      expect(unavailable.status).toBe(200);
      expect(unavailable.headers.get('cache-control')).toBe('private, no-store');
      expect(await unavailable.json()).toMatchObject({ designId, version: 19, state: 'unavailable', total: 1, completed: 0, renders: {} });
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});

// 3 秒合成纯色 H.264，验证实际容器数据，测试运行时无需转码工具。
const mp4 = Buffer.from(`
AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAMsbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAC7gAAQAA
AQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAgAAAld0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAC7gAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAA
AAAAAAABAAAAAAAAAAAAAAAAAABAAAAAABAAAAAQAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAu4AAAAAAABAAAAAAHP
bWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAABAAAAAwABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRl
b0hhbmRsZXIAAAABem1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAA
AQAAATpzdGJsAAAAtnN0c2QAAAAAAAAAAQAAAKZhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAABAAEABIAAAASAAAAAAA
AAABFUxhdmM2MS4xOS4xMDEgbGlieDI2NAAAAAAAAAAAAAAAGP//AAAALGF2Y0MBQsAK/+EAFWdCwAraewEQAAADABAAAAMA
KPEiagEABGjOD8gAAAAQcGFzcAAAAAEAAAABAAAAFGJ0cnQAAAAAAAAAbQAAAAAAAAAYc3R0cwAAAAAAAAABAAAAAwAAQAAA
AAAUc3RzcwAAAAAAAAABAAAAAQAAABxzdHNjAAAAAAAAAAEAAAABAAAAAwAAAAEAAAAgc3RzegAAAAAAAAAAAAAAAwAAABcA
AAAJAAAACQAAABRzdGNvAAAAAAAAAAEAAANcAAAAYXVkdGEAAABZbWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAbWRpcmFwcGwA
AAAAAAAAAAAAAAAsaWxzdAAAACSpdG9vAAAAHGRhdGEAAAABAAAAAExhdmY2MS43LjEwMwAAAAhmcmVlAAAAMW1kYXQAAAAT
ZYiEOhGKAAIxccAAQ8o4AAgF4AAAAAVBmiAUpQAAAAVBmkAVpQ==
`, 'base64');
const demo = [{ screen: 'demo', title: '演示入口', tip: '先打开稿件。' }];
const video = {
  page: 'accept', file: 'videos/example.mp4', title: '验收方式演示', chapters: [
    { method: 'mece', title: '覆盖', start: 0 },
    { method: 'compare', title: '对照', start: 1 },
  ],
};

function demoBundle(overrides: Record<string, unknown> = {}, media: Buffer | null = mp4,
  extraFiles: { name: string; data: Buffer }[] = [], format: 'publication' | 'historical' = 'publication') {
  const manifest = {
    project, title: '合成演示稿', prototypeVersion: 1, date: '2026-11-25',
    prototype: 'dist/index.html', rationale: '思路.md', checks: 'checks/result.json', docs: [], notes: '使用合成画面。',
    screens: [{ id: 'demo', name: '演示画面', route: '#/demo', viewport: 'desktop', themes: ['light'], entryReadySelector: 'main' }],
    acceptance: [{
      id: 'A-01', screenId: 'demo', how: 'measure', rule: '画面能打开', expected: '主体显示。检查：main 可见。',
    }],
    demo, videos: [video], ...overrides,
  };
  return buildZip([
    { name: 'design.json', data: JSON.stringify(format === 'publication' ? withAcceptanceStandard(manifest) : manifest) },
    { name: '思路.md', data: '# 思路（V1）\n按照合成画面核对。' },
    { name: '交付说明.md', data: '# 交付（V1）\n在验收页打开受保护视频。' },
    { name: 'dist/index.html', data: '<!doctype html><html><body><main>合成画面</main></body></html>' },
    { name: 'checks/result.json', data: JSON.stringify({ passed: 1, total: 1, items: [{ name: '打开画面', pass: true }] }) },
    { name: 'versions.json', data: JSON.stringify({ versions: [] }) },
    { name: 'changes/index.json', data: JSON.stringify({ to: 1, from: [] }) },
    ...(media === null ? [] : [{ name: video.file, data: media }]),
    ...extraFiles,
  ]);
}

describe('V20 演示流程和视频归档', () => {
  it.each([
    ['演示引用不存在的画面', () => demoBundle({ demo: [{ ...demo[0], screen: 'missing' }] })],
    ['视频为包外链接', () => demoBundle({ videos: [{ ...video, file: 'https://example.test/external.mp4' }] })],
    ['视频未随包提供', () => demoBundle({}, null)],
    ['文件带 MP4 后缀但内容不可识别', () => demoBundle({}, Buffer.from('这是一段纯文本'))],
    ['章节方法重复', () => demoBundle({ videos: [{ ...video, chapters: [video.chapters[0], { ...video.chapters[0], start: 1 }] }] })],
    ['章节秒数倒序', () => demoBundle({ videos: [{ ...video, chapters: [...video.chapters].reverse() }] })],
  ])('拒绝%s', async (_label, make) => {
    await expect(readDesignPackage(make())).rejects.toMatchObject({ status: 400 });
  });

  it('在发布时保存流程与章节，新版本关联同项目的归档视频', async () => {
    const store = memoryStore();
    const service = new DesignWorkspaceService(store);
    await service.publish(project, reviewer, {
      requestId: 'demo-video-publication', intent: 'create', sourceMode: 'private', designKey: 'fixture/demo',
      sourcePath: 'design/fixture-demo', sourceCommit: 'c'.repeat(40),
    }, demoBundle());
    const revision = (await store.read(project, 0))[0];
    expect(revision.design?.version).toMatchObject({ demo, videos: [video] });
    expect(revision.design?.version?.delivery?.files).toContainEqual(expect.objectContaining({ path: video.file, size: mp4.length }));
  });

  it('只在打开版本后从旧签发归档加载流程和视频，保留原始记录', async () => {
    const bytes = demoBundle({}, mp4, [], 'historical');
    const parsed = await readDesignPackage(bytes);
    const archiveId = 'legacy-v20-archive';
    const record: DesignWorkspaceCommit = {
      projectId: project, revision: 1, request: {
        key: 'legacy-v20', fingerprint: 'legacy-v20', result: { type: 'package', designId, version: 20 },
      },
      assets: [{ id: archiveId, mime: 'application/zip', base64: bytes.toString('base64') }],
      design: { id: designId, version: {
        ...published(20), sha256: parsed.sha256, screens: parsed.screens, acceptance: parsed.acceptance,
        delivery: { archiveId, archiveRoot: parsed.delivery.archiveRoot, warnings: [],
          files: parsed.delivery.index.map((file, index) => ({ ...file, id: `legacy-file-${index}` })) },
      } },
    };
    const store = memoryStore([record]);
    const archiveReads: string[] = [];
    const originalReadAsset = store.readAsset!;
    store.readAsset = (projectId, revision, id) => {
      archiveReads.push(id);
      return originalReadAsset(projectId, revision, id);
    };
    const service = new DesignWorkspaceService(store);
    await service.workspace(project, reviewer, { summary: true });
    expect(archiveReads).toEqual([]);
    const detail = await service.workspace(project, reviewer, { designId, version: 20 });
    expect(detail.designs[0].versions[0]).toMatchObject({ version: 20, demo, videos: [video] });
    expect([...new Set(archiveReads)]).toEqual([archiveId]);
    expect(await store.read(project, 0)).toEqual([record]);
  });
});

function referencePng(width: number, height: number) {
  const chunk = (name: string, data: Buffer) => {
    const bytes = Buffer.alloc(data.length + 12);
    bytes.writeUInt32BE(data.length);
    bytes.write(name, 4, 'ascii');
    data.copy(bytes, 8);
    bytes.writeUInt32BE(crc32(bytes.subarray(4, data.length + 8)), data.length + 8);
    return bytes;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.alloc((width * 3 + 1) * height))), chunk('IEND', Buffer.alloc(0))]);
}

function referenceFixture(referenceCapture: DesignReferenceCapture, bundle = demoBundle()) {
  const store = memoryStore();
  const service = new DesignWorkspaceService(store, { referenceCapture });
  return {
    store, service,
    async publish() {
      const receipt = await service.publish(project, reviewer, {
        requestId: 'reference-publication', intent: 'create', sourceMode: 'private', designKey: 'fixture/reference',
        sourcePath: 'design/fixture-reference', sourceCommit: 'c'.repeat(40),
      }, bundle);
      return receipt.result.designId!;
    },
    async version(id: string) {
      return (await service.workspace(project, reviewer, { designId: id, version: 1 })).designs[0].versions[0];
    },
    generate(id: string, actor = reviewer) {
      return service.command(project, actor, {
        type: 'reference.generate', requestId: 'reference-retry', designId: id, version: 1,
      });
    },
  };
}

describe('V20 自动生成对照图', () => {
  const desktop = referencePng(1280, 800);

  it('私有发布后为已声明的画面生成对应的 PNG，项目外无法读取', async () => {
    const capture = vi.fn(async function* (prototype: Buffer, targets: Parameters<DesignReferenceCapture>[1]) {
      for (const target of targets) yield { ...target, bytes: desktop };
    });
    const fixture = referenceFixture(capture);
    const id = await fixture.publish();
    const sha256 = createHash('sha256').update(desktop).digest('hex');
    await vi.waitFor(async () => expect((await fixture.version(id)).renders?.demo?.light).toMatchObject({ sha256 }));
    expect(capture).toHaveBeenCalledOnce();
    const [prototype, targets] = capture.mock.calls[0];
    expect(prototype.toString('utf8')).toContain('<main>合成画面</main>');
    expect(targets).toEqual([{
      screen: expect.objectContaining({ id: 'demo', route: '#/demo', viewport: 'desktop' }), theme: 'light',
    }]);
    const assetId = (await fixture.version(id)).renders!.demo.light!.id;
    expect(await fixture.service.artifact(project, reviewer, assetId)).toMatchObject({ mime: 'image/png', bytes: desktop });
    await expect(fixture.service.artifact('different-project', reviewer, assetId)).rejects.toMatchObject({ status: 404 });
    await expect(fixture.service.artifact(project, { ...reviewer, permissions: ['write'] }, assetId))
      .rejects.toMatchObject({ status: 404 });
  });

  it('拒绝尺寸不符的结果，生成服务失败后可用原请求编号重试', async () => {
    const wrongSize = referencePng(375, 812);
    let attempts = 0;
    const fixture = referenceFixture(async function* (_prototype, targets) {
      attempts++;
      if (attempts === 1) yield { ...targets[0], bytes: wrongSize };
      if (attempts < 5) throw new Error('合成截图服务故障');
      yield { ...targets[0], bytes: desktop };
    });
    const id = await fixture.publish();
    const status = () => fixture.service.thumbnailStatus(project, reviewer, id, 1);
    await vi.waitFor(async () => expect(await status()).toMatchObject({ state: 'incomplete', completed: 0 }));
    expect(attempts).toBe(2);
    expect((await fixture.version(id)).renders?.demo?.light).toBeUndefined();
    await expect(fixture.generate(id, { ...reviewer, permissions: ['read', 'write'] })).rejects.toMatchObject({ status: 403 });
    expect((await fixture.generate(id)).result).toMatchObject({ type: 'reference.generate', designId: id, version: 1 });
    await vi.waitFor(async () => expect(await status()).toMatchObject({ state: 'incomplete', completed: 0 }));
    expect(attempts).toBe(4);
    expect((await fixture.version(id)).renders?.demo?.light).toBeUndefined();
    expect((await fixture.generate(id)).reused).toBe(true);
    await vi.waitFor(async () => expect((await fixture.version(id)).renders?.demo?.light).toBeDefined());
    expect(attempts).toBe(5);
  });

  it('按版本回读随稿图和生成进度，部分失败后沿用请求编号只补缺图', async () => {
    const archive = demoBundle({ screens: [
      { id: 'demo', name: '演示画面', route: '#/demo', viewport: 'desktop', themes: ['light', 'dark'], entryReadySelector: 'main' },
      { id: 'second', name: '第二画面', route: '#/second', viewport: 'desktop', themes: ['light'], entryReadySelector: 'main' },
    ] }, mp4, [{ name: 'screens/demo.light.png', data: desktop }]);
    let release!: () => void;
    const paused = new Promise<void>(resolve => { release = resolve; });
    const capture = vi.fn(async function* (_prototype: Buffer, targets: Parameters<DesignReferenceCapture>[1]) {
      if (capture.mock.calls.length === 1) {
        await paused;
        yield { ...targets[0], bytes: desktop };
        throw new Error('合成浏览器未能完成本轮');
      }
      if (capture.mock.calls.length < 5) throw new Error('合成浏览器暂不可用');
      for (const target of targets) yield { ...target, bytes: desktop };
    });
    const fixture = referenceFixture(capture, archive);
    const reader: DesignActor = { ...reviewer, permissions: ['read'] };
    try {
      const id = await fixture.publish();
      const read = () => fixture.service.thumbnailStatus(project, reader, id, 1);
      await vi.waitFor(() => expect(capture).toHaveBeenCalledOnce());
      const running = await read();
      expect(running).toMatchObject({ designId: id, version: 1, state: 'running', total: 3, completed: 1 });
      const published = running.renders.demo.light;
      expect(published).toMatchObject({ sha256: createHash('sha256').update(desktop).digest('hex') });
      expect(running.renders.demo.dark).toBeUndefined();
      await expect(fixture.generate(id, reader)).rejects.toMatchObject({ status: 403 });
      await expect(fixture.service.thumbnailStatus(project, { ...reader, permissions: ['write'] }, id, 1))
        .rejects.toMatchObject({ status: 404 });

      release();
      await vi.waitFor(async () => expect(await read()).toMatchObject({ state: 'incomplete', total: 3, completed: 2 }));
      const dark = (await read()).renders.demo.dark;
      expect(dark).toBeDefined();
      expect((await fixture.generate(id)).reused).toBe(false);
      await vi.waitFor(async () => {
        expect(capture).toHaveBeenCalledTimes(4);
        expect(await read()).toMatchObject({ state: 'incomplete', total: 3, completed: 2 });
      });
      expect((await fixture.generate(id)).reused).toBe(true);
      await vi.waitFor(async () => expect(await read()).toMatchObject({ state: 'ready', total: 3, completed: 3 }));
      const ready = await read();
      expect(ready.renders.demo).toEqual({ light: published, dark });
      expect(ready.renders.second.light).toBeDefined();
      expect(capture.mock.calls.map(([, targets]) => targets.map(({ screen, theme }) => `${screen.id}/${theme}`))).toEqual([
        ['demo/dark', 'second/light'], ['second/light'], ['second/light'], ['second/light'], ['second/light'],
      ]);
      expect((await fixture.service.workspace(project, reviewer, { designId: id, version: 1 })).designs[0].runs).toEqual([]);
    } finally {
      release();
    }
  });

  it('无需重新提交或点击重试即可自动补齐未完成的缩略图', async () => {
    const archive = demoBundle({ screens: [
      { id: 'demo', name: '演示画面', route: '#/demo', viewport: 'desktop', themes: ['light', 'dark'], entryReadySelector: 'main' },
      { id: 'second', name: '第二画面', route: '#/second', viewport: 'desktop', themes: ['light'], entryReadySelector: 'main' },
    ] }, mp4, [{ name: 'screens/demo.light.png', data: desktop }]);
    let firstImageId: string | undefined;
    const capture = vi.fn(async function* (_prototype: Buffer, targets: Parameters<DesignReferenceCapture>[1]) {
      for (const target of targets) {
        yield { ...target, bytes: desktop };
        if (capture.mock.calls.length === 1) throw new Error('合成浏览器中断');
      }
    });
    const fixture = referenceFixture(capture, archive);
    const id = await fixture.publish();
    const read = () => fixture.service.thumbnailStatus(project, reviewer, id, 1);
    await vi.waitFor(async () => {
      const status = await read();
      firstImageId ??= status.renders.demo.light.id;
      expect(status).toMatchObject({ state: 'ready', total: 3, completed: 3 });
    });
    expect((await read()).renders.demo.light.id).toBe(firstImageId);
    expect(capture.mock.calls.map(([, targets]) => targets.map(({ screen, theme }) => `${screen.id}/${theme}`)))
      .toEqual([['demo/dark', 'second/light'], ['second/light']]);
  });

  it('签收后的版本拒绝再次生成，并保护已经排队但还没写入的证据', async () => {
    let release!: () => void;
    const paused = new Promise<void>(resolve => { release = resolve; });
    const capture = vi.fn(async function* (_prototype, targets: Parameters<DesignReferenceCapture>[1]) {
      await paused;
      yield { ...targets[0], bytes: desktop };
    });
    const fixture = referenceFixture(capture);
    try {
      const id = await fixture.publish();
      await vi.waitFor(() => expect(capture).toHaveBeenCalledOnce());
      const signed: DesignRun = { ...originalRun, version: 1, verdict: 'passed',
        signed: { at: enabledAt, by: reviewer.id, verdict: 'passed' } };
      expect(await fixture.store.append({
        projectId: project, revision: 2, request: {
          key: 'older-accepted-run', fingerprint: 'older-accepted-run', result: { type: 'acceptance.sign', designId: id },
        }, design: { id, run: signed },
      })).toBe(true);
      await expect(fixture.generate(id)).rejects.toMatchObject({ status: 409 });
      expect(await fixture.service.thumbnailStatus(project, reviewer, id, 1))
        .toMatchObject({ designId: id, version: 1, state: 'locked', total: 1, completed: 0, renders: {} });
      release();
      await nextTurn();
      expect((await fixture.version(id)).renders?.demo?.light).toBeUndefined();
      expect(capture).toHaveBeenCalledOnce();
      const revisions = await fixture.store.read(project, 0);
      expect(revisions).toHaveLength(2);
      expect(revisions[1].design?.run).toEqual(signed);
      expect(revisions.flatMap(row => row.assets ?? []).map(asset => asset.mime)).toEqual(['application/zip']);
    } finally {
      release();
    }
  });
});
