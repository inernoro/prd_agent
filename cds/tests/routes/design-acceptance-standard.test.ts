import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDesignWorkspaceRouter } from '../../src/routes/design-workspace.js';
import { DesignWorkspaceService, type DesignActor, type DesignWorkspaceCommit } from '../../src/services/design-workspace.js';
import { FileProjectRevisionStore } from '../../src/services/project-revision-store.js';
import { designCoverage, designMethodPlanEnabled, designMethodsState } from '../../src/shared/design-methods.js';
import { buildZip } from '../../src/utils/zip.js';

const projectId = 'design-standard-fixture';
const firstCommit = 'a'.repeat(40);
const nextCommit = 'b'.repeat(40);
const date = '2026-11-25';
const sourcePath = 'design/fixture';
const designer: DesignActor = { kind: 'agent', id: 'fixture-designer', label: '示例出稿人', permissions: ['read', 'write'] };
const dimensions = ['correctness', 'compatibility', 'performance', 'security', 'operations', 'experience'];
const methods = ['mece', 'compare', 'visual', 'regress', 'flow', 'human', 'smoke', 'debt'];
const applicable = { applicable: true };
const irrelevant = { applicable: false, reason: '本稿只检查离线原型，当前手段没有适用对象。' };
const defaultPlan = { mece: applicable, compare: applicable, visual: applicable, regress: applicable,
  flow: irrelevant, human: irrelevant, smoke: irrelevant, debt: applicable };
const screen = { id: 'entry', name: '入口', route: '#/entry', viewport: 'desktop', themes: ['light'], entryReadySelector: 'main' };
const prototype = '<!doctype html><main>示例入口</main>';
const digest = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');

function rules(count = dimensions.length, classified = true) {
  return Array.from({ length: count }, (_, index) => ({
    id: `A-${String(index + 1).padStart(2, '0')}`, rule: `核对入口 ${index + 1}`, how: 'measure', screenId: screen.id,
    expected: '看到入口。检查：主区可见。', slots: ['desktop-light'],
    dimension: classified ? dimensions[index % dimensions.length] : undefined,
  }));
}

function archiveFiles(overrides: Record<string, unknown>, version: number, extra: Record<string, string>) {
  const previous = { version: 1, commit: firstCommit };
  const prefix = 'changes/v1-v2/';
  const changes = { added: [], removed: [], changed: [] };
  const counts = { added: 0, removed: 0, changed: 0 };
  const older = version > 1 ? [previous] : [];
  return {
    'design.json': JSON.stringify({ project: projectId, title: '验收发布夹具', prototypeVersion: version, date,
      rationale: '思路.md', prototype: 'dist/index.html', checks: 'checks/result.json', docs: [], notes: '',
      screens: [screen], acceptance: rules(), acceptancePlan: defaultPlan, ...overrides }),
    '思路.md': `# 示例思路（V${version}）\n展示虚构入口。`,
    '交付说明.md': `# 示例交付（V${version}）\n打开入口画面。`,
    'dist/index.html': prototype,
    'checks/result.json': JSON.stringify({ items: [{ name: '原型可打开', pass: true }], total: 1, passed: 1 }),
    'versions.json': JSON.stringify({ versions: older }),
    'changes/index.json': JSON.stringify({ to: version, from: older.map(row => ({ ...row,
      files: [prefix + 'summary.json', prefix + 'changes.md'], acceptance: counts, screens: counts, sourceFiles: 0 })) }),
    ...(version > 1 ? {
      [prefix + 'summary.json']: JSON.stringify({ from: previous, to: { version, commit: null }, direction: 'upgrade',
        acceptance: changes, screens: changes, source: { files: 0, bytes: 0 } }),
      [prefix + 'changes.md']: '# 版本差异\n没有画面或验收规则文字的改动。',
    } : {}),
    ...extra,
  };
}

function archive(overrides: Record<string, unknown> = {}, version = 1, extra: Record<string, string> = {}) {
  const entries = Object.entries(archiveFiles(overrides, version, extra));
  return buildZip(entries.map(([name, data]) => ({ name, data, modifiedAt: new Date(`${date}T00:00:00Z`) })));
}

