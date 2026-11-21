import { once } from 'node:events';
import { createHash, createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { deflateSync } from 'node:zlib';
import path from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDesignWorkspaceRouter } from '../../src/routes/design-workspace.js';
import { DesignWorkspaceService, type DesignActor, type DesignWorkspaceCommit } from '../../src/services/design-workspace.js';
import { FileProjectRevisionStore } from '../../src/services/project-revision-store.js';
import type { DesignFrameworkMeasurement } from '../../src/shared/design-workspace.js';
import { buildZip, crc32 } from '../../src/utils/zip.js';

const projectId = 'fixture-design-a';
const otherProjectId = 'fixture-design-b';
const sourceCommit = 'a'.repeat(40);
const previewCommit = 'b'.repeat(40);
const html = '<!doctype html><html><head><meta charset="utf-8"></head><body><h1>Fixture</h1></body></html>';
const permissions = ['read', 'propose', 'write', 'approve'] as const;
const people = new Map<string, DesignActor>([
  ['designer', { kind: 'agent', id: 'designer', label: 'Fixture designer', permissions }],
  ['git-designer', { kind: 'agent', id: 'git-designer', label: 'Fixture restricted designer', permissions, gitPublishOnly: true }],
  ['author', { kind: 'human', id: 'author', label: 'Fixture reviewer', permissions }],
  ['other', { kind: 'human', id: 'other', label: 'Other member', permissions }],
  ['steward', { kind: 'human', id: 'steward', label: 'Fixture steward', permissions, steward: true }],
  ['outside', { kind: 'human', id: 'outside', label: 'Outside member', permissions }],
  ['without-approval', { kind: 'human', id: 'without-approval', label: 'Cannot approve', permissions: ['read', 'write'] }],
  ['without-read', { kind: 'human', id: 'without-read', label: 'Cannot read', permissions: ['write', 'approve'] }],
  ['agent-with-reviewer-id', { kind: 'agent', id: 'author', label: 'Synthetic agent', permissions }],
  ['reviewer-without-read', { kind: 'human', id: 'author', label: 'Fixture reviewer', permissions: ['write', 'approve'] }],
  ['reviewer-without-approval', { kind: 'human', id: 'author', label: 'Fixture reviewer', permissions: ['read', 'write'] }],
]);

function projectActor(project: string, name: string): DesignActor | null {
  if (project !== projectId && project !== otherProjectId) return null;
  if (name === 'outside' && project !== otherProjectId) return null;
  return people.get(name) ?? null;
}

function draft(title = 'Fixture design', extra: Record<string, unknown> = {}, sources: Array<{ name: string; data: Buffer }> = []) {
  return buildZip([
    { name: 'bundle/design.json', data: JSON.stringify({ project: projectId, title,
      screens: [{ id: 'members', name: 'Members', route: '#members', viewport: 'desktop', impl: '/members/' }],
      acceptance: [{ id: 'A-1', rule: 'Members load', how: 'human', slots: ['desktop-light'] }], ...extra,
    }) },
    { name: 'bundle/思路.md', data: '# Goal\nUse fixture records.' },
    { name: 'bundle/dist/index.html', data: html },
    ...sources,
  ]);
}

