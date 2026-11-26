import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDesignWorkspaceRouter } from '../../src/routes/design-workspace.js';
import { DesignWorkspaceService, type DesignActor, type DesignWorkspaceCommit } from '../../src/services/design-workspace.js';
import { FileProjectRevisionStore } from '../../src/services/project-revision-store.js';
import { designProgramEvidenceRequired } from '../../src/shared/design-workspace.js';
import { buildZip } from '../../src/utils/zip.js';

const projectId = 'design-gate-fixture';
const firstCommit = 'a'.repeat(40);
const secondCommit = 'b'.repeat(40);
const designer: DesignActor = { kind: 'agent', id: 'designer', label: 'Fixture designer', permissions: ['read', 'write'] };
const emptySets = () => ({ added: [], removed: [], changed: [] });
const emptyCounts = () => ({ added: 0, removed: 0, changed: 0 });

function fixture(version = 1, sourceCommit = firstCommit) {
  const screen = { id: 'entry', name: '入口', route: '#/entry', viewport: 'desktop', themes: ['light'], entryReadySelector: 'main' };
  const rule = { id: 'A-01', rule: '页面可以打开', expected: '页面主区域显示。检查：main 可见。', how: 'measure', screenId: 'entry' };
  const manifest = { project: projectId, title: '门禁测试', prototypeVersion: 1, date: '2026-11-24', rationale: '思路.md',
    prototype: 'dist/index.html', checks: 'checks/result.json', docs: ['细节.md'], notes: '', screens: [screen], acceptance: [rule] };
  const check = { name: '原型可打开', pass: true };
  const checks = { passed: 1, total: 1, items: [check] };
  const directory = `changes/v1-v${version}`;
  const summaryPath = `${directory}/summary.json`;
  const markdownPath = `${directory}/changes.md`;
  const previous = { version: 1, commit: sourceCommit };
  const row = { ...previous, files: [summaryPath, markdownPath], acceptance: emptyCounts(), screens: emptyCounts(), sourceFiles: 0 };
  const registry = { versions: version === 1 ? [] : [previous] };
  const index = { to: version, from: version === 1 ? [] : [row] };
  const summary = { from: previous, to: { version, commit: null }, direction: 'upgrade', acceptance: emptySets(), screens: emptySets(), source: { files: 0, bytes: 0 } };
  const files = new Map<string, string | Buffer>([
    ['思路.md', `# 思路（V${version}）\n采用示例数据。`],
    ['交付说明.md', `# 交付（V${version}）\n打开原型。`],
    ['细节.md', '联系 example@example.org。'],
    ['dist/index.html', '<!doctype html><main>示例</main>'],
    ...(version === 1 ? [] : [[markdownPath, '# 版本差异\n两版本画面无变化。'] as [string, string]]),
  ]);
  const json = new Map<string, unknown>([
    ['design.json', manifest], ['checks/result.json', checks], ['versions.json', registry], ['changes/index.json', index],
    ...(version === 1 ? [] : [[summaryPath, summary] as [string, unknown]]),
  ]);
  const zip = () => buildZip([...files, ...[...json].map(([name, body]) => [name, JSON.stringify(body)] as const)].map(([name, data]) => ({ name, data })));
  return { zip, files, json, manifest, screen, rule, checks, check, registry, index, row, summary };
}