const issue = (field: string, code: string, ruleId?: string) => expect.objectContaining({ field, code, ...(ruleId ? { ruleId } : {}) });

async function serve(service: DesignWorkspaceService, run: (url: string) => Promise<void>,
  resolveAccess: Parameters<typeof createDesignWorkspaceRouter>[0]['resolveAccess'] = () => designer) {
  const app = express();
  app.use('/api', createDesignWorkspaceRouter({ service, resolveAccess }));
  const server = app.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('发布测试服务没有可用的本地地址');
    await run(`http://127.0.0.1:${address.port}/api/projects/${projectId}/design`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

const submit = (endpoint: string, query: Record<string, string>, bytes: Buffer) => fetch(`${endpoint}/packages?${new URLSearchParams(query)}`, {
  method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: new Uint8Array(bytes),
});

describe('稿件发布验收标准', () => {
  let directory: string;
  let store: FileProjectRevisionStore<DesignWorkspaceCommit>;
  let service: DesignWorkspaceService;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'design-standard-fixture-'));
    store = new FileProjectRevisionStore(directory);
    service = new DesignWorkspaceService(store);
  });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it('接入清单只提供已批准的实施目标，续版不会移动锁定的目标', async () => {
    const reviewer: DesignActor = { kind: 'human', id: 'fixture-reviewer', label: '示例评审人', permissions: ['read', 'write', 'approve'] };
    const reader: DesignActor = { kind: 'agent', id: 'fixture-reader', label: '示例实施方', permissions: ['read'] };
    const actors = new Map(Object.entries({ designer, reader, reviewer }));
    await serve(service, async endpoint => {
      const published = await submit(endpoint, { requestId: 'implementation-draft', sourceCommit: firstCommit }, archive());
      expect(published.status).toBe(201);
      const { designId } = (await published.json()).result;
      const readIntake = (role = 'reader') => fetch(`${endpoint}/intake`, { headers: { 'X-Fixture-Role': role } });
      const readTarget = async () => {
        const response = await readIntake();
        expect(response.status).toBe(200);
        const intake = await response.json();
        expect(intake.permissions.write).toBe(false);
        return intake.designs.find((item: { designId: string }) => item.designId === designId);
      };
      const command = (type: string, fields: Record<string, unknown>, role = 'reviewer') => fetch(`${endpoint}/commands`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Fixture-Role': role },
        body: JSON.stringify({ requestId: `fixture-${type}`, type, designId, ...fields }),
      });

      expect((await readIntake('outside')).status).toBe(404);
      expect((await command('implementation.start', { version: 1 }, 'reader')).status).toBe(403);
      expect((await command('implementation.start', { version: 1 }, 'designer')).status).toBe(403);
      expect(await readTarget()).toMatchObject({ latestVersion: 1, implementationTargetVersion: null });

      expect((await command('design.freeze', { version: 1 })).status).toBe(201);
      expect(await readTarget()).toMatchObject({ latestVersion: 1, baselineVersion: 1, implementationTargetVersion: 1 });
      const started = await command('implementation.start', { version: 1, expectedBaseline: 1 });
      expect(started.status).toBe(201);
      const { upgradeId } = (await started.json()).result;
      expect((await submit(endpoint, { requestId: 'implementation-revision', sourceCommit: nextCommit, designId }, archive({}, 2))).status).toBe(201);
      expect(await readTarget()).toMatchObject({ latestVersion: 2, baselineVersion: 1, implementationTargetVersion: 1, sourceCommit: nextCommit,
        upgrade: { id: upgradeId, targetVersion: 1, status: 'active' } });

      expect((await command('implementation.cancel', { upgradeId, reason: '示例成员暂停实施升级。' })).status).toBe(201);
      expect(await readTarget()).toMatchObject({ latestVersion: 2, baselineVersion: 1, implementationTargetVersion: 1,
        upgrade: { id: upgradeId, status: 'cancelled' } });
      expect((await command('design.unfreeze', { version: 1 })).status).toBe(201);
      expect(await readTarget()).toMatchObject({ latestVersion: 2, implementationTargetVersion: null,
        upgrade: { id: upgradeId, status: 'cancelled' } });
    }, (req, selectedProject) => selectedProject === projectId ? actors.get(req.get('X-Fixture-Role') ?? 'designer') ?? null : null);
  });

  it('接入清单优先采用记录中的活跃升级目标，升级完成后采用实施基线', async () => {
    const { result: { designId } } = await service.publish(projectId, designer,
      { requestId: 'stored-upgrade-v1', sourceCommit: firstCommit }, archive());
    await service.publish(projectId, designer,
      { requestId: 'stored-upgrade-v2', sourceCommit: nextCommit, designId }, archive({}, 2));
    const id = designId!;
    const lock = { id: 'fixture-upgrade', fromVersion: 1, targetVersion: 2, startedAt: `${date}T00:00:00Z`, startedBy: 'fixture-reviewer' };
    const storeUpgrade = async (status: 'active' | 'completed', revision: number) => {
      expect(await store.append({ projectId, revision, request: {
        key: `stored-${status}`, fingerprint: `stored-${status}`, result: { type: 'fixture', designId: id },
      }, design: { id, frozen: 1, upgrade: { ...lock, status } } })).toBe(true);
    };
    await serve(service, async endpoint => {
      const read = async () => (await (await fetch(`${endpoint}/intake`)).json()).designs[0];
      await storeUpgrade('active', 3);
      expect(await read()).toMatchObject({ baselineVersion: 1, implementationTargetVersion: 2 });
      await storeUpgrade('completed', 4);
      expect(await read()).toMatchObject({ baselineVersion: 1, implementationTargetVersion: 1 });
    });
  });

  it('经 HTTP 拒绝有 42 条旧式规则的稿件，定位最后一条缺维度的规则，修正后沿用原请求编号', async () => {
    const append = vi.spyOn(store, 'append');
    const request = { requestId: 'forty-two', sourceCommit: firstCommit };
    await serve(service, async endpoint => {
      const oldShape = archive({ acceptance: rules(42, false), acceptancePlan: undefined });
      const first = await submit(endpoint, request, oldShape);
      expect(first.status).toBe(400);
      expect(await first.json()).toMatchObject({ error: 'G-11', issues: expect.arrayContaining([
        issue('acceptancePlan', 'missing_acceptance_plan'),
        ...rules(42).map(({ id }, index) => issue(`acceptance[${index}].dimension`, 'invalid_dimension', id)),
      ]) });

      const attemptedBypass = archive({ acceptance: rules(42), acceptancePlan: undefined }, 1, {
        '设计文档/验收手段.md': '# 验收手段\n示例说明。',
        'tools/gate-allow.json': JSON.stringify({ checks: [{ name: '验收手段', owner: '示例', reason: '示例豁免' }] }),
      });
      const denied = await submit(endpoint, request, attemptedBypass);
      expect(denied.status).toBe(400);
      expect(await denied.json()).toMatchObject({ error: 'G-11', issues: expect.arrayContaining([
        issue('acceptancePlan', 'missing_acceptance_plan'),
      ]) });

      const partiallyClassified = rules(42);
      partiallyClassified[41].dimension = undefined;
      const second = await submit(endpoint, request, archive({ acceptance: partiallyClassified }));
      expect(second.status).toBe(400);
      expect(await second.json()).toMatchObject({ error: 'G-11', issues: expect.arrayContaining([issue('acceptance[41].dimension', 'invalid_dimension', 'A-42')]) });
      expect(append).not.toHaveBeenCalled();
      expect(await store.read(projectId, 0)).toEqual([]);

      const fixed = archive({ acceptance: rules(42) });
      const published = await submit(endpoint, request, fixed);
      expect(published.status).toBe(201);
      expect(await published.json()).toMatchObject({ result: { version: 1 }, reused: false });
      const replay = await submit(endpoint, request, fixed);
      expect(replay.status).toBe(200);
      expect(await replay.json()).toMatchObject({ result: { version: 1 }, reused: true });
      expect(append).toHaveBeenCalledTimes(1);

      const { designs } = await (await fetch(endpoint)).json();
      expect(designs[0].versions[0]).toMatchObject({ acceptanceMode: 'objective', acceptancePlan: defaultPlan, acceptance: rules(42) });
      const version = designs[0].versions[0];
      expect(designMethodsState(version).methods.map(method => method.id)).toEqual(methods);
      expect(designCoverage(version).map(entry => entry.rules.length)).toEqual([7, 7, 7, 7, 7, 7]);
    });
  });

  it.each(['declared', 'private-upload', 'git'] as const)('对 %s 来源的首稿和续版同样拦截，失败发生在资源写入前', async source => {
    const valid = archive();
    const revision = archive({}, 2);
    let committedArchive = archive({ acceptancePlan: {} });
    const sourcePackage = vi.fn(async () => committedArchive);
    service = new DesignWorkspaceService(store, { sourcePackage });
    const append = vi.spyOn(store, 'append');
    const actor = source === 'git' ? { ...designer, gitPublishOnly: true } : designer;
    const intake = source === 'declared' ? {} : { sourcePath, intent: 'create', designKey: 'fixture/entry',
      ...(source === 'private-upload' ? { sourceMode: 'private' } : {}) };
    const first = { ...intake, requestId: 'first', sourceCommit: firstCommit };
    await expect(service.publish(projectId, actor, first, committedArchive)).rejects.toMatchObject({ status: 400, code: 'G-11' });
    expect(append).not.toHaveBeenCalled();
    expect(sourcePackage).not.toHaveBeenCalled();

    committedArchive = valid;
    const { result } = await service.publish(projectId, actor, first, valid);
    const next = { ...intake, requestId: 'next', sourceCommit: nextCommit, designId: result.designId,
      ...(source === 'declared' ? {} : { intent: 'revise', expectedVersion: '1' }) };
    const withoutDimension = rules();
    withoutDimension[3].dimension = undefined;
    committedArchive = archive({ acceptance: withoutDimension }, 2);
    await expect(service.publish(projectId, actor, next, committedArchive))
      .rejects.toMatchObject({ status: 400, code: 'G-11' });
    expect(append).toHaveBeenCalledTimes(1);
    expect(sourcePackage).toHaveBeenCalledTimes(source === 'git' ? 1 : 0);
    expect((await store.read(projectId, 0)).map(commit => commit.design?.version?.version)).toEqual([1]);

    committedArchive = revision;
    await expect(service.publish(projectId, actor, next, revision)).resolves.toMatchObject({ result: { designId: result.designId, version: 2 } });
    const { designs } = await new DesignWorkspaceService(store).workspace(projectId, actor);
    expect(designs[0].versions.map(version => [version.version, version.sourceVerification])).toEqual([[1, source], [2, source]]);
    expect((await store.read(projectId, 0)).map(commit => commit.assets?.length)).toEqual([1, 1]);
  });

  it.each([
    ['不适用的冒烟缺少原因', { acceptancePlan: { ...defaultPlan, smoke: { applicable: false } } }, 'acceptancePlan.smoke.reason', 'missing_reason'],
    ['停用的冒烟没有有效原因', { acceptancePlan: { ...defaultPlan, smoke: { applicable: true, enabled: false, reason: ' ' } } }, 'acceptancePlan.smoke.reason', 'missing_reason'],
    ['误填维度', { acceptance: [{ ...rules()[0], dimension: 'constructor' }, ...rules().slice(1)] }, 'acceptance[0].dimension', 'invalid_dimension', 'A-01'],
    ['没有验收项', { acceptance: [] }, 'acceptance', 'missing_rule'],
    ['安全合规无验收项和原因', { acceptance: rules().filter(row => row.dimension !== 'security') }, 'risks.security', 'missing_coverage'],
  ] as const)('拒绝%s并返回修复位置', async (_label, overrides, field, code, ruleId?) => {
    await serve(service, async endpoint => {
      const response = await submit(endpoint, { requestId: 'invalid', sourceCommit: firstCommit }, archive(overrides));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: 'G-11', issues: expect.arrayContaining([issue(field, code, ruleId)]) });
    });
  });

  it('验收计划必须逐一声明八种方法', async () => {
    await serve(service, async endpoint => {
      for (const method of methods) {
        const bytes = archive({ acceptancePlan: { ...defaultPlan, [method]: undefined } });
        const response = await submit(endpoint, { requestId: 'missing-method', sourceCommit: firstCommit }, bytes);
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ error: 'G-11', issues: expect.arrayContaining([
          issue(`acceptancePlan.${method}`, 'missing_method'),
        ]) });
      }
    });
  });

  it('非法方法名和输入值不会进入 HTTP 驳回回执', async () => {
    const payloadMarker = '示例未知方法 / fixture-only';
    const bytes = archive({ acceptancePlan: { ...defaultPlan, [payloadMarker]: applicable, smoke: { applicable: payloadMarker },
      debt: { ...irrelevant, enabled: true } } });
    await serve(service, async endpoint => {
      const response = await submit(endpoint, { requestId: 'safe-issues', sourceCommit: firstCommit }, bytes);
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body).toMatchObject({ error: 'G-11', issues: expect.arrayContaining([
        issue('acceptancePlan', 'invalid_method'), issue('acceptancePlan.smoke', 'invalid_method'), issue('acceptancePlan.debt', 'invalid_method'),
      ]) });
      expect(JSON.stringify(body)).not.toContain(payloadMarker);
    });
  });

  it('每种必须执行的验收手段都不能声明不适用或停用', async () => {
    const acceptance = rules();
    const checks = [{ ...acceptance[0], how: 'human', interaction: true }, ...acceptance.slice(1)];
    const required = ['mece', 'compare', 'visual', 'flow', 'human'];
    const request = { requestId: 'required-methods', sourceCommit: firstCommit };
    await serve(service, async endpoint => {
      for (const setting of [irrelevant, { applicable: true, enabled: false, reason: irrelevant.reason }]) {
        const acceptancePlan = { ...defaultPlan, ...Object.fromEntries(required.map(method => [method, setting])) };
        const response = await submit(endpoint, request, archive({ acceptance: checks, acceptancePlan }));
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ error: 'G-11', issues: expect.arrayContaining(
          required.map(method => issue(`acceptancePlan.${method}`, 'required_method')),
        ) });
      }
    });
  });

  it('风险只能引用同维度的现有规则，未覆盖维度可以明确声明不适用', async () => {
    const acceptance = rules();
    const badRisks = { risks: [{ dimension: 'security', risk: '安全合规测试', ruleIds: ['A-01'] }] };
    const unknownRisk = { risks: [{ dimension: 'security', risk: '缺少则不可核对', ruleIds: ['A-99'] }] };
    const append = vi.spyOn(store, 'append');
    const request = { requestId: 'risks', sourceCommit: firstCommit };
    await serve(service, async endpoint => {
      for (const [overrides, field, code] of [
        [badRisks, 'risks[0].ruleIds', 'coverage_conflict'],
        [unknownRisk, 'risks[0].ruleIds', 'coverage_conflict'],
        [{ risks: [null] }, 'risks[0]', 'invalid_risk'],
      ] as const) {
        const response = await submit(endpoint, request, archive(overrides));
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ error: 'G-11', issues: expect.arrayContaining([issue(field, code)]) });
      }
    });
    expect(append).not.toHaveBeenCalled();

    const exempted = { dimension: 'security', risk: '访问权限与外部数据', ruleIds: [], reason: '离线演示没有用户数据和网络请求。' };
    const addressed = { dimension: 'correctness', risk: '主区不可见', ruleIds: ['A-01'] };
    const valid = archive({ acceptance: acceptance.filter(rule => rule.dimension !== 'security'), risks: [addressed, exempted],
      acceptancePlan: { ...defaultPlan, smoke: { applicable: true, enabled: false, reason: irrelevant.reason } } });
    await expect(service.publish(projectId, designer, request, valid)).resolves.toMatchObject({ result: { version: 1 } });
    const version = (await service.workspace(projectId, designer)).designs[0].versions[0];
    expect(designCoverage(version).find(entry => entry.id === 'security')?.risks).toEqual([{ ...exempted, status: 'not_applicable' }]);
    expect(designMethodsState(version).methods.find(method => method.id === 'smoke')?.status).toBe('disabled');
  });

  it.each(['declared', 'private-upload'] as const)('从 %s 归档读取旧稿并重放原请求，同时要求续版满足新标准', async source => {
    const designId = 'DSN-OLD-FIXTURE';
    const archiveId = 'fixture-legacy-archive';
    const prototypeId = 'fixture-legacy-prototype';
    const registered = source === 'private-upload';
    const intake = { designKey: 'fixture/entry', intent: 'create', sourceMode: 'private', sourcePath };
    const request = { requestId: 'legacy-fingerprint', sourceCommit: firstCommit, ...(registered ? intake : {}) };
    const demo = [{ screen: 'entry', title: '读回旧归档中的演示' }];
    const manifest = { acceptancePlan: undefined, acceptance: rules(6, false), demo };
    const bytes = archive(manifest);
    const sha256 = digest(bytes);
    const files = Object.entries(archiveFiles(manifest, 1, {})).sort(([left], [right]) => left.localeCompare(right));
    const oldFileDigest = digest(JSON.stringify(files.map(([path, body]) => [path, digest(body)])));
    const fingerprint = registered ? digest(JSON.stringify({ designKey: intake.designKey, intent: intake.intent,
      resolves: {}, sha256: oldFileDigest, sourceCommit: firstCommit,
      sourceMode: intake.sourceMode, sourcePath, type: 'package' }))
      : digest(JSON.stringify({ resolves: {}, sha256, sourceCommit: firstCommit, type: 'package' }));
    const result = { type: 'package', designId, version: 1 };
    await store.append({ projectId, revision: 1, request: {
      key: digest(JSON.stringify([designer.kind, designer.id, request.requestId])),
      fingerprint, result,
    }, assets: [{ id: archiveId, mime: 'application/zip', base64: bytes.toString('base64') }],
    design: { id: designId, ...(registered ? { designKey: intake.designKey } : {}), version: { version: 1, title: '旧稿夹具', sourceCommit: firstCommit,
      sha256, prototypeId, prototypeSha256: digest(prototype), createdAt: `${date}T00:00:00Z`, publisher: { id: designer.id, label: designer.label },
      rationale: '示例说明', spec: {}, tags: [], decisionIds: [], resolves: {},
      sourceVerification: source, ...(registered ? { sourcePath } : {}),
      screens: [{ ...screen, viewport: 'desktop', impl: null, themes: ['light'] }],
      acceptance: rules(6, false).map(rule => ({ ...rule, how: 'measure', priority: 'normal', slots: ['desktop-light'], dimension: undefined })),
      delivery: { archiveId, archiveRoot: '', warnings: [], files: [{ id: prototypeId, kind: 'prototype', path: 'dist/index.html',
        sha256: digest(prototype), size: Buffer.byteLength(prototype), text: true }] },
    } } });
    const append = vi.spyOn(store, 'append');
    await serve(service, async endpoint => {
      const detail = await fetch(`${endpoint}?designId=${designId}&version=1`);
      expect(detail.status).toBe(200);
      const { designs } = await detail.json();
      const legacy = designs[0].versions[0];
      expect(legacy).toMatchObject({ version: 1, demo });
      expect(designMethodPlanEnabled(legacy)).toBe(false);
      expect(legacy.acceptance.every((rule: { dimension?: string }) => rule.dimension === undefined)).toBe(true);
      expect(await (await fetch(`${endpoint}/artifacts/${prototypeId}`)).text()).toBe(prototype);

      const replay = await submit(endpoint, request, bytes);
      expect(replay.status).toBe(200);
      expect(await replay.json()).toMatchObject({ reused: true, result });
      expect((await submit(endpoint, request, archive())).status).toBe(409);

      const next = { requestId: 'revise-legacy', designId, sourceCommit: nextCommit,
        ...(registered ? { ...intake, intent: 'revise', expectedVersion: '1' } : {}) };
      const denied = await submit(endpoint, next, archive({ acceptancePlan: undefined, acceptance: rules(6, false) }, 2));
      expect(denied.status).toBe(400);
      expect(await denied.json()).toMatchObject({ error: 'G-11', issues: expect.arrayContaining([issue('acceptancePlan', 'missing_acceptance_plan')]) });
      expect(append).not.toHaveBeenCalled();
      expect((await submit(endpoint, next, archive({}, 2))).status).toBe(201);
      expect((await store.read(projectId, 0))[0].design?.version?.acceptancePlan).toBeUndefined();
    });
  });
});