function png(width: number, height: number) {
  const chunk = (name: string, data: Buffer) => {
    const bytes = Buffer.alloc(12 + data.length);
    bytes.writeUInt32BE(data.length);
    bytes.write(name, 4, 'ascii');
    data.copy(bytes, 8);
    bytes.writeUInt32BE(crc32(bytes.subarray(4, 8 + data.length)), 8 + data.length);
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

describe('private CDS design workspace', () => {
  let directory: string;
  let app: Server;
  let base: string;
  let activeCommit: string;
  let clock: string;
  let service: DesignWorkspaceService;
  let revokedReviewers: Set<string>;
  let frameworkMeasurements: DesignFrameworkMeasurement[];
  let enableShareHandoff: boolean;
  const handoffKey = Buffer.alloc(32, 17);

  function openWorkspace() {
    const dependencies = {
      now: () => new Date(clock),
      frameworkProbe: async () => frameworkMeasurements,
      resolvePreview: async (project: string, pr: number, commit?: string) => project === projectId && [7, 8].includes(pr) && (!commit || commit === activeCommit)
        ? { commit: activeCommit, url: pr === 7 ? 'https://preview.fixture.test/' : 'https://preview.fixture.test/other/' } : undefined,
      sourcePackage: async (project: string, sha: string, sourcePath: string) => project === projectId && sha === sourceCommit && sourcePath === 'design/fixture' ? draft() : undefined,
      reviewer: async (project: string, id: string) => {
        const member = projectActor(project, id);
        if (!revokedReviewers.has(id) && member?.kind === 'human' && member.permissions.includes('read') && member.permissions.includes('approve')) {
          return { id: member.id, label: member.label };
        }
      },
    };
    return new DesignWorkspaceService(new FileProjectRevisionStore<DesignWorkspaceCommit>(directory), dependencies);
  }

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'cds-design-test-'));
    activeCommit = previewCommit;
    clock = '2026-11-21T09:05:00.000Z';
    revokedReviewers = new Set();
    frameworkMeasurements = [];
    service = openWorkspace();
    const server = express();
    server.use('/api', createDesignWorkspaceRouter({ service, resolveAccess: (req, project) => projectActor(project, req.get('x-fixture-user') ?? ''),
      mapShareHandoff: () => enableShareHandoff ? {
        issuer: 'https://cds.fixture.test', target: new URL('https://map.fixture.test/platform/'), key: handoffKey,
        resolve: (project: string, _design: string, version: number, user: string) => project === projectId
          && version === 1 && user === 'author' ? { approverId: 'map-reviewer', siteId: 'site-1', revisionId: 'map-v1' } : undefined,
        now: () => new Date(clock),
      } : undefined,
    }));
    enableShareHandoff = false;
    app = server.listen(0, '127.0.0.1');
    await once(app, 'listening');
    const address = app.address();
    if (!address || typeof address === 'string') throw Error('Missing fixture server');
    base = `http://127.0.0.1:${address.port}/api/projects/`;
  });

  afterEach(async () => {
    if (app) await new Promise<void>(resolve => app.close(() => resolve()));
    if (directory) await rm(directory, { force: true, recursive: true });
  });

  function get(suffix = '', actor = 'author', project = projectId) {
    return fetch(`${base}${project}/design${suffix}`, { headers: { 'x-fixture-user': actor } });
  }

  function publish(requestId: string, bytes: Buffer, query: Record<string, string> = {}) {
    const filters = new URLSearchParams({ requestId, sourceCommit, ...query });
    return fetch(`${base}${projectId}/design/packages?${filters}`, { method: 'POST', body: new Uint8Array(bytes),
      headers: { 'x-fixture-user': 'designer', 'Content-Type': 'application/zip' } });
  }

  function command(type: string, fields: object, actor = 'author', requestId: string = crypto.randomUUID(), project = projectId) {
    return fetch(`${base}${project}/design/commands`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-fixture-user': actor },
      body: JSON.stringify({ type, requestId, ...fields }),
    });
  }

  it('only lets an assigned human reviewer freeze the latest version and inherits reviewers on publish', async () => {
    const published = await publish('assign-first', draft(), { reviewerIds: JSON.stringify(['author']) });
    expect(published.status).toBe(201);
    const { designId } = (await published.json()).result;
    const by = people.get('author')!;
    const row = async () => (await (await get()).json()).designs[0];

    expect(await row()).toMatchObject({ id: designId, reviewers: [{ id: by.id, label: by.label }] });
    const freeze = { designId, version: 1 };
    expect((await command('design.freeze', freeze, 'other')).status).toBe(403);
    expect((await command('design.freeze', freeze, 'steward')).status).toBe(403);
    expect((await command('design.freeze', freeze, 'agent-with-reviewer-id')).status).toBe(403);
    expect((await command('design.freeze', freeze, 'reviewer-without-read')).status).toBe(404);
    expect((await command('design.freeze', freeze, 'reviewer-without-approval')).status).toBe(403);
    expect((await command('design.freeze', freeze, 'author', 'cross-project', otherProjectId)).status).toBe(404);

    expect((await publish('inherit-next', draft('Fixture next version'), { designId, sourceCommit: 'c'.repeat(40) })).status).toBe(201);
    expect(await row()).toMatchObject({ reviewers: [{ id: by.id, label: by.label }] });
    revokedReviewers.add(by.id);
    expect(await service.reviewNotices(projectId, by)).toEqual([]);
    expect((await command('design.freeze', { designId, version: 2 })).status).toBe(403);
    revokedReviewers.delete(by.id);
    expect((await command('design.freeze', freeze)).status).toBe(409);
    expect((await command('design.freeze', { designId, version: 2 })).status).toBe(201);
    expect(await row()).toMatchObject({ frozen: 2 });
  });

  it('only lets publishers or stewards request review and checks the current assignment after replacement', async () => {
    const first = await publish('review-first', draft());
    expect(first.status).toBe(201);
    const { designId } = (await first.json()).result;

    expect((await command('design.freeze', { designId, version: 1 }, 'other')).status).toBe(201);
    expect((await command('design.review', { designId, reviewerIds: ['author'] }, 'designer')).status).toBe(201);
    expect((await publish('set-on-update', draft(), { designId, sourceCommit: 'c'.repeat(40), reviewerIds: JSON.stringify(['author']) })).status).toBe(201);
    const request = { designId, reviewerIds: ['other'] };
    expect((await command('design.review', request, 'other')).status).toBe(403);
    expect((await command('design.review', request, 'designer', 'out-of-project', otherProjectId)).status).toBe(404);
    expect((await command('design.review', { designId, reviewerIds: ['outside'] }, 'designer')).status).toBe(400);
    expect((await command('design.review', request, 'designer')).status).toBe(201);
    expect((await command('design.review', request, 'steward')).status).toBe(201);

    const current = (await (await get()).json()).designs[0];
    expect(current).toMatchObject({ reviewers: [{ id: 'other', label: 'Other member' }], frozen: 1, reviewRequested: true });
    expect(await service.reviewNotices(projectId, people.get('author')!)).toEqual([]);
    expect((await command('design.freeze', { designId, version: 2 }, 'author')).status).toBe(403);
    expect((await command('design.freeze', { designId, version: 2 }, 'other')).status).toBe(201);
  });

  it('rejects malformed, unknown and ineligible reviewer identities without storing a draft', async () => {
    for (const reviewerIds of ['invalid JSON', '{"id":"author"}', ...['unknown', 'outside', 'designer', 'without-read', 'without-approval']
      .map(id => JSON.stringify([id]))]) {
      const response = await publish('invalid-reviewers', draft(), { reviewerIds });
      expect(response.status).toBe(400);
    }
    expect((await (await get()).json()).designs).toEqual([]);
  });

  it('clears the reviewer requirement when the publisher explicitly chooses an empty list', async () => {
    const first = await publish('review-before-clear', draft(), { reviewerIds: JSON.stringify(['other']), sourcePath: 'design/fixture' });
    expect(first.status).toBe(201);
    const { designId } = (await first.json()).result;
    const current = async () => (await (await get()).json()).designs[0];
    const freeze = { designId, version: 1 };
    expect((await command('design.freeze', freeze, 'author')).status).toBe(403);
    expect((await command('design.review', { designId, reviewerIds: [] }, 'designer')).status).toBe(201);
    expect(await current()).toMatchObject({ reviewers: [], reviewRequested: false });
    expect(await service.reviewNotices(projectId, people.get('other')!)).toEqual([]);
    expect((await command('design.freeze', freeze, 'without-approval')).status).toBe(403);
    expect((await command('design.freeze', freeze, 'author')).status).toBe(201);

    const version = (await current()).versions[0];
    const prepared = await command('share.prepare', { ...freeze, sourceCommit, packageSha256: version.sha256,
      audience: 'password', expiresInHours: 24 }, 'author');
    expect(prepared.status).toBe(201);
    const { id } = (await prepared.json()).result;
    enableShareHandoff = true;
    const response = await fetch(`${base}${projectId}/design/shares/${id}/handoff`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-fixture-user': 'author' }, body: JSON.stringify({ designId }) });
    expect(response.status).toBe(200);
  });

  it('privately coalesces review notices by design and recipient for an hour across versions and retries', async () => {
    const recipient = people.get('author')!;
    const notices = () => service.reviewNotices(projectId, recipient);
    expect(await notices()).toEqual([]);
    const first = await publish('notify-first', draft('First fixture title'), { reviewerIds: JSON.stringify(['author', 'other']) });
    expect(first.status).toBe(201);
    const { designId } = (await first.json()).result;
    expect(await notices()).toMatchObject([{ projectId, designId, version: 1, title: 'First fixture title', updatedAt: clock, occurrences: 1 }]);

    clock = '2026-11-21T09:24:00.000Z';
    const next = { designId, sourceCommit: 'e'.repeat(40) };
    const versionTwo = draft('Latest fixture title');
    expect((await publish('notify-next', versionTwo, next)).status).toBe(201);
    expect((await publish('notify-next', versionTwo, next)).status).toBe(200);
    expect(await notices()).toMatchObject([{ projectId, designId, version: 2, title: 'Latest fixture title', updatedAt: clock, occurrences: 2 }]);

    clock = '2026-11-21T09:40:00.000Z';
    const request = { designId, reviewerIds: ['author', 'other'] };
    expect((await command('design.review', request, 'designer', 'notify-request')).status).toBe(201);
    expect((await command('design.review', request, 'designer', 'notify-request')).status).toBe(200);
    expect((await command('design.review', { designId, reviewerIds: ['other'] }, 'designer', 'notify-request')).status).toBe(409);
    const firstHour = { projectId, designId, version: 2, title: 'Latest fixture title', occurrences: 3, updatedAt: clock };
    expect(await notices()).toMatchObject([firstHour]);
    expect(await service.reviewNotices(projectId, people.get('other')!)).toMatchObject([firstHour]);
    expect(await service.reviewNotices(otherProjectId, recipient)).toEqual([]);
    for (const actor of ['steward', 'designer', 'agent-with-reviewer-id', 'reviewer-without-read', 'reviewer-without-approval']) {
      expect(await service.reviewNotices(projectId, people.get(actor)!)).toEqual([]);
    }

    clock = '2026-11-21T10:42:00.000Z';
    expect((await command('design.review', request, 'designer', 'next-hour')).status).toBe(201);
    const secondHour = { ...firstHour, occurrences: 1, updatedAt: clock };
    const separate = await publish('different-design', draft('Separate fixture design'), { reviewerIds: JSON.stringify(['author']) });
    expect(separate.status).toBe(201);
    const separateId = (await separate.json()).result.designId;
    const history = await openWorkspace().reviewNotices(projectId, recipient);
    expect(history).toHaveLength(3);
    expect(history).toEqual(expect.arrayContaining([
      expect.objectContaining(firstHour),
      expect.objectContaining(secondHour),
      expect.objectContaining({ projectId, designId: separateId, version: 1, occurrences: 1 }),
    ]));
    expect(await service.reviewNotices(projectId, people.get('other')!)).toHaveLength(2);
  });

  it('publishes only once for identical concurrent requests and scopes the unmodified prototype', async () => {
    const bytes = draft();
    const responses = await Promise.all([publish('one', bytes), publish('one', bytes)]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 201]);
    expect((await publish('one', draft('Another title'))).status).toBe(409);
    const { designs } = await (await get()).json();
    expect(designs).toHaveLength(1);
    expect(designs[0].versions).toHaveLength(1);
    const endpoint = '/artifacts/' + designs[0].versions[0].prototypeId;
    const artifact = await get(endpoint);
    expect(await artifact.text()).toBe(html);
    expect(artifact.headers.get('cache-control')).toBe('private, no-store');
    expect(artifact.headers.get('content-security-policy')).toContain('sandbox allow-scripts');
    expect((await get(endpoint, 'anonymous')).status).toBe(404);
    expect((await get(endpoint, 'author', 'fixture-design-b')).status).toBe(404);
  });

  it('keeps a prior comment anchored after release and only its reviewer can confirm it', async () => {
    const first = (await (await publish('one', draft())).json()).result;
    const response = await command('comment.create', { designId: first.designId, version: 1, screenId: 'members', x: .1, y: .2, body: 'Fixture comment' });
    expect(response.status).toBe(201);
    const { id: commentId } = (await response.json()).result;
    expect((await publish('two', draft(), { designId: first.designId, sourceCommit: 'c'.repeat(40),
      resolves: JSON.stringify({ [commentId]: 'Changed the fixture view' }),
    })).status).toBe(201);
    const review = { designId: first.designId, version: 2, commentId, decision: 'resolved' };
    expect((await command('comment.review', review, 'other')).status).toBe(403);
    expect((await command('comment.review', review)).status).toBe(201);
    const { designs } = await (await get()).json();
    expect(designs[0].comments[0]).toMatchObject({ version: 1, closed: true, reviews: [{ version: 2, decision: 'resolved' }] });
  });

  it('pins a framework revision and rejects unknown revisions', async () => {
    const frameworkId = 'FW-fixture';
    const create = (expectedVersion: number, sha: string) => command('framework.import', { frameworkId, title: 'Fixture framework',
      sourceCommit: sha.repeat(40), expectedVersion, material: { rules: '## R-01 Keep a stable heading' } });
    expect((await create(0, 'b')).status).toBe(201);
    expect((await create(1, 'c')).status).toBe(201);
    expect((await publish('bad-framework', draft('Fixture design', { framework: frameworkId, frameworkVersion: 3 }))).status).toBe(400);
    expect((await publish('known-framework', draft('Fixture design', { framework: frameworkId, frameworkVersion: 1 }))).status).toBe(201);
    const { designs } = await (await get()).json();
    expect(designs[0].versions[0]).toMatchObject({ framework: frameworkId, frameworkVersion: 1 });
  });

  it('stores measured framework rules separately from author self checks and partial coverage', async () => {
    const frameworkId = 'FW-overflow';
    const rules = '| R-07 | 375px 手机没有横向溢出 | 自动：实测 |\n## R-01 核对页头';
    const imported = await command('framework.import', { frameworkId, title: 'Fixture framework',
      sourceCommit: 'c'.repeat(40), expectedVersion: 0, material: { rules } });
    expect(imported.status).toBe(201);
    const authorChecks = { items: [{ id: 'R-07', status: 'passed' }] };
    const packageBytes = draft('Fixture mobile draft', { framework: frameworkId, frameworkVersion: 1, acceptance: [],
      screens: [{ id: 'mobile-members', name: 'Members', route: '#members', viewport: 'phone', themes: ['light', 'dark'] }] },
    [{ name: 'bundle/checks/result.json', data: Buffer.from(JSON.stringify(authorChecks)) }]);
    frameworkMeasurements = [{ screenId: 'mobile-members', slot: 'phone-light', width: 375, contentWidth: 520 }];
    const published = await publish('measured-rules', packageBytes);
    expect(published.status).toBe(201);
    const { designId } = (await published.json()).result;
    frameworkMeasurements = [{ screenId: 'mobile-members', slot: 'phone-light', width: 375, contentWidth: 375 }];
    expect((await publish('partial-rules', packageBytes, { designId, sourceCommit: 'd'.repeat(40) })).status).toBe(201);
    const { designs } = await (await get()).json();
    expect(designs[0].versions[0]).toMatchObject({
      checks: authorChecks,
      frameworkCheck: { framework: frameworkId, frameworkVersion: 1, sourceCommit,
        items: [{ ruleId: 'R-07', status: 'failed', measurements: [{ contentWidth: 520 }] }, { ruleId: 'R-01', status: 'unverified' }] },
    });
    expect(designs[0].versions[1].frameworkCheck.items[0]).toMatchObject({ ruleId: 'R-07', status: 'unverified', actual: expect.stringContaining('1 / 2') });
  });

  it('requires container evidence for the complete 375px rule and retains each publication result', async () => {
    const frameworkId = 'FW-mobile-layout';
    const rules = '| R-07 | 375 宽下文档没有横向溢出；只有表格、图表、代码块可以在自身容器里横向滚动 | 自动：比较文档宽度和视口宽度 |';
    expect((await command('framework.import', { frameworkId, title: 'Mobile layout',
      sourceCommit: 'c'.repeat(40), expectedVersion: 0, material: { rules } })).status).toBe(201);
    const packageBytes = draft('Fixture mobile draft', { framework: frameworkId, frameworkVersion: 1,
      screens: [{ id: 'mobile-members', name: 'Members', route: '#members', viewport: 'phone', themes: ['light', 'dark'] }] });
    const light = { screenId: 'mobile-members', slot: 'phone-light', width: 375, contentWidth: 375 } as const;
    const dark = { ...light, slot: 'phone-dark' } as const;
    frameworkMeasurements = [light, dark];
    const published = await publish('root-only', packageBytes);
    expect(published.status).toBe(201);
    const { designId } = (await published.json()).result;
    const prohibited = { status: 'failed', element: 'nav', width: 343, contentWidth: 521 } as const;
    frameworkMeasurements = [light, { ...dark, nestedScroll: prohibited }];
    expect((await publish('prohibited-container', packageBytes, { designId, sourceCommit: 'd'.repeat(40) })).status).toBe(201);
    frameworkMeasurements = [light, dark].map(row => ({ ...row, nestedScroll: { status: 'passed' } as const }));
    expect((await publish('complete-mobile', packageBytes, { designId, sourceCommit: 'e'.repeat(40) })).status).toBe(201);

    const { designs } = await (await get()).json();
    const results = designs[0].versions.map((version: { frameworkCheck: { items: unknown[] } }) => version.frameworkCheck.items[0]);
    expect(results).toMatchObject([
      { ruleId: 'R-07', status: 'unverified', actual: expect.stringContaining('0 / 2') },
      { ruleId: 'R-07', status: 'failed', actual: expect.stringContaining('521px'), measurements: [light, { ...dark, nestedScroll: prohibited }] },
      { ruleId: 'R-07', status: 'passed' },
    ]);
  });

  it('acknowledges the source only after matching the archive against the project Git tree', async () => {
    const source = { sourcePath: 'design/fixture' };
    expect((await publish('fake-source', draft('Modified archive'), source)).status).toBe(409);
    expect((await publish('known-source', draft(), source)).status).toBe(201);
    expect((await publish('outside-source', draft(), { ...source, sourceCommit: 'f'.repeat(40) })).status).toBe(201);
    const { designs } = await (await get()).json();
    expect(designs.map((entry: any) => entry.versions[0].sourceVerification).sort()).toEqual(['declared', 'git']);
  });

  it('requires a visible Git source when the caller or an explicitly scoped key requires it', async () => {
    const sourcePath = 'design/fixture';
    const publishAs = (requestId: string, query: Record<string, string>, as: string) => fetch(
      `${base}${projectId}/design/packages?${new URLSearchParams({ requestId, sourceCommit, ...query })}`, {
        method: 'POST', headers: { 'Content-Type': 'application/zip', 'x-fixture-user': as }, body: new Uint8Array(draft()),
      });
    expect((await publishAs('declared-restricted', {}, 'git-designer')).status).toBe(409);
    expect((await publishAs('outside-source', { sourcePath, sourceCommit: 'f'.repeat(40) }, 'git-designer')).status).toBe(409);
    expect((await publishAs('require-git', { requireGit: 'true' }, 'designer')).status).toBe(409);
    expect((await publishAs('confirmed-git', { sourcePath }, 'git-designer')).status).toBe(201);
    const { designs } = await (await get()).json();
    expect(designs).toHaveLength(1);
    expect(designs[0].versions[0].sourceVerification).toBe('git');
    expect(designs[0].versions[0].prototypeSha256).toBe(createHash('sha256').update(html).digest('hex'));
  });

  it('prepares a Git-verified frozen design for human confirmation without releasing a link', async () => {
    const published = await publish('share-fixture', draft(), { sourcePath: 'design/fixture' });
    expect(published.status).toBe(201);
    const { designId } = (await published.json()).result;
    const { designs } = await (await get()).json();
    const fields = { designId, version: 1, sourceCommit, packageSha256: designs[0].versions[0].sha256,
      audience: 'password', expiresInHours: 2 };
    expect((await command('share.prepare', fields)).status).toBe(409);
    expect((await command('design.freeze', { designId, version: 1 })).status).toBe(201);
    expect((await command('share.prepare', fields, 'designer')).status).toBe(403);
    expect((await command('share.prepare', fields, 'without-approval')).status).toBe(403);
    expect((await command('share.prepare', { ...fields, sourceCommit: 'e'.repeat(40) })).status).toBe(409);
    expect((await command('share.prepare', { ...fields, packageSha256: 'd'.repeat(64) })).status).toBe(409);
    expect((await command('share.prepare', { ...fields, expiresInHours: 0 })).status).toBe(400);
    const prepared = await command('share.prepare', fields, 'author', 'share-request');
    expect(prepared.status).toBe(201);
    const { result } = await prepared.json();
    expect(result).toMatchObject({ version: 1, sourceCommit, state: 'awaiting_human_confirmation' });
    expect(result).not.toHaveProperty('shareUrl');
    const repeated = await command('share.prepare', fields, 'author', 'distinct-retry-id');
    expect((await repeated.json()).result.id).toBe(result.id);
    expect((await (await get()).json()).designs[0].sharePreparations).toMatchObject([{ id: result.id, packageSha256: fields.packageSha256 }]);
  });

  it('hands off only the privately pinned preparation to the configured MAP reviewer', async () => {
    const publication = await publish('handoff-package', draft(), { sourcePath: 'design/fixture' });
    expect(publication.status).toBe(201);
    const { result: { designId } } = await publication.json();
    expect((await command('design.freeze', { designId, version: 1 })).status).toBe(201);
    const [{ versions: [version] }] = (await (await get()).json()).designs;
    const prepared = await command('share.prepare', { designId, version: 1, sourceCommit, packageSha256: version.sha256,
      audience: 'password', expiresInHours: 2 });
    const { result: { id: preparationId } } = await prepared.json();
    const handoff = (user = 'author', project = projectId, body = { designId }) => fetch(`${base}${project}/design/shares/${preparationId}/handoff`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-fixture-user': user }, body: JSON.stringify(body),
    });
    expect((await handoff()).status).toBe(503);
    enableShareHandoff = true;
    expect((await handoff('designer')).status).toBe(403);
    expect((await handoff('other')).status).toBe(403);
    expect((await handoff('author', otherProjectId)).status).toBe(404);
    expect((await handoff('author', projectId, { designId, approverId: 'other' } as { designId: string })).status).toBe(400);
    const response = await handoff();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    const receipt = await response.json();
    expect(receipt).toMatchObject({ preparationId, destination: 'https://map.fixture.test/platform/web-pages/cds-share' });
    expect(receipt).not.toHaveProperty('shareUrl');
    const [data, signature] = receipt.grant.split('.');
    expect(createHmac('sha256', handoffKey).update(data).digest('base64url')).toBe(signature);
    const grant = JSON.parse(Buffer.from(data, 'base64url').toString());
    expect(grant).toMatchObject({ purpose: 'cds-fixed-design-share', projectId, designId, preparationId, version: 1, sourceCommit,
      packageSha256: version.sha256, prototypeSha256: createHash('sha256').update(html).digest('hex'), audienceOrigin: 'https://map.fixture.test',
      access: 'password', expiresInHours: 2, approverId: 'map-reviewer', siteId: 'site-1', revisionId: 'map-v1' });
    expect(grant.exp - grant.iat).toBe(300);
    expect((await (await handoff()).json()).grant).toBe(receipt.grant);
  });

  it('keeps a prototype screenshot private and checks its declared viewport', async () => {
    const file = 'bundle/screens/members.light.png';
    const packed = (bytes: Buffer) => draft('Fixture design', {}, [{ name: file, data: bytes }]);
    expect((await publish('invalid-capture', packed(Buffer.from('not an image')))).status).toBe(400);
    expect((await publish('wrong-viewport', packed(png(375, 812)))).status).toBe(400);
    const captured = png(1280, 800);
    expect((await publish('valid-capture', packed(captured))).status).toBe(201);
    const { designs } = await (await get()).json();
    const id = designs[0].versions[0].renders.members.light.id;
    const artifact = await get(`/artifacts/${id}`);
    expect(artifact.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await artifact.arrayBuffer())).toEqual(captured);
    expect((await get(`/artifacts/${id}`, 'anonymous')).status).toBe(404);
    expect((await get(`/artifacts/${id}`, 'author', 'fixture-design-b')).status).toBe(404);
  });

  it('opens a standalone draft with an explicitly empty screen list while keeping the evidence gap', async () => {
    expect((await publish('missing-screens', draft('Broken design', { screens: undefined }))).status).toBe(400);
    const published = await publish('standalone-draft', draft('Standalone fixture', { screens: [] }));
    expect(published.status).toBe(201);
    const { designId } = (await published.json()).result;
    const { designs } = await (await get()).json();
    expect(designs[0].versions[0].screens).toEqual([]);
    expect(await (await get(`/artifacts/${designs[0].versions[0].prototypeId}`)).text()).toBe(html);
    expect((await command('design.freeze', { designId, version: 1 })).status).toBe(201);
    expect((await command('acceptance.start', { designId, version: 1, pullRequest: 7 })).status).toBe(201);
    const current = (await (await get()).json()).designs[0];
    expect(current.runs[0]).toMatchObject({ verdict: 'needs_evidence', cells: [{ itemId: 'A-1', status: 'missing' }] });
  });

  it('rejects a forged human result, absent screenshot and a superseded preview', async () => {
    const { designId } = (await (await publish('one', draft())).json()).result;
    expect((await command('design.freeze', { designId, version: 1 }, 'designer')).status).toBe(403);
    expect((await command('design.freeze', { designId, version: 1 })).status).toBe(201);
    const started = await command('acceptance.start', { designId, version: 1, pullRequest: 7 });
    expect(started.status).toBe(201);
    const { runId } = (await started.json()).result;
    const record = { designId, runId, commit: previewCommit,
      cells: [{ itemId: 'A-1', slot: 'desktop-light', status: 'passed', actual: 'Claim without evidence' }] };
    expect((await command('acceptance.record', record, 'designer')).status).toBe(403);
    expect((await command('acceptance.record', record)).status).toBe(400);
    expect((await command('acceptance.sign', { designId, runId })).status).toBe(409);
    activeCommit = 'd'.repeat(40);
    expect((await command('acceptance.record', record)).status).toBe(409);
  });

  async function runWithScreenshot() {
    const { designId } = (await (await publish('version-for-signoff', draft())).json()).result;
    expect((await command('design.freeze', { designId, version: 1 })).status).toBe(201);
    const started = await command('acceptance.start', { designId, version: 1, pullRequest: 7 });
    expect(started.status).toBe(201);
    const { runId } = (await started.json()).result;
    const record = { designId, runId, commit: previewCommit, cells: [{ itemId: 'A-1', slot: 'desktop-light', status: 'passed', actual: 'Verified fixture',
      image: `data:image/png;base64,${png(1280, 800).toString('base64')}`, measured: { width: 1280, height: 800, theme: 'light', path: '/members/' } }] };
    expect((await command('acceptance.record', record)).status).toBe(201);
    return { designId, runId, record };
  }

  it('keeps the signature as history when the linked PR deploys a different commit', async () => {
    const { designId, runId } = await runWithScreenshot();
    const listing = async () => (await (await get()).json()).designs[0];
    expect((await command('acceptance.sign', { designId, runId })).status).toBe(201);
    const signed = await listing();
    expect(signed.currentSignoffRunId).toBe(runId);
    expect((await service.planningLinks(projectId))[0].signed).toMatchObject({ runId });
    activeCommit = 'd'.repeat(40);
    const latest = await listing();
    expect(latest.currentSignoffRunId).toBeNull();
    expect((await service.planningLinks(projectId))[0].signed).toBeUndefined();
    expect(latest.runs).toEqual(signed.runs);
    expect((await get(`/artifacts/${signed.runs[0].cells[0].imageId}`)).status).toBe(200);
  });

  it('projects only the latest run of the current design version to planning', async () => {
    const { designId, runId, record } = await runWithScreenshot();
    expect((await command('acceptance.sign', { designId, runId })).status).toBe(201);
    const projection = async () => (await service.planningLinks(projectId))[0];
    expect((await projection()).signed).toMatchObject({ runId });

    const started = await command('acceptance.start', { designId, version: 1, pullRequest: 7 });
    expect(started.status).toBe(201);
    const { runId: newRunId } = (await started.json()).result;
    expect((await projection()).signed).toBeUndefined();
    expect((await command('acceptance.record', { ...record, runId: newRunId })).status).toBe(201);
    expect((await command('acceptance.sign', { designId, runId: newRunId })).status).toBe(201);
    expect((await projection()).signed).toMatchObject({ runId: newRunId });

    expect((await publish('version-two-for-planning', draft('Fixture design V2'), { designId, sourceCommit: 'c'.repeat(40) })).status).toBe(201);
    expect(await projection()).toMatchObject({ id: designId, version: 2, frozen: 1 });
    expect((await projection()).signed).toBeUndefined();
    const { designs } = await (await get()).json();
    expect(designs[0].runs.map((run: { id: string; signed?: unknown }) => [run.id, Boolean(run.signed)])).toEqual([[runId, true], [newRunId, true]]);
  });

  it('cannot sign or use an older PR run to restore a former design link', async () => {
    const { designId, runId, record } = await runWithScreenshot();
    expect((await command('design.link', { designId, pullRequest: 8 })).status).toBe(201);
    expect((await command('acceptance.record', record)).status).toBe(409);
    expect((await command('acceptance.sign', { designId, runId })).status).toBe(409);
    const entry = (await (await get()).json()).designs[0];
    expect(entry.pullRequest).toBe(8);
    expect(entry.runs[0].signed).toBeUndefined();
  });
});