describe('设计发布门禁', () => {
  let directory: string;
  let service: DesignWorkspaceService;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'design-gate-fixture-'));
    service = new DesignWorkspaceService(new FileProjectRevisionStore<DesignWorkspaceCommit>(directory), {
      publicBaseUrl: 'https://cds.owner.test',
    });
  });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  const first = { requestId: 'create', intent: 'create', sourceMode: 'private',
    designKey: 'fixture/gate', sourcePath: 'design/fixture', sourceCommit: firstCommit };

  it.each([
    ['G-01', ({ manifest }: ReturnType<typeof fixture>) => { manifest.date = 'tomorrow'; }],
    ['G-02', ({ screen }: ReturnType<typeof fixture>) => { screen.entryReadySelector = ' '; }],
    ['G-03', ({ rule }: ReturnType<typeof fixture>) => { rule.expected = '页面主区域显示。'; }],
    ['G-04', ({ files }: ReturnType<typeof fixture>) => { files.delete('细节.md'); }],
    ['G-05', ({ checks, check }: ReturnType<typeof fixture>) => { checks.passed = 0; check.pass = false; }],
    ['G-06', ({ files }: ReturnType<typeof fixture>) => { files.set('交付说明.md', '# 交付（V1）\n稍后待填'); }],
    ['G-07', ({ json }: ReturnType<typeof fixture>) => { json.delete('versions.json'); json.delete('changes/index.json'); }],
    ['G-08', ({ files }: ReturnType<typeof fixture>) => { files.set('细节.md', '联系 member@company.test。'); }],
    ['G-09', ({ files }: ReturnType<typeof fixture>) => { files.set('attachment.bin', randomBytes(3_986_000)); }],
  ] as const)('驳回 %s，保留原请求编号供修正后重试', async (code, mutate) => {
    const invalid = fixture();
    mutate(invalid);
    await expect(service.publish(projectId, designer, first, invalid.zip())).rejects.toMatchObject({ status: 400, code });
    expect((await service.workspace(projectId, designer)).designs).toHaveLength(0);
    await expect(service.publish(projectId, designer, first, fixture().zip())).resolves.toMatchObject({ result: { version: 1 } });
  });

  it('以 CDS 发布记录为准校验历史和净变化，拒绝漏报、伪造提交及计数', async () => {
    const original = await service.publish(projectId, designer, first, fixture().zip());
    const request = { ...first, requestId: 'revise', intent: 'revise', sourceCommit: secondCommit,
      designId: original.result.designId, expectedVersion: '1' };
    const missing = fixture(2);
    missing.registry.versions.length = 0;
    await expect(service.publish(projectId, designer, request, missing.zip())).rejects.toMatchObject({ code: 'G-07' });
    await expect(service.publish(projectId, designer, request, fixture(2, 'c'.repeat(40)).zip())).rejects.toMatchObject({ code: 'G-07' });
    const wrongCount = fixture(2);
    wrongCount.row.screens.changed = 1;
    await expect(service.publish(projectId, designer, request, wrongCount.zip())).rejects.toMatchObject({ code: 'G-07' });
    const hiddenChange = fixture(2);
    hiddenChange.screen.name = '变动了的入口';
    await expect(service.publish(projectId, designer, request, hiddenChange.zip())).rejects.toMatchObject({ code: 'G-07' });
    const valid = fixture(2).zip();
    await expect(service.publish(projectId, designer, request, valid)).resolves.toMatchObject({ result: { version: 2 } });
    await expect(service.publish(projectId, designer, request, valid)).resolves.toMatchObject({ reused: true, result: { version: 2 } });
  });

  it('记录实际为布尔值，未通过的自检可附负责人和理由', async () => {
    const source = fixture();
    source.check.pass = false;
    source.checks.passed = 0;
    source.json.set('tools/gate-allow.json', { checks: [{ name: source.check.name, owner: '实现方', reason: '另有改动追踪。' }] });
    source.json.set('checks/result.json', { passed: 1, total: 1, items: [{ ...source.check, pass: 'false' }] });
    await expect(service.publish(projectId, designer, first, source.zip())).rejects.toMatchObject({ code: 'G-05' });
    source.json.set('checks/result.json', source.checks);
    await expect(service.publish(projectId, designer, first, source.zip())).resolves.toMatchObject({ result: { version: 1 } });
  });

  it('HTTP 发布拒绝返回规则编号，隐私错误省略原值，修正后沿用请求编号', async () => {
    const app = express();
    app.use('/api', createDesignWorkspaceRouter({ service, resolveAccess: () => designer }));
    const server = app.listen(0, '127.0.0.1');
    try {
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('fixture server address unavailable');
      const endpoint = `http://127.0.0.1:${address.port}/api/projects/${projectId}/design/packages?${new URLSearchParams(first)}`;
      const submit = (bytes: Buffer) => fetch(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: new Uint8Array(bytes),
      });
      const invalid = fixture();
      invalid.files.set('dist/index.html', '<!doctype html><main>member@company.test</main>');
      const denied = await submit(invalid.zip());
      const error = await denied.json();
      expect(denied.status).toBe(400);
      expect(error.error).toBe('G-08');
      expect(JSON.stringify(error)).not.toContain('member@company.test');
      expect((await service.workspace(projectId, designer)).designs).toHaveLength(0);
      const valid = fixture().zip();
      expect((await submit(valid)).status).toBe(201);
      const replay = await submit(valid);
      expect(replay.status).toBe(200);
      expect((await replay.json()).reused).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it('隐私门禁使用服务端域名并检查文本附件，上传的例外无法放行邮箱或凭据', async () => {
    const source = fixture();
    const marker = 'cdsp_' + 'x'.repeat(32);
    source.json.set('tools/gate-allow.json', { checks: [], forbiddenHosts: [] });
    source.files.set('细节.md', '原型链接 https://CDS.OWNER.TEST./demo');
    await expect(service.publish(projectId, designer, first, source.zip())).rejects.toMatchObject({ code: 'G-08' });
    source.files.set('细节.md', Buffer.concat([Buffer.from([0xff, 0x00]), Buffer.from(marker)]));
    await expect(service.publish(projectId, designer, first, source.zip())).rejects.toMatchObject({ code: 'G-08' });
    source.files.set('细节.md', '联系 fixture@example.com。');
    await expect(service.publish(projectId, designer, first, source.zip())).resolves.toMatchObject({ result: { version: 1 } });
  });

  it('验收模式、适用手段、覆盖风险与需求条款可回读且受结构校验', async () => {
    const source = fixture();
    const risk = { dimension: 'correctness', risk: '入口打不开', ruleIds: ['A-02'] };
    source.json.set('design.json', { ...source.manifest, acceptanceMode: 'objective',
      acceptance: [{ ...source.rule, requirementRef: 'R-01' }],
      acceptancePlan: { flow: { applicable: true, enabled: false }, regress: { applicable: true } }, risks: [risk] });
    await expect(service.publish(projectId, designer, first, source.zip())).rejects.toMatchObject({ status: 400 });
    risk.ruleIds = ['A-01'];
    await expect(service.publish(projectId, designer, first, source.zip())).resolves.toMatchObject({ result: { version: 1 } });
    expect((await service.workspace(projectId, designer)).designs[0].versions[0]).toMatchObject({
      acceptanceMode: 'objective', risks: [risk], acceptance: [{ requirementRef: 'R-01' }],
      acceptancePlan: { flow: { applicable: true, enabled: false }, regress: { applicable: true } },
    });
  });

  it('明确声明程序取证时校验协议和两份演示源码，续版仍保留协议', async () => {
    const source = fixture();
    source.json.set('design.json', { ...source.manifest, evidenceProtocol: 'program-v2' });
    await expect(service.publish(projectId, designer, first, source.zip())).rejects.toMatchObject({
      status: 400, message: expect.stringContaining('协议'),
    });

    source.json.set('design.json', { ...source.manifest, evidenceProtocol: 'program-v1' });
    const fixtureScript = 'export const fixtures = { count: 3 };';
    const fixtureData = 'export const project = "fixture-demo";';
    source.files.set('src/fixtures.ts', fixtureScript);
    await expect(service.publish(projectId, designer, first, source.zip())).rejects.toMatchObject({
      status: 400, message: expect.stringContaining('演示'),
    });
    expect((await service.workspace(projectId, designer)).designs).toEqual([]);

    source.files.set('src/data-design.ts', fixtureData);
    const created = await service.publish(projectId, designer, first, source.zip());
    const designId = created.result.designId!;
    const readPublished = async () => (await service.workspace(projectId, designer)).designs[0].versions;
    expect((await readPublished())[0]).toMatchObject({ version: 1, evidenceProtocol: 'program-v1' });

    const revision = fixture(2);
    revision.files.set('src/fixtures.ts', fixtureScript);
    revision.files.set('src/data-design.ts', fixtureData);
    await service.publish(projectId, designer, {
      ...first, designId, sourceCommit: secondCommit, requestId: 'continue-proof-protocol', intent: 'revise', expectedVersion: '1',
    }, revision.zip());
    const versions = await readPublished();
    expect(versions.map(version => [version.version, version.evidenceProtocol])).toEqual([[1, 'program-v1'], [2, 'program-v1']]);
    expect(versions.every(designProgramEvidenceRequired)).toBe(true);
  });

  it('兼容了带 A-71 完整证据要求的已发布旧稿，同时保留普通旧稿的原签收契约', async () => {
    const legacy = fixture();
    legacy.rule.id = 'A-71';
    legacy.rule.how = 'human';
    legacy.rule.expected = '证据只认程序产生的，签收前由设计方独立重跑。';
    const old = await service.publish(projectId, designer, first, legacy.zip());
    const plain = await service.publish(projectId, designer, {
      ...first, requestId: 'create-plain-legacy', designKey: 'fixture/plain', sourcePath: 'design/plain',
    }, fixture().zip());

    const { designs } = await service.workspace(projectId, designer);
    const legacyVersion = designs.find(draft => draft.id === old.result.designId)!.versions[0];
    const plainVersion = designs.find(draft => draft.id === plain.result.designId)!.versions[0];
    expect(legacyVersion.evidenceProtocol).toBeUndefined();
    expect(designProgramEvidenceRequired(legacyVersion)).toBe(true);
    expect(designProgramEvidenceRequired(plainVersion)).toBe(false);
  });

  it('V23 发布校验数据集摘要，Windows 换行与 LF 一致，并保存目标到版本', async () => {
    const files = ['src/fixtures.ts', 'src/data-design.ts'];
    const fixtureScript = 'export const fixtures = { count: 3 };\nexport const ready = true;\n';
    const fixtureData = 'export const project = "fixture-demo";\n';
    const sha256 = createHash('sha256').update(fixtureScript + fixtureData).digest('hex');
    const goals = [
      { id: 'G-01', goal: '入口可用', doneWhen: '用户看到页面主区。', items: ['A-01'] },
      { id: 'G-02', goal: '项目拥有独立发布规则', doneWhen: '可以查到发布规则。', items: [], where: '门禁 G-08' },
    ];
    const demoData = { files, sha256, note: '两边使用同一组演示数据。' };
    const source = fixture();
    source.files.set(files[0], fixtureScript.replaceAll('\n', '\r\n'));
    source.files.set(files[1], fixtureData.replaceAll('\n', '\r\n'));
    source.json.set('design.json', { ...source.manifest, goals, demoData: { ...demoData, sha256: 'a'.repeat(64) } });
    await expect(service.publish(projectId, designer, first, source.zip())).rejects.toMatchObject({ status: 400 });
    source.json.set('design.json', {
      ...source.manifest, demoData, goals: [{ ...goals[0], items: ['A-unknown'] }, goals[1]],
    });
    await expect(service.publish(projectId, designer, first, source.zip())).rejects.toMatchObject({ status: 400 });
    expect((await service.workspace(projectId, designer)).designs).toEqual([]);

    source.json.set('design.json', { ...source.manifest, goals, demoData });
    const crlf = await service.publish(projectId, designer, first, source.zip());
    source.files.set(files[0], fixtureScript);
    source.files.set(files[1], fixtureData);
    const lf = await service.publish(projectId, designer, {
      ...first, requestId: 'same-demo-lf', designKey: 'fixture/lf', sourcePath: 'design/fixture-lf',
    }, source.zip());

    const { designs } = await service.workspace(projectId, designer);
    const left = designs.find(draft => draft.id === crlf.result.designId)!.versions[0];
    const right = designs.find(draft => draft.id === lf.result.designId)!.versions[0];
    expect(left).toMatchObject({ demoData, goals });
    expect(right).toMatchObject({ demoData, goals });
    expect(left.sha256).not.toBe(right.sha256);
    expect(designProgramEvidenceRequired(left)).toBe(true);
    expect(designProgramEvidenceRequired(right)).toBe(true);

    const revision = fixture(2);
    revision.files.set(files[0], fixtureScript);
    revision.files.set(files[1], fixtureData);
    await expect(service.publish(projectId, designer, {
      ...first, designId: crlf.result.designId, sourceCommit: secondCommit, requestId: 'v23-drop-dataset',
      intent: 'revise', expectedVersion: '1',
    }, revision.zip())).rejects.toMatchObject({ status: 400, message: expect.stringContaining('演示数据摘要') });
    expect((await service.workspace(projectId, designer)).designs.find(draft => draft.id === crlf.result.designId)?.versions).toHaveLength(1);
  });

  it('V23 用旧服务发布时，打开详情从校验过的私有归档补读数据和目标', async () => {
    const source = fixture();
    const files = ['src/fixtures.ts', 'src/data-design.ts'];
    const fixtureScript = 'export const fixtures = { count: 3 };\n';
    const fixtureData = 'export const active = true;\n';
    source.files.set(files[0], fixtureScript);
    source.files.set(files[1], fixtureData);
    const demoData = { files, sha256: createHash('sha256').update(fixtureScript + fixtureData).digest('hex') };
    const goals = [{ id: 'G-01', goal: '证据来自程序', doneWhen: '同样条件下的独立复验一致。', items: ['A-71'] }];
    source.json.set('design.json', {
      ...source.manifest, demoData, goals, demo: [{ screen: source.screen.id, title: '打开入口' }],
      acceptance: [{ ...source.rule, id: 'A-71', how: 'human',
        expected: '证据只认程序产生。按 demoData.sha256 校验并由设计方独立重跑。' }],
    });
    const archive = source.zip();
    const published = await service.publish(projectId, designer, first, archive);
    const designId = published.result.designId!;
    const latest = (await service.workspace(projectId, designer)).designs[0].versions[0];
    const { demoData: _demoData, goals: _goals, evidenceProtocol: _protocol, ...fieldsSavedByOldCds } = latest;
    const archived = { ...fieldsSavedByOldCds, version: 23 };
    const store = new FileProjectRevisionStore<DesignWorkspaceCommit>(path.join(directory, 'archive-before-upgrade'));
    await store.append({
      projectId, revision: 1, request: { key: 'prior-publish', fingerprint: 'prior-publish', result: { type: 'package', designId } },
      design: { id: designId, version: archived },
      assets: [{ id: archived.delivery!.archiveId, mime: 'application/zip', base64: archive.toString('base64') }],
    });
    const upgraded = new DesignWorkspaceService(store);
    const detail = await upgraded.workspace(projectId, designer, { designId, version: 23 });
    expect(detail.designs[0].versions).toMatchObject([{ version: 23, demoData, goals, demo: latest.demo }]);
    expect((await store.read(projectId, 0))[0].design?.version).toEqual(archived);
  });
});
