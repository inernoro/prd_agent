import { once } from 'node:events';
import { createHash, createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { deflateSync } from 'node:zlib';
import path from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHumanProjectAccessMiddleware } from '../../src/middleware/human-project-access.js';
import { createDesignWorkspaceRouter } from '../../src/routes/design-workspace.js';
import type { DesignReferenceTarget } from '../../src/services/design-framework-browser.js';
import { DesignWorkspaceService, type DesignActor, type DesignWorkspaceCommit } from '../../src/services/design-workspace.js';
import { EngineeringPlanningService, FileEngineeringPlanningStore } from '../../src/services/engineering-planning.js';
import { humanPrincipalId } from '../../src/services/human-project-access.js';
import { FileProjectRevisionStore } from '../../src/services/project-revision-store.js';
import { StateService } from '../../src/services/state.js';
import { feedbackSummary } from '../../src/shared/design-feedback.js';
import type { DesignFrameworkMeasurement } from '../../src/shared/design-workspace.js';
import { buildZip, crc32 } from '../../src/utils/zip.js';

// Keep the original archive bytes in compatibility fixtures. The publication gate suite exercises the actual strict service and HTTP route.
vi.mock('../../src/services/design-publication-gate.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/services/design-publication-gate.js')>(),
  validateDesignPublicationGate: () => undefined,
}));

const projectId = 'fixture-design-a';
const otherProjectId = 'fixture-design-b';
const sourceCommit = 'a'.repeat(40);
const previewCommit = 'b'.repeat(40);
const previewUrl = 'https://preview.fixture.test/';
const html = '<!doctype html><html><head><meta charset="utf-8"></head><body><h1>Fixture</h1></body></html>';
const permissions = ['read', 'propose', 'write', 'approve'] as const;
const people = new Map<string, DesignActor>([
  ['designer', { kind: 'agent', id: 'designer', label: 'Fixture designer', permissions }],
  ['rotated-designer', { kind: 'agent', id: 'designer', label: 'Fixture refreshed key', permissions }],
  ['git-designer', { kind: 'agent', id: 'git-designer', label: 'Fixture restricted designer', permissions, gitPublishOnly: true }],
  ['read-designer', { kind: 'agent', id: 'read-designer', label: 'Read-only designer', permissions: ['read'] }],
  ['reading-member', { kind: 'human', id: 'reading-member', label: 'Reading member', permissions: ['read'] }],
  ['implementer', { kind: 'agent', id: 'implementer', label: 'Implementation agent', permissions: ['read'], feedback: true }],
  ['author', { kind: 'human', id: 'author', label: 'Fixture reviewer', permissions }],
  ['other', { kind: 'human', id: 'other', label: 'Other member', permissions }],
  ['steward', { kind: 'human', id: 'steward', label: 'Fixture steward', permissions, steward: true }],
  ['feedback-admin', { kind: 'human', id: 'feedback-admin', label: 'Fixture administrator', permissions, feedbackSupplement: true }],
  ['agent-with-supplement-flag', { kind: 'agent', id: 'agent-with-supplement-flag', label: 'Fixture agent', permissions, feedbackSupplement: true }],
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

function withZipComment(bytes: Buffer) {
  const comment = Buffer.from('Repacked fixture');
  const archive = Buffer.concat([bytes, comment]);
  // The end of central directory stores the comment length in its final two bytes.
  archive.writeUInt16LE(comment.length, bytes.length - 2);
  return archive;
}

function png(width: number, height: number, pixels = Buffer.alloc((width * 3 + 1) * height)) {
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
    chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

describe('private CDS design workspace', () => {
  let directory: string;
  let apps: Server[];
  let base: string;
  let activeCommit: string;
  let activePreviewUrl: string;
  let installedCommit: string;
  let installedUrl: string;
  let clock: string;
  let approvedPlanVersion: number;
  let service: DesignWorkspaceService;
  let revokedReviewers: Set<string>;
  let frameworkMeasurements: DesignFrameworkMeasurement[];
  let enableShareHandoff: boolean;
  let sources: Map<string, Buffer>;
  let sourceLookups: number;
  const handoffKey = Buffer.alloc(32, 17);
  const sourceKey = (project: string, commit: string, sourcePath: string) => JSON.stringify([project, commit, sourcePath]);

  function gitSource(bytes: Buffer, sourcePath: string, sha = 'a', project = projectId) {
    const sourceCommit = sha.repeat(40);
    sources.set(sourceKey(project, sourceCommit, sourcePath), bytes);
    return { sourceCommit, sourcePath };
  }

  function openWorkspace(planning?: EngineeringPlanningService, storeDirectory = directory,
    captureCover?: (prototype: Buffer, target: DesignReferenceTarget) => Promise<Buffer | undefined>) {
    const dependencies = {
      now: () => new Date(clock),
      approvedPlanFor: async (project: string, plan: string) => project === projectId && plan === 'PLN-approved'
        ? { planVersion: approvedPlanVersion, proposalId: 'PRO-fixture', title: 'Approved brief', requirements: 'Original **approved** requirements' } : undefined,
      frameworkProbe: async () => frameworkMeasurements,
      resolvePreview: async (project: string, pr: number, commit?: string) => project === projectId && [7, 8].includes(pr) && (!commit || commit === activeCommit)
        ? { commit: activeCommit, url: pr === 7 ? activePreviewUrl : 'https://preview.fixture.test/other/' } : undefined,
      resolveInstalled: async (project: string, commit?: string) => project === projectId && (!commit || commit === installedCommit)
        ? { commit: installedCommit, url: installedUrl } : undefined,
      sourcePackage: async (project: string, sha: string, sourcePath: string) => {
        sourceLookups++;
        return sources.get(sourceKey(project, sha, sourcePath))
          ?? (project === projectId && sha === sourceCommit && sourcePath === 'design/fixture' ? draft() : undefined);
      },
      reviewer: async (project: string, id: string) => {
        const member = projectActor(project, id);
        if (!revokedReviewers.has(id) && member?.kind === 'human' && member.permissions.includes('read') && member.permissions.includes('approve')) {
          return { id: member.id, label: member.label };
        }
      },
    };
    return new DesignWorkspaceService(new FileProjectRevisionStore<DesignWorkspaceCommit>(storeDirectory), {
      ...dependencies,
      ...(captureCover ? { captureCover } : {}),
      ...(planning ? {
        findDebt: async (project, debtId, sourceRef) => await planning.designAcceptanceDebt(project, debtId, sourceRef) === debtId,
        resolveDebtProposal: (project, proposalId, sourceRef) => planning.designAcceptanceDebt(project, proposalId, sourceRef),
        createDebt: async ({ projectId: project, actor, sourceRef, title, actual, expected }) => {
          const { result } = await planning.command(project, actor, { type: 'proposal.submit', requestId: 'fixture-design-debt',
            kind: 'debt', source: { type: 'test', ref: sourceRef },
            draft: { title, summary: actual, priority: 'mid', criteria: [expected] } }, { designSourceRef: sourceRef });
          const { id } = result as { id: string };
          return { id, pending: await planning.designAcceptanceDebt(project, id, sourceRef) !== id };
        },
      } : {}),
    });
  }

  async function openApi(workspace: DesignWorkspaceService, projectAccess?: StateService) {
    const server = express();
    if (projectAccess) {
      server.use((req, _res, next) => {
        const actor = people.get(req.get('x-fixture-user') ?? '');
        if (actor?.kind === 'human') Object.assign(req, { cdsUser: { id: actor.id, isSystemOwner: actor.steward === true },
          cdsSession: { userId: actor.id } });
        next();
      });
      server.use(createHumanProjectAccessMiddleware(projectAccess));
    }
    server.use('/api', createDesignWorkspaceRouter({ service: workspace, resolveAccess: (req, project) => projectActor(project, req.get('x-fixture-user') ?? ''),
      mapShareHandoff: () => enableShareHandoff ? {
        issuer: 'https://cds.fixture.test', target: new URL('https://map.fixture.test/platform/'), key: handoffKey,
        resolve: (project: string, _design: string, version: number, user: string) => project === projectId
          && version === 1 && user === 'author' ? { approverId: 'map-reviewer', siteId: 'site-1', revisionId: 'map-v1' } : undefined,
        now: () => new Date(clock),
      } : undefined,
    }));
    const app = server.listen(0, '127.0.0.1');
    apps.push(app);
    await once(app, 'listening');
    const address = app.address();
    if (!address || typeof address === 'string') throw Error('Missing fixture server');
    return `http://127.0.0.1:${address.port}/api/projects/`;
  }

  beforeEach(async () => {
    apps = [];
    directory = await mkdtemp(path.join(tmpdir(), 'cds-design-test-'));
    activeCommit = previewCommit;
    activePreviewUrl = previewUrl;
    installedCommit = 'c'.repeat(40);
    installedUrl = 'https://cds.fixture.test/';
    clock = '2026-11-21T09:05:00.000Z';
    approvedPlanVersion = 2;
    revokedReviewers = new Set();
    frameworkMeasurements = [];
    sources = new Map();
    sourceLookups = 0;
    enableShareHandoff = false;
    service = openWorkspace();
    base = await openApi(service);
  });

  afterEach(async () => {
    await Promise.all(apps.map(app => new Promise<void>(resolve => app.close(() => resolve()))));
    if (directory) await rm(directory, { force: true, recursive: true });
  });

  function get(suffix = '', actor = 'author', project = projectId) {
    return fetch(`${base}${project}/design${suffix}`, { headers: { 'x-fixture-user': actor } });
  }

  function publish(requestId: string, bytes: Buffer, query: Record<string, string> = {},
    context: { actor?: string; api?: string; project?: string } = {}) {
    const filters = new URLSearchParams({ requestId, sourceCommit, ...query });
    return fetch(`${context.api ?? base}${context.project ?? projectId}/design/packages?${filters}`, { method: 'POST', body: new Uint8Array(bytes),
      headers: { 'x-fixture-user': context.actor ?? 'designer', 'Content-Type': 'application/zip' } });
  }

  function command(type: string, fields: object, actor = 'author', requestId: string = crypto.randomUUID(), project = projectId) {
    return fetch(`${base}${project}/design/commands`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-fixture-user': actor },
      body: JSON.stringify({ type, requestId, ...fields }),
    });
  }

  describe('automatic design library covers', () => {
    function pausedCover() {
      const image = png(1280, 800);
      let finish!: (bytes: Buffer) => void;
      const capture = new Promise<Buffer>(resolve => { finish = resolve; });
      return { image, captureCover: vi.fn(async (_prototype: Buffer, _target: DesignReferenceTarget) => capture),
        finish: () => finish(image) };
    }

    it('queues a private cover after publication without waiting for a library read or modifying the submitted ZIP', async () => {
      const { image, captureCover, finish } = pausedCover();
      base = await openApi(openWorkspace(undefined, directory, captureCover));
      const archive = draft('A design with no cover in its package');
      const route = { sourceMode: 'private', intent: 'create', designKey: 'fixture/cover', sourcePath: 'design/cover' };
      let designId: string;
      try {
        const published = await publish('cover-first', archive, route, { actor: 'git-designer' });
        expect(published.status).toBe(201);
        ({ designId } = (await published.json()).result);
        await vi.waitFor(() => expect(captureCover).toHaveBeenCalledTimes(1));
        expect(captureCover).toHaveBeenCalledWith(Buffer.from(html), expect.objectContaining({
          screen: expect.objectContaining({ id: 'members', route: '#members', viewport: 'desktop' }), theme: 'light',
        }));
        const replay = await publish('cover-first', archive, route, { actor: 'git-designer' });
        expect(replay.status).toBe(200);
        const pending = await (await get('?view=summary', 'read-designer')).json();
        expect(pending.coverPending).toBe(true);
        expect(pending.designs[0].versions[0]).not.toHaveProperty('cover');
      } finally {
        finish();
      }

      const version = await vi.waitFor(async () => {
        const { designs } = await (await get('?view=summary', 'read-designer')).json();
        expect(designs[0].versions[0].cover).toMatchObject({ id: expect.any(String), screenId: 'members', theme: 'light',
          sha256: createHash('sha256').update(image).digest('hex') });
        return designs[0].versions[0];
      });
      expect(captureCover).toHaveBeenCalledTimes(1);
      const cover = await get(`/artifacts/${version.cover.id}`, 'read-designer');
      expect(cover.status).toBe(200);
      expect(cover.headers.get('content-type')).toContain('image/png');
      expect(cover.headers.get('cache-control')).toContain('private');
      expect(Buffer.from(await cover.arrayBuffer())).toEqual(image);
      expect((await get(`/artifacts/${version.cover.id}`, 'outside')).status).toBe(404);
      expect((await get(`/artifacts/${version.cover.id}`, 'author', otherProjectId)).status).toBe(404);

      const detail = await (await get(`?designId=${designId}&version=1`, 'read-designer')).json();
      const delivered = detail.designs[0].versions[0];
      expect(delivered.sha256).toBe(createHash('sha256').update(archive).digest('hex'));
      expect(delivered.delivery.files.some((file: { path: string }) => file.path.endsWith('.png'))).toBe(false);
      expect(Buffer.from(await (await get(`/artifacts/${delivered.delivery.archiveId}`, 'read-designer')).arrayBuffer())).toEqual(archive);
      const thumbnail = await (await get(`?view=thumbnails&designId=${designId}&version=1`, 'read-designer')).json();
      expect(thumbnail).toMatchObject({ completed: 0, renders: {} });
    });

    it('backfills an existing draft once for concurrent library readers and persists its cover separately from a delivered reference', async () => {
      const deliveredReference = png(1280, 800, Buffer.alloc((1280 * 3 + 1) * 800, 1));
      const archive = draft('An earlier design', {}, [{ name: 'bundle/screens/members.dark.png', data: deliveredReference }]);
      const published = await publish('existing-cover', archive);
      expect(published.status).toBe(201);
      const { designId } = (await published.json()).result;
      const before = await (await get('?view=summary')).json();
      expect(before.designs[0].versions[0]).not.toHaveProperty('cover');
      const reference = before.designs[0].versions[0].renders.members.dark;

      const { image, captureCover, finish } = pausedCover();
      base = await openApi(openWorkspace(undefined, directory, captureCover));
      try {
        expect((await get('?view=summary', 'outside')).status).toBe(404);
        expect((await (await get('?view=summary', 'author', otherProjectId)).json()).designs).toEqual([]);
        expect(captureCover).not.toHaveBeenCalled();
        const readers = await Promise.all(['read-designer', 'reading-member', 'author'].map(actor => get('?view=summary', actor)));
        expect(readers.map(response => response.status)).toEqual([200, 200, 200]);
        await vi.waitFor(() => expect(captureCover).toHaveBeenCalledTimes(1));
      } finally {
        finish();
      }

      const cover = await vi.waitFor(async () => {
        const { designs } = await (await get('?view=summary')).json();
        expect(designs[0].versions[0].cover).toMatchObject({ id: expect.any(String), screenId: 'members', theme: 'light' });
        return designs[0].versions[0].cover;
      });
      expect(cover.id).not.toBe(reference.id);
      expect(captureCover).toHaveBeenCalledTimes(1);

      base = await openApi(openWorkspace());
      const persisted = await (await get('?view=summary', 'read-designer')).json();
      expect(persisted.designs[0].versions[0].cover).toEqual(cover);
      expect(Buffer.from(await (await get(`/artifacts/${cover.id}`, 'read-designer')).arrayBuffer())).toEqual(image);
      const thumbnail = await (await get(`?view=thumbnails&designId=${designId}&version=1`, 'read-designer')).json();
      expect(thumbnail.renders).toEqual({ members: { dark: reference } });
      expect(Buffer.from(await (await get(`/artifacts/${reference.id}`, 'read-designer')).arrayBuffer())).toEqual(deliveredReference);
    });
  });

  it('lets design credentials read and reply to one explicit planning handoff before publishing a draft', async () => {
    const fields = { designKey: 'fixture/brief', planId: 'PLN-approved', expectedVersion: 2 };
    expect((await command('brief.share', fields, 'designer')).status).toBe(403);
    expect((await command('brief.share', fields, 'author')).status).toBe(403);
    expect((await command('brief.share', { ...fields, expectedVersion: 1 }, 'steward')).status).toBe(409);
    expect((await command('brief.share', fields, 'steward', 'other-share', otherProjectId)).status).toBe(404);
    expect((await command('brief.share', fields, 'steward', 'share-approved')).status).toBe(201);
    expect((await command('brief.share', fields, 'steward', 'share-approved')).status).toBe(200);
    expect((await command('brief.share', { ...fields, designKey: 'fixture/duplicate' }, 'steward')).status).toBe(409);
    const reply = { type: 'brief.reply', requestId: 'clarify-once', designKey: fields.designKey, expectedVersion: 2, body: 'Which empty state?' };
    const feedback = () => fetch(`${base}${projectId}/design/feedback`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-fixture-user': 'designer' }, body: JSON.stringify(reply) });
    const first = await feedback();
    const replay = await feedback();
    expect(first.status).toBe(201);
    expect(replay.status).toBe(200);
    const intake = await (await get('/intake', 'designer')).json();
    expect(intake.requirements).toEqual([{
      designKey: fields.designKey, planId: fields.planId, planVersion: 2, proposalId: 'PRO-fixture', title: 'Approved brief',
      requirements: 'Original **approved** requirements', sharedAt: clock, owner: { id: 'steward', label: 'Fixture steward' },
      replies: [expect.objectContaining({
        id: (await first.json()).result.id, body: reply.body, planVersion: 2,
      })],
    }]);
    expect(intake.designs).toEqual([]);
    expect((await command('brief.revoke', { ...fields, expectedVersion: 1 }, 'steward')).status).toBe(409);
    expect((await command('brief.revoke', fields, 'steward')).status).toBe(201);
    expect((await (await get('/intake', 'designer')).json()).requirements).toEqual([]);
  });

  describe('design collaboration', () => {
    const brief = { designKey: 'fixture/collaboration-brief', planId: 'PLN-approved', expectedVersion: 2 };

    function post(endpoint: 'feedback' | 'viewed', body: object, actor: string, project = projectId) {
      return fetch(`${base}${project}/design/${endpoint}`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-fixture-user': actor }, body: JSON.stringify(body) });
    }

    async function readViewer(actor: string, project = projectId) {
      const response = await get('', actor, project);
      expect(response.status).toBe(200);
      return (await response.json()).viewer;
    }

    it('lets authorized publishers claim the same brief only once across concurrent credentials', async () => {
      expect((await command('brief.share', brief, 'steward')).status).toBe(201);
      const intake = async () => (await (await get('/intake', 'read-designer')).json()).requirements[0];
      expect(await intake()).toMatchObject({ designKey: brief.designKey, requirements: 'Original **approved** requirements' });
      expect(await intake()).not.toHaveProperty('assignee');

      const claim = (actor: string, requestId: string, expectedVersion = brief.expectedVersion, project = projectId) =>
        post('feedback', { type: 'brief.claim', requestId, designKey: brief.designKey, expectedVersion }, actor, project);
      const candidates = ['designer', 'git-designer'];
      const results = await Promise.all(candidates.map(actor => claim(actor, `claim-${actor}`)));
      expect(results.map(response => response.status).sort()).toEqual([201, 409]);
      const winner = candidates[results.findIndex(response => response.status === 201)];
      const loser = candidates.find(actor => actor !== winner)!;
      const { id, label } = people.get(winner)!;
      expect(await intake()).toMatchObject({ designKey: brief.designKey, assignee: { id, label }, owner: { id: 'steward' } });

      const replay = await claim(winner, `claim-${winner}`);
      expect(replay.status).toBe(200);
      expect(await replay.json()).toMatchObject({ projectId, reused: true, result: { type: 'brief.claim', designKey: brief.designKey, version: 2 } });
      expect((await claim(winner, 'repeat-my-claim')).ok).toBe(true);
      expect((await claim(loser, 'second-attempt')).status).toBe(409);
      expect((await claim(winner, 'stale-plan', 1)).status).toBe(409);
      expect((await claim('read-designer', 'no-publish-scope')).status).toBe(403);
      expect((await claim('implementer', 'feedback-only')).status).toBe(403);
      expect((await claim('outside', 'no-project-access')).status).toBe(404);
      expect((await claim(winner, 'separate-project', 2, otherProjectId)).status).toBe(404);
      expect(await intake()).toMatchObject({ assignee: { id, label } });
    });

    it('keeps design version and feedback read marks independent and monotonic for one member', async () => {
      const reader = 'reading-member';
      const path = 'design/collaboration/monotonic';
      const v1 = draft('Read progress V1');
      const first = await publish('read-progress-publish-1', v1, {
        ...gitSource(v1, path), intent: 'create', designKey: 'fixture/read-progress',
      });
      expect(first.status).toBe(201);
      const { designId } = (await first.json()).result;
      const seen = (version: number, fields: object = {}, actor = reader, project = projectId) =>
        post('viewed', { kind: 'design', designId, version, ...fields }, actor, project);
      const mark = async () => (await readViewer(reader)).designs[designId];
      const firstRead = await seen(1);
      expect(firstRead.ok, `mark V1 returned HTTP ${firstRead.status}`).toBe(true);
      expect(await mark()).toEqual({ version: 1 });

      const v2 = draft('Read progress V2');
      expect((await publish('read-progress-publish-2', v2, {
        ...gitSource(v2, path, 'b'), intent: 'revise', designId, expectedVersion: '1',
      })).status).toBe(201);
      expect((await seen(1)).ok).toBe(true);
      expect(await mark()).toEqual({ version: 1 });
      const sendFeedback = (requestId: string, title: string) => post('feedback', { type: 'feedback.create', requestId, designId,
        version: 2, category: 'reuse', title, body: 'Review the new card independently.' }, 'implementer');
      clock = '2026-11-21T10:05:00.000Z';
      const firstFeedbackAt = clock;
      expect((await sendFeedback('first-feedback-for-read', 'Check the V2 card')).status).toBe(201);
      expect((await seen(2)).ok).toBe(true);
      expect(await mark()).toEqual({ version: 2 });
      expect((await seen(2, { feedbackAt: firstFeedbackAt })).ok).toBe(true);
      expect(await mark()).toEqual({ version: 2, feedbackAt: firstFeedbackAt });

      clock = '2026-11-21T10:20:00.000Z';
      expect((await sendFeedback('new-feedback-for-read', 'Check the V2 empty state')).status).toBe(201);
      expect((await seen(1, { feedbackAt: firstFeedbackAt })).ok).toBe(true);
      expect((await seen(2)).ok).toBe(true);
      expect(await mark()).toEqual({ version: 2, feedbackAt: firstFeedbackAt });
      expect((await seen(2, { feedbackAt: '2026-11-22T10:20:00.000Z' })).status).toBe(400);
      expect((await seen(2, { feedbackAt: 'yesterday' })).status).toBe(400);
      expect((await seen(2, { feedbackAt: '2026-11-00T10:20:00.000Z' })).status).toBe(400);
      expect((await seen(99)).status).toBe(404);
      expect((await seen(2, { actorId: 'other' })).status).toBe(400);
      expect((await seen(2, {}, 'designer')).status).toBe(403);
      expect((await seen(2, {}, 'outside')).status).toBe(404);
      expect((await seen(2, {}, reader, otherProjectId)).status).toBe(404);
      expect((await readViewer('other')).designs).toEqual({});
      expect((await readViewer(reader, otherProjectId)).designs).toEqual({});
      expect(await readViewer('designer')).toBeUndefined();
      expect((await seen(2, { feedbackAt: clock })).ok).toBe(true);
      expect(await mark()).toEqual({ version: 2, feedbackAt: clock });
    });

    it('records personal visits and protects a newly shared brief from stale read marks', async () => {
      const reader = 'reading-member';
      const firstVisitAt = clock;
      const visit = await post('viewed', { kind: 'library' }, reader);
      expect(visit.ok, `mark library returned HTTP ${visit.status}`).toBe(true);
      expect(await readViewer(reader)).toMatchObject({ firstVisitAt, lastVisitAt: firstVisitAt, designs: {}, briefs: {} });
      expect((await readViewer('other')).firstVisitAt).toBeUndefined();
      expect((await command('brief.share', brief, 'steward')).status).toBe(201);
      const seen = (sharedAt: string, actor = reader) => post('viewed', { kind: 'brief', designKey: brief.designKey, sharedAt }, actor);
      expect((await seen(firstVisitAt)).ok).toBe(true);
      expect((await readViewer(reader)).briefs).toEqual({ [brief.designKey]: firstVisitAt });
      expect((await readViewer('other')).briefs).toEqual({});
      clock = '2026-11-21T11:05:00.000Z';
      approvedPlanVersion = 3;
      expect((await command('brief.share', { ...brief, expectedVersion: 3 }, 'steward')).status).toBe(201);
      expect((await seen(firstVisitAt, 'other')).status).toBe(409);
      expect((await seen(firstVisitAt)).status).toBe(409);
      expect((await readViewer(reader)).briefs).toEqual({ [brief.designKey]: firstVisitAt });
      expect((await seen(clock)).ok).toBe(true);
      expect((await post('viewed', { kind: 'library' }, reader)).ok).toBe(true);
      expect(await readViewer(reader)).toMatchObject({ firstVisitAt, lastVisitAt: clock, briefs: { [brief.designKey]: clock } });
      expect(await readViewer('other')).toEqual({ designs: {}, briefs: {} });
    });

    it('allows the personal mark through the normal project grant guard', async () => {
      const state = new StateService(path.join(directory, 'project-access.json'), directory);
      state.load();
      state.addProject({ id: projectId, slug: projectId, name: 'Fixture project', kind: 'git',
        dockerNetwork: 'fixture-no-containers', createdAt: clock, updatedAt: clock });
      const principalId = humanPrincipalId('reading-member');
      state.addPrincipal({ id: principalId, name: 'Reading member', kind: 'human', status: 'active', createdAt: clock });
      state.addProjectGrant({ id: 'fixture-read-grant', projectId, principalId, origin: 'approved', grantedAt: clock });
      await state.flush();
      const guarded = `${await openApi(service, state)}${projectId}/design`;
      const mark = (actor: string) => fetch(`${guarded}/viewed`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-fixture-user': actor }, body: JSON.stringify({ kind: 'library' }) });
      const accepted = await mark('reading-member');
      expect(accepted.ok, `the project member mark returned HTTP ${accepted.status}`).toBe(true);
      expect(await accepted.json()).toMatchObject({ projectId, viewer: { firstVisitAt: clock } });
      expect((await mark('other')).status).toBe(404);
    });
  });

  describe('project design scope', () => {
    const system = { systemId: 'ops-hub', systemName: 'Operations hub' };
    const primary = { systemId: system.systemId, moduleId: 'incident-review' };
    const linked = { systemId: 'report-hub', moduleId: 'handoff' };
    const foreign = { systemId: 'foreign-hub', moduleId: 'foreign-module' };
    const sameSystem = { systemId: system.systemId, moduleId: 'overview' };

    function register(fields: object, project = projectId) {
      return command('scope.register', fields, 'steward', crypto.randomUUID(), project);
    }

    async function registerModules() {
      expect((await register({ ...system, ...primary, moduleName: 'Incident review' })).status).toBe(201);
      expect((await register({ ...linked, systemName: 'Reports hub', moduleName: 'Handoff' })).status).toBe(201);
      expect((await register({ ...foreign, systemName: 'Foreign hub', moduleName: 'Foreign module' }, otherProjectId)).status).toBe(201);
    }

    function scopedPublish(title: string, designKey: string, extra: Record<string, unknown> = {}, revision?: { designId: string; expectedVersion: number }) {
      return publish(crypto.randomUUID(), draft(title, extra), {
        sourceMode: 'private', sourcePath: `design/${designKey}`, sourceCommit: revision ? 'b'.repeat(40) : sourceCommit,
        ...(revision ? { intent: 'revise', designId: revision.designId, expectedVersion: String(revision.expectedVersion) }
          : { intent: 'create', designKey }),
      }, { actor: 'git-designer' });
    }

    it('stores stable systems and modules for project readers and reserves registration for human project stewards', async () => {
      const created = await register(system);
      expect(created.status).toBe(201);
      expect((await (await get()).json()).systems).toEqual([{ id: system.systemId, name: system.systemName, modules: [] }]);
      const fields = { ...system, ...primary, moduleName: 'Incident review', note: 'Used for project handoff' };
      expect((await command('scope.register', fields, 'designer')).status).toBe(403);
      expect((await command('scope.register', fields, 'author')).status).toBe(403);
      expect((await command('scope.register', fields, 'outside')).status).toBe(404);
      expect((await register({ ...fields, systemId: 'Invalid/System' })).status).toBe(400);
      expect((await register({ ...fields, systemId: 'Uppercase' })).status).toBe(400);
      expect((await register({ ...fields, moduleId: 'invalid module' })).status).toBe(400);
      expect((await command('scope.register', fields, 'steward', 'register-incident-module')).status).toBe(201);
      expect((await command('scope.register', fields, 'steward', 'register-incident-module')).status).toBe(200);

      const expected = [{ id: system.systemId, name: system.systemName, modules: [{ id: primary.moduleId,
        name: fields.moduleName, note: fields.note }] }];
      expect((await (await get()).json()).systems).toEqual(expected);
      expect((await (await get('/intake', 'git-designer')).json()).systems).toEqual(expected);
      expect((await (await get('/intake', 'outside', otherProjectId)).json()).systems ?? []).toEqual([]);
    });

    it('assigns the same existing draft and retains its published versions while rejecting foreign related modules', async () => {
      await registerModules();
      const first = await scopedPublish('Prior unclassified draft', 'ops/prior');
      expect(first.status).toBe(201);
      const { designId } = (await first.json()).result;
      const second = await scopedPublish('Prior unclassified draft updated', 'ops/prior', {}, { designId, expectedVersion: 1 });
      expect(second.status).toBe(201);
      const { designs: [before] } = await (await get()).json();
      expect(before.versions.map((row: { version: number }) => row.version)).toEqual([1, 2]);
      expect(before.scope).toBeUndefined();

      const scope = { ...primary, related: [linked] };
      const fields = { designId, ...scope };
      expect((await command('scope.assign', fields, 'git-designer')).status).toBe(403);
      expect((await command('scope.assign', fields, 'author')).status).toBe(403);
      expect([400, 404, 409]).toContain((await command('scope.assign', { ...fields, related: [foreign] }, 'steward')).status);
      expect([400, 404, 409]).toContain((await command('scope.assign', { ...fields, ...foreign }, 'steward')).status);
      expect((await (await get()).json()).designs[0].scope).toBeUndefined();
      expect((await command('scope.assign', fields, 'steward', 'assign-prior-draft')).status).toBe(201);
      expect((await command('scope.assign', fields, 'steward', 'assign-prior-draft')).status).toBe(200);
      const { designs: [after] } = await (await get()).json();
      expect(after).toMatchObject({ id: before.id, projectId, designKey: before.designKey, scope });
      expect(after.versions).toEqual(before.versions);
      const reopened = await openApi(openWorkspace());
      const intake = await fetch(`${reopened}${projectId}/design/intake`, { headers: { 'x-fixture-user': 'git-designer' } });
      expect(intake.status).toBe(200);
      expect((await intake.json()).designs).toMatchObject([{ designId, latestVersion: 2, scope }]);
      const archived = await get(`/artifacts/${before.versions[0].delivery.archiveId}`, 'read-designer');
      expect(archived.status).toBe(200);
      expect(createHash('sha256').update(Buffer.from(await archived.arrayBuffer())).digest('hex')).toBe(before.versions[0].sha256);
    });

    it('validates a manifest scope, retains it on revision and requires an explicit assignment to move it', async () => {
      expect([400, 404, 409]).toContain((await scopedPublish('Unregistered scope', 'ops/reject', { scope: primary })).status);
      await registerModules();
      expect((await register({ ...system, ...sameSystem, moduleName: 'Overview' })).status).toBe(201);
      expect([400, 404, 409]).toContain((await scopedPublish('Foreign module', 'ops/foreign', { scope: foreign })).status);
      expect([400, 404, 409]).toContain((await scopedPublish('Foreign relationship', 'ops/foreign-related', {
        scope: { ...primary, related: [foreign] },
      })).status);
      const scope = { ...primary, related: [linked] };
      const first = await scopedPublish('A scoped draft', 'ops/new', { scope });
      expect(first.status).toBe(201);
      const { designId } = (await first.json()).result;
      const baseline = { designId, expectedVersion: 1 };
      expect((await scopedPublish('Silent move', 'ops/new', { scope: sameSystem }, baseline)).status).toBe(409);
      expect((await scopedPublish('Keep scope implicitly', 'ops/new', {}, baseline)).status).toBe(201);
      const { designs } = await (await get('/intake', 'git-designer')).json();
      expect(designs).toMatchObject([{ designId, latestVersion: 2, scope }]);
    });

    it('inherits the module or system framework and pins each publication without overriding an explicit framework', async () => {
      const systemFramework = 'FW-scope-system';
      const moduleFramework = 'FW-scope-module';
      const addFramework = (frameworkId: string, expectedVersion: number, sha: string) => command('framework.import', {
        frameworkId, expectedVersion, title: `${frameworkId} revision ${expectedVersion + 1}`, sourceCommit: sha.repeat(40),
        material: { rules: `## R-1 Preserve fixture review heading ${expectedVersion + 1}` },
        charter: { status: 'adopted', intent: 'Keep fixture headers consistent', problems: [], nonGoals: [],
          scope: { system: system.systemName, modules: [] }, owner: 'Fixture steward' },
      }, 'steward');
      expect((await addFramework(systemFramework, 0, 'c')).status).toBe(201);
      expect((await addFramework(moduleFramework, 0, 'd')).status).toBe(201);
      expect((await register({ ...system, framework: systemFramework })).status).toBe(201);
      expect((await register({ ...system, ...primary, moduleName: 'Incident review', framework: moduleFramework })).status).toBe(201);
      expect((await register({ ...system, ...sameSystem, moduleName: 'Overview' })).status).toBe(201);

      const first = await scopedPublish('Module default', 'ops/with-module', { scope: primary });
      const fallback = await scopedPublish('System fallback', 'ops/with-system', { scope: sameSystem });
      expect(first.status).toBe(201);
      expect(fallback.status).toBe(201);
      const { designId } = (await first.json()).result;
      const fallbackId = (await fallback.json()).result.designId;
      expect((await addFramework(moduleFramework, 1, 'e')).status).toBe(201);
      const fresh = await scopedPublish('New publication uses revised default', 'ops/new-framework', { scope: primary });
      expect(fresh.status).toBe(201);
      const freshId = (await fresh.json()).result.designId;
      const explicit = await scopedPublish('Explicit alternate framework', 'ops/with-module', {
        scope: primary, framework: systemFramework, frameworkVersion: 1,
      }, { designId, expectedVersion: 1 });
      expect(explicit.status).toBe(201);
      const { designs, systems } = await (await get()).json();
      expect(systems).toMatchObject([{ id: system.systemId, framework: systemFramework,
        modules: [{ id: primary.moduleId, framework: moduleFramework }, { id: sameSystem.moduleId }] }]);
      const revisions = (id: string) => designs.find((entry: { id: string }) => entry.id === id).versions;
      expect(revisions(designId)).toMatchObject([
        { version: 1, framework: moduleFramework, frameworkVersion: 1 },
        { version: 2, framework: systemFramework, frameworkVersion: 1 },
      ]);
      expect(revisions(fallbackId)).toMatchObject([{ framework: systemFramework, frameworkVersion: 1 }]);
      expect(revisions(freshId)).toMatchObject([{ framework: moduleFramework, frameworkVersion: 2 }]);
    });

    it('shows the scoped planning handoff and verified owner to the authorized designer', async () => {
      await registerModules();
      const fields = { designKey: 'ops/approved-brief', planId: 'PLN-approved', expectedVersion: 2 };
      expect((await command('brief.share', { ...fields, ...primary }, 'git-designer')).status).toBe(403);
      expect((await command('brief.share', { ...fields, ...primary, owner: { id: 'outside', label: 'Forged owner' } }, 'steward')).status).toBe(400);
      expect([400, 404, 409]).toContain((await command('brief.share', { ...fields, ...foreign }, 'steward')).status);
      expect((await command('brief.share', { ...fields, ...primary }, 'steward')).status).toBe(201);
      const expected = { designKey: fields.designKey, planId: fields.planId, planVersion: 2, proposalId: 'PRO-fixture',
        title: 'Approved brief', requirements: 'Original **approved** requirements', sharedAt: clock,
        scope: primary, owner: { id: 'steward', label: 'Fixture steward' } };
      expect((await (await get('/intake', 'git-designer')).json()).requirements).toEqual([expected]);
      expect((await (await get()).json()).requirements).toEqual([expected]);
      expect((await (await get('/intake', 'outside', otherProjectId)).json()).requirements).toEqual([]);
      const draftReceipt = await scopedPublish('Draft for approved handoff', fields.designKey);
      expect(draftReceipt.status).toBe(201);
      const { designId } = (await draftReceipt.json()).result;
      expect((await (await get('/intake', 'git-designer')).json()).designs).toMatchObject([{ designId, scope: primary }]);
    });

    it('keeps old handoffs readable and infers a matching scope without inventing a historical owner', async () => {
      const briefing = { designKey: 'ops/legacy-brief', planId: 'PLN-old', planVersion: 1, proposalId: 'PRO-legacy',
        title: 'Old approved brief', requirements: 'Legacy approved original', sharedAt: clock };
      const store = new FileProjectRevisionStore<DesignWorkspaceCommit>(directory);
      expect(await store.append({ projectId, revision: 1,
        request: { key: 'legacy-brief', fingerprint: 'legacy-brief', result: { type: 'brief.share' } },
        brief: { designKey: briefing.designKey, value: briefing },
      })).toBe(true);
      expect((await (await get('/intake', 'git-designer')).json()).requirements).toEqual([briefing]);
      await registerModules();
      expect((await scopedPublish('A newly classified legacy draft', briefing.designKey, { scope: primary })).status).toBe(201);
      expect((await (await get('/intake', 'git-designer')).json()).requirements).toEqual([{ ...briefing, scope: primary }]);
    });
  });

  describe('private-source publication', () => {
    it('stores and serves exact private archives across versions without Git and keeps human review and sharing gates', async () => {
      const first = draft('Private version one');
      const sourcePath = 'design/private-fixture';
      const firstInput = { sourceMode: 'private', intent: 'create', designKey: 'fixture/private', sourcePath,
        sourceCommit: '1'.repeat(40), reviewerIds: JSON.stringify(['author']) };
      const publisher = { actor: 'git-designer' };
      const published = await publish('private-first', first, firstInput, publisher);
      expect(published.status).toBe(201);
      const receipt = await published.json();
      const { designId } = receipt.result;
      const replay = await publish('private-first', withZipComment(first), firstInput, { ...publisher, api: await openApi(openWorkspace()) });
      expect(replay.status).toBe(200);
      expect(await replay.json()).toEqual({ ...receipt, reused: true });
      const { sourceMode: _private, ...gitInput } = firstInput;
      const changedMode = await publish('private-first', first, gitInput, publisher);
      expect(changedMode.status).toBe(409);
      expect(await changedMode.json()).toMatchObject({ message: expect.stringContaining('同一请求编号') });

      const second = draft('Private version two');
      const revise = { sourceMode: 'private', intent: 'revise', designId, expectedVersion: '1', sourcePath, sourceCommit: '2'.repeat(40) };
      expect((await publish('unowned-revision', second, revise, { actor: 'designer' })).status).toBe(403);
      expect((await publish('read-only-revision', second, revise, { actor: 'read-designer' })).status).toBe(403);
      expect((await publish('outside-revision', second, revise, { actor: 'outside' })).status).toBe(404);
      expect((await publish('private-revision', second, revise, publisher)).status).toBe(201);
      expect((await publish('stale-revision', second, { ...revise, sourceCommit: '3'.repeat(40) }, publisher)).status).toBe(409);
      expect(sourceLookups).toBe(0);
      const { designs } = await (await get()).json();
      const item = designs[0];
      expect(designs).toHaveLength(1);
      expect(item).toMatchObject({ id: designId, reviewRequested: true, reviewers: [{ id: 'author' }] });
      expect(item.versions).toHaveLength(2);
      expect(item.versions[0].delivery.archiveId).not.toBe(item.versions[1].delivery.archiveId);
      for (const [index, bytes] of [first, second].entries()) {
        const version = item.versions[index];
        expect(version).toMatchObject({ version: index + 1, sourceVerification: 'private-upload', sourcePath,
          sourceCommit: [firstInput.sourceCommit, revise.sourceCommit][index], sha256: createHash('sha256').update(bytes).digest('hex') });
        const path = `/artifacts/${version.delivery.archiveId}`;
        const archive = await get(path, 'read-designer');
        expect(archive.status).toBe(200);
        expect(archive.headers.get('cache-control')).toBe('private, no-store');
        expect(archive.headers.get('content-type')).toContain('application/zip');
        expect(Buffer.from(await archive.arrayBuffer())).toEqual(bytes);
        expect((await get(path, 'outside')).status).toBe(404);
        expect((await get(path, 'author', otherProjectId)).status).toBe(404);
      }
      expect((await (await get('/intake')).json()).designs).toEqual([
        expect.objectContaining({ designId, designKey: firstInput.designKey, latestVersion: 2, sourcePaths: [sourcePath] }),
      ]);
      const freeze = { designId, version: 2 };
      expect((await command('design.freeze', freeze, 'git-designer')).status).toBe(403);
      expect((await command('design.freeze', freeze, 'other')).status).toBe(403);
      expect((await command('design.freeze', freeze, 'author')).status).toBe(201);
      const share = await command('share.prepare', { ...freeze, sourceCommit: revise.sourceCommit,
        packageSha256: item.versions[1].sha256, audience: 'password', expiresInHours: 24 });
      expect(share.status).toBe(409);
      expect(await share.json()).toMatchObject({ message: expect.stringContaining('Git') });
    });

    it('reserves private directory and design identity across source modes in the same project', async () => {
      const git = draft('Git verified fixture');
      const gitPath = 'design/git-owned';
      const gitResponse = await publish('git-owned', git, { ...gitSource(git, gitPath), requireGit: 'true', intent: 'create', designKey: 'fixture/git' });
      expect(gitResponse.status).toBe(201);
      const { designId: gitId } = (await gitResponse.json()).result;
      const input = { sourceMode: 'private', intent: 'create', designKey: 'fixture/private-owned', sourceCommit: '2'.repeat(40) };
      const privateBytes = draft('Private upload fixture');
      const collision = await publish('private-in-git-directory', privateBytes, { ...input, sourcePath: gitPath });
      expect(collision.status).toBe(409);
      expect(JSON.stringify(await collision.json())).toContain(gitId);

      const sourcePath = 'design/private-owned';
      const published = await publish('private-owned', privateBytes, { ...input, sourcePath });
      expect(published.status).toBe(201);
      const { designId: privateId } = (await published.json()).result;
      const keyCollision = await publish('private-key-taken', privateBytes, { ...input, sourcePath: 'design/new-directory' }, { actor: 'git-designer' });
      expect(keyCollision.status).toBe(409);
      expect(JSON.stringify(await keyCollision.json())).toContain(privateId);
      const pathCollision = await publish('private-path-taken', privateBytes, { ...input, sourcePath, designKey: 'fixture/another' }, { actor: 'git-designer' });
      expect(pathCollision.status).toBe(409);
      expect(JSON.stringify(await pathCollision.json())).toContain(privateId);
      const gitCollision = await publish('git-in-private-directory', git, { ...gitSource(git, sourcePath, 'b'),
        intent: 'create', designKey: 'fixture/another-git', requireGit: 'true' }, { actor: 'git-designer' });
      expect(gitCollision.status).toBe(409);
      expect(JSON.stringify(await gitCollision.json())).toContain(privateId);
      expect(await new FileProjectRevisionStore<DesignWorkspaceCommit>(directory).read(projectId, 0)).toHaveLength(2);
    });

    it('rejects invalid private source submissions and preserves explicit Git verification', async () => {
      const bytes = draft('Validated private upload');
      const sourcePath = 'design/validated-private';
      const input = { sourceMode: 'private', intent: 'create', designKey: 'fixture/validation', sourcePath, sourceCommit: '3'.repeat(40) };
      const { intent: _intent, ...missingIntent } = input;
      const { sourcePath: _path, ...missingPath } = input;
      for (const [label, fields] of Object.entries({
        'missing-intent': missingIntent, 'missing-path': missingPath, 'root-path': { ...input, sourcePath: '.' },
        'absolute-path': { ...input, sourcePath: '/design/private' }, 'traversal-path': { ...input, sourcePath: '../private' },
        'invalid-sha': { ...input, sourceCommit: 'main' }, 'ambiguous-mode': { ...input, requireGit: 'true' },
        'unsupported-mode': { ...input, sourceMode: 'arbitrary' },
      })) {
        expect((await publish(label, bytes, fields)).status, label).toBe(400);
      }
      expect((await publish('malformed-archive', Buffer.from('not a ZIP'), input)).status).toBe(400);
      expect(await new FileProjectRevisionStore<DesignWorkspaceCommit>(directory).read(projectId, 0)).toEqual([]);

      const { sourceMode: _mode, ...gitInput } = input;
      const credentials = { actor: 'git-designer' };
      const absent = await publish('git-source-absent', bytes, gitInput, credentials);
      expect(absent.status).toBe(409);
      expect(await absent.json()).toMatchObject({ error: 'design_git_source_required' });
      const source = gitSource(bytes, sourcePath, '3');
      expect((await publish('git-bytes-mismatch', draft('Different revision'), { ...gitInput, ...source, requireGit: 'true' }, credentials)).status).toBe(409);
      expect((await publish('git-bytes-match', bytes, { ...gitInput, ...source, requireGit: 'true' }, credentials)).status).toBe(201);
      expect((await (await get()).json()).designs[0].versions[0]).toMatchObject({ sourceVerification: 'git' });
    });
  });


  it('preserves complete delivery files and advice as private versioned material', async () => {
    const guide = '# 合成交付说明\n核对实现地址和手机画面。\n';
    const spec = '# 实现契约\n明暗双主题。\n';
    const comparison = png(640, 480);
    const bytes = draft('Complete delivery', {
      source: '原型源码/', frameworkDraft: 'spec/', prototypeVersion: 21, date: '2026-11-21',
      notes: '验收时核对导航和滚动。', docs: ['设计文档/实现.md', '开发说明/开发说明.md'],
    }, [
      { name: 'bundle/交付说明.md', data: Buffer.from(guide) },
      { name: 'bundle/设计文档/实现.md', data: Buffer.from(spec) },
      { name: 'bundle/开发说明/开发说明.md', data: Buffer.from('# 开发说明\n合成数据。') },
      { name: 'bundle/原型源码/build.mjs', data: Buffer.from('console.log("fixture");') },
      { name: 'bundle/spec/rules.md', data: Buffer.from('# Rules\nMaterial only.') },
      { name: 'bundle/checks/result.json', data: Buffer.from(JSON.stringify({ total: 1, passed: 1, items: [{ name: 'Synthetic', pass: true }] })) },
      { name: 'bundle/other/example.dat', data: Buffer.from([0, 255, 100]) },
      { name: 'bundle/compare/flow.png', data: comparison },
      { name: 'bundle/compare/unrecognized.png', data: Buffer.from([0, 255, 100]) },
    ]);
    const created = await publish('complete-delivery', bytes, {
      intent: 'create', designKey: 'fittings/receipt', ...gitSource(bytes, 'design/fittings/receipt'),
    });
    expect(created.status).toBe(201);
    const { result: { designId } } = await created.json();
    // A separate service reads the durable revision, not a live writer's memory.
    base = await openApi(openWorkspace());
    const listing = await (await get('', 'read-designer')).json();
    const version = listing.designs.find((row: { id: string }) => row.id === designId).versions[0];
    const delivery = version.delivery;
    expect(delivery).toMatchObject({ source: '原型源码/', frameworkDraft: 'spec/', prototypeVersion: 21,
      date: '2026-11-21', notes: '验收时核对导航和滚动。', warnings: [] });
    expect(delivery.files.map((file: { path: string }) => file.path)).toHaveLength(12);
    const guideFile = delivery.files.find((file: { path: string }) => file.path === '交付说明.md');
    expect(guideFile).toMatchObject({ kind: 'guide', sha256: createHash('sha256').update(guide).digest('hex') });
    expect(delivery.files).toContainEqual(expect.objectContaining({ path: '原型源码/build.mjs', kind: 'source' }));
    expect(delivery.files).toContainEqual(expect.objectContaining({ path: '设计文档/实现.md', kind: 'document' }));
    const file = await get(`/artifacts/${guideFile.id}`, 'read-designer');
    expect(file.headers.get('content-disposition')).toContain('attachment');
    expect(await file.text()).toBe(guide);
    const text = await (await get(`/artifacts/${guideFile.id}?view=text&offset=0&limit=5`, 'read-designer')).json();
    expect(text).toMatchObject({ path: '交付说明.md', offset: 0, nextOffset: 5, text: guide.slice(0, 5), sha256: guideFile.sha256 });
    const archive = await get(`/artifacts/${delivery.archiveId}`, 'read-designer');
    expect(archive.headers.get('content-type')).toContain('application/zip');
    expect(Buffer.from(await archive.arrayBuffer())).toEqual(bytes);
    expect((await get(`/artifacts/${guideFile.id}`, 'outside', otherProjectId)).status).toBe(404);
    const comparisonFile = delivery.files.find((row: { path: string }) => row.path === 'compare/flow.png');
    const inlineImage = await get(`/artifacts/${comparisonFile.id}`, 'read-designer');
    expect(inlineImage.headers.get('content-type')).toBe('image/png');
    expect(inlineImage.headers.get('content-disposition')).toBeNull();
    expect(Buffer.from(await inlineImage.arrayBuffer())).toEqual(comparison);
    expect((await get(`/artifacts/${comparisonFile.id}?download=true`, 'read-designer')).headers.get('content-disposition')).toContain('attachment');
    expect((await get(`/artifacts/${comparisonFile.id}`, 'outside', otherProjectId)).status).toBe(404);
    const unrecognized = delivery.files.find((row: { path: string }) => row.path === 'compare/unrecognized.png');
    const raw = await get(`/artifacts/${unrecognized.id}`, 'read-designer');
    expect(raw.headers.get('content-type')).toBe('application/octet-stream');
    expect(raw.headers.get('content-disposition')).toContain('attachment');
    const preview = await get(`/artifacts/${version.prototypeId}?theme=dark`, 'read-designer');
    expect(preview.headers.get('content-security-policy')).toBeTruthy();
    expect(await preview.text()).toContain('Fixture');
    const rawPrototype = await get(`/artifacts/${version.prototypeId}?download=true`, 'read-designer');
    expect(rawPrototype.headers.get('content-disposition')).toContain('index.html');
    expect(await rawPrototype.text()).toBe(html);
  });

  it('preserves declarative prototype state for screens sharing a route', async () => {
    const shape = { name: 'Fixture', route: '#workspace', viewport: 'desktop' };
    const bytes = draft('Screen states', { screens: [
      { ...shape, id: 'cards' }, { ...shape, id: 'list', name: 'Fixture list',
        entryActions: ['button[data-view="list"]'], entryReadySelector: '[data-scene="list"]' },
    ] });
    expect((await publish('prototype-states', bytes)).status).toBe(201);
    const result = await (await get()).json();
    expect(result.designs[0].versions[0].screens[1]).toMatchObject({
      id: 'list', entryActions: ['button[data-view="list"]'], entryReadySelector: '[data-scene="list"]',
    });
  });

  it('lets scoped implementation feedback travel through a revision and back to its author', async () => {
    const first = draft('Fixture V1');
    const source = 'design/fittings/feedback';
    const creation = await publish('feedback-initial', first, { intent: 'create', designKey: 'fittings/feedback', ...gitSource(first, source) });
    expect(creation.status).toBe(201);
    const { result: { designId } } = await creation.json();
    const send = (actor: string, requestId: string, type: string, values: object, project = projectId) =>
      fetch(`${base}${project}/design/feedback`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-fixture-user': actor },
        body: JSON.stringify({ type, requestId, designId, ...values }) });
    const report = { version: 1, category: 'reuse', title: 'Use the shared list',
      body: 'The current implementation can reuse the shared list component.', screenId: 'members', evidence: ['Shared list component'] };
    expect((await send('read-designer', 'read-forbidden', 'feedback.create', report)).status).toBe(403);
    expect((await send('outside', 'project-forbidden', 'feedback.create', report, otherProjectId)).status).toBe(404);
    const request = await send('implementer', 'reuse-report', 'feedback.create', report);
    expect(request.status).toBe(201);
    const { result: { id: feedbackId } } = await request.json();
    const replay = await send('implementer', 'reuse-report', 'feedback.create', report);
    expect(replay.status).toBe(200);
    expect((await replay.json()).result.id).toBe(feedbackId);
    expect((await send('designer', 'premature-close', 'feedback.resolve', { feedbackId,
      decision: 'close', body: 'The publisher cannot sign off another author’s finding.' })).status).toBe(403);

    const update = draft('Fixture V2');
    const publishParams = { intent: 'revise', designId, expectedVersion: '1', ...gitSource(update, source, 'b') };
    expect((await publish('should-not-publish', update, publishParams, { actor: 'implementer' })).status).toBe(403);
    expect((await publish('feedback-next', update, publishParams)).status).toBe(201);
    const reply = await send('designer', 'reuse-response', 'feedback.reply', { feedbackId, body: 'V2 uses the shared list.', revision: 2 });
    expect(reply.status).toBe(201);
    expect((await send('implementer', 'confirm-reuse', 'feedback.resolve', { feedbackId, decision: 'close', body: 'Confirmed on V2.' })).status).toBe(201);
    const context = await (await get('', 'read-designer')).json();
    const row = context.designs.find((entry: { id: string }) => entry.id === designId);
    expect(row.feedback).toEqual([expect.objectContaining({ id: feedbackId, version: 1, screenId: 'members',
      category: 'reuse', status: 'closed', author: expect.objectContaining({ id: 'implementer' }),
      replies: [expect.objectContaining({ revision: 2, author: expect.objectContaining({ id: 'designer' }) })],
      decisions: [expect.objectContaining({ decision: 'close', body: 'Confirmed on V2.' })],
    })]);
    expect(row.versions.map((version: { version: number }) => version.version)).toEqual([1, 2]);
  });

  it('supplements closed legacy feedback without rewriting its original text, version or decisions', async () => {
    const created = await publish('legacy-feedback-design', draft());
    expect(created.status).toBe(201);
    const { result: { designId } } = await created.json();
    const send = (type: string, fields: object, actor = 'implementer', requestId: string = crypto.randomUUID()) =>
      fetch(`${base}${projectId}/design/feedback`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-fixture-user': actor },
        body: JSON.stringify({ type, requestId, designId, ...fields }) });
    const legacyBody = '旧反馈原文，保留当时的描述。';
    const report = await send('feedback.create', { version: 1, category: 'gap', title: '补全旧反馈的验收口径', body: legacyBody });
    expect(report.status).toBe(201);
    const { result: { id: feedbackId } } = await report.json();
    const body = '## 诉求\n\n交付页的旧反馈可补写验收口径。\n\n## 怎么算解决\n\n关闭后补写，历史状态保持原样。';
    const read = async () => (await (await get()).json()).designs[0].feedback;
    expect((await send('feedback.reply', { feedbackId, body }, 'designer')).status).toBe(201);
    expect(feedbackSummary((await read())[0])).toMatchObject({ legacy: true, supplemented: false });
    const closure = { feedbackId, decision: 'close', body: '原反馈已经确认关闭。' };
    expect((await send('feedback.resolve', closure, 'feedback-admin')).status).toBe(403);
    expect((await send('feedback.resolve', closure)).status).toBe(201);
    expect((await send('feedback.reply', { feedbackId, body })).status).toBe(409);
    const supplemented = { feedbackId, body, supplement: true };
    expect((await send('feedback.reply', supplemented, 'implementer', 'v9-legacy-supplement')).status).toBe(201);
    expect((await send('feedback.reply', supplemented, 'implementer', 'v9-legacy-supplement')).status).toBe(200);
    expect((await send('feedback.reply', supplemented, 'designer')).status).toBe(403);
    expect((await send('feedback.reply', supplemented, 'agent-with-supplement-flag')).status).toBe(403);
    expect((await send('feedback.reply', { ...supplemented, body: '## 诉求\n\n验收口径仍缺一部分。' }, 'steward')).status).toBe(400);
    expect((await send('feedback.reply', supplemented, 'steward')).status).toBe(201);
    const newerBody = body.replace('关闭后补写', '由管理员补写');
    expect((await send('feedback.reply', { ...supplemented, body: newerBody }, 'feedback-admin')).status).toBe(201);
    expect((await (await get('', 'feedback-admin')).json()).permissions).toMatchObject({ feedbackSupplement: true });
    expect((await (await get('', 'agent-with-supplement-flag')).json()).permissions.feedbackSupplement).not.toBe(true);

    const feedback = await read();
    expect(feedback).toEqual([expect.objectContaining({
      id: feedbackId, version: 1, status: 'closed', body: legacyBody,
      replies: [expect.objectContaining({ body, author: expect.objectContaining({ id: 'designer' }) }),
        expect.objectContaining({ supplement: true, body, author: expect.objectContaining({ id: 'implementer' }) }),
        expect.objectContaining({ supplement: true, body, author: expect.objectContaining({ id: 'steward' }) }),
        expect.objectContaining({ supplement: true, body: newerBody, author: expect.objectContaining({ id: 'feedback-admin' }) })],
      decisions: [expect.objectContaining({ decision: 'close', body: closure.body })],
    })]);
    expect(feedbackSummary(feedback[0])).toMatchObject({ legacy: true, supplemented: true,
      parts: { ask: '交付页的旧反馈可补写验收口径。', done: '由管理员补写，历史状态保持原样。', problem: legacyBody } });

    const structured = await send('feedback.create', { version: 1, category: 'gap', title: '新版反馈已写明两项', body });
    expect(structured.status).toBe(201);
    const { result: { id: structuredId } } = await structured.json();
    expect((await send('feedback.reply', { ...supplemented, feedbackId: structuredId })).status).toBe(409);
  });

  it('stores private feedback screenshots, preserves the thread and reuses the original attachment receipt', async () => {
    const created = await publish('attachment-design', draft('Private attachment fixture'), {
      sourceMode: 'private', intent: 'create', designKey: 'fixture/feedback-attachment', sourcePath: 'design/feedback-attachment-fixture',
    });
    expect(created.status).toBe(201);
    const { result: { designId } } = await created.json();
    const send = (actor: string, requestId: string, type: string, fields: object) =>
      fetch(`${base}${projectId}/design/feedback${type === 'feedback.attach' ? '/attachments' : ''}`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-fixture-user': actor },
        body: JSON.stringify({ type, requestId, designId, ...fields }) });
    const report = await send('implementer', 'attachment-report', 'feedback.create', {
      version: 1, screenId: 'members', category: 'acceptance', title: 'Compare the fixture screen',
      body: 'Review the expected layout against the synthetic implementation.', evidence: ['Existing fixture evidence'],
    });
    expect(report.status).toBe(201);
    const { result: { id: feedbackId } } = await report.json();
    expect((await send('designer', 'attachment-reply', 'feedback.reply', { feedbackId, body: 'Ready to compare.' })).status).toBe(201);
    const { designs } = await (await get()).json();
    const { attachments: initialAttachments, ...before } = designs[0].feedback[0];
    expect(initialAttachments ?? []).toEqual([]);
    expect(before.status).toBe('responded');

    const width = 256, height = 128;
    const rowLength = width * 3 + 1;
    const pixels = Buffer.alloc(rowLength * height);
    for (let offset = 0; offset < pixels.length; offset += 32) {
      createHash('sha256').update(String(offset)).digest().copy(pixels, offset);
    }
    for (let offset = 0; offset < pixels.length; offset += rowLength) pixels[offset] = 0;
    const capture = png(width, height, pixels);
    const image = (bytes: Buffer) => `data:image/png;base64,${bytes.toString('base64')}`;
    expect(Buffer.byteLength(image(capture))).toBeGreaterThan(48 * 1024);
    const details = { feedbackId, title: 'Implementation screenshot', image: image(capture) };
    const attach = (actor: string, requestId: string, fields = details) => send(actor, requestId, 'feedback.attach', fields);
    const accepted = await attach('implementer', 'attach-implementation');
    expect(accepted.status).toBe(201);
    const receipt = await accepted.json();
    const { artifactId } = receipt.result;
    expect(receipt).toMatchObject({ projectId, reused: false,
      result: { type: 'feedback.attach', designId, id: feedbackId, artifactId: expect.any(String) } });
    const replay = await attach('implementer', 'attach-implementation');
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ ...receipt, reused: true });
    const comparison = png(48, 36);
    expect((await attach('implementer', 'attach-implementation', { ...details, image: image(comparison) })).status).toBe(409);
    expect((await attach('read-designer', 'attach-read-only')).status).toBe(403);
    expect((await attach('implementer', 'attach-malformed', { ...details, image: image(Buffer.from('Not a PNG fixture')) })).status).toBe(400);
    const fromPublisher = await attach('designer', 'attach-design', { ...details, title: 'Design screenshot', image: image(comparison) });
    expect(fromPublisher.status).toBe(201);
    const { result: { id: threadId, artifactId: designArtifactId } } = await fromPublisher.json();
    expect(threadId).toBe(feedbackId);
    expect(designArtifactId).not.toBe(artifactId);

    base = await openApi(openWorkspace());
    const workspace = await get('', 'read-designer');
    expect(workspace.status).toBe(200);
    const { designs: reloaded } = await workspace.json();
    const { attachments, ...retained } = reloaded[0].feedback[0];
    expect(retained).toEqual(before);
    expect(attachments).toMatchObject([
      { id: artifactId, title: details.title, size: capture.length,
        sha256: createHash('sha256').update(capture).digest('hex'), author: { id: 'implementer' } },
      { id: designArtifactId, title: 'Design screenshot', size: comparison.length,
        sha256: createHash('sha256').update(comparison).digest('hex'), author: { id: 'designer' } },
    ]);
    expect(JSON.stringify(attachments)).not.toContain('data:image/png;base64,');
    for (const [id, bytes] of [[artifactId, capture], [designArtifactId, comparison]] as const) {
      const path = `/artifacts/${id}`;
      const artifact = await get(path, 'read-designer');
      expect(artifact.status).toBe(200);
      expect(artifact.headers.get('content-type')).toContain('image/png');
      expect(artifact.headers.get('cache-control')).toBe('private, no-store');
      expect(Buffer.from(await artifact.arrayBuffer())).toEqual(bytes);
      expect((await get(path, 'author', otherProjectId)).status).toBe(404);
      expect((await get(path, 'outside')).status).toBe(404);
    }
  });

  it('lists an intake with Git-verified sources, stable identity and revision rights for the actual caller', async () => {
    const first = draft('Billing workspace');
    const firstInput = gitSource(first, 'design/billing');
    const published = await publish('intake-v1', first, firstInput);
    expect(published.status).toBe(201);
    const { designId } = (await published.json()).result;
    const second = draft('Billing workspace refined');
    const nextInput = gitSource(second, 'design/billing-v2', 'c');
    expect((await publish('intake-v2', second, { ...nextInput, designId })).status).toBe(201);

    const projectIntake = await get('/intake', 'designer');
    expect(projectIntake.status).toBe(200);
    expect(projectIntake.headers.get('cache-control')).toBe('private, no-store');
    const ownerIntake = await projectIntake.json();
    expect(ownerIntake).toMatchObject({ protocolVersion: 1, projectId, permissions: { write: true }, designs: [{
      designId, latestVersion: 2, sourceCommit: nextInput.sourceCommit, sourcePaths: expect.arrayContaining([firstInput.sourcePath, nextInput.sourcePath]), canRevise: true,
    }] });
    expect(ownerIntake.designs[0].sourcePaths).toHaveLength(2);
    expect(ownerIntake.designs[0]).not.toHaveProperty('designKey');
    expect((await (await get('/intake', 'rotated-designer')).json()).designs[0].canRevise).toBe(true);
    expect((await (await get('/intake', 'git-designer')).json()).designs[0].canRevise).toBe(false);
    const readOnly = await get('/intake', 'read-designer');
    expect(readOnly.status).toBe(200);
    expect(await readOnly.json()).toMatchObject({ permissions: { write: false }, designs: [{ designId, canRevise: false }] });
    expect((await get('/intake', 'outside')).status).toBe(404);
    expect((await (await get('/intake', 'outside', otherProjectId)).json()).designs).toEqual([]);
  });

  it('rejects mistaken first publications from either publisher when Git already identifies the draft', async () => {
    const first = draft('Billing workspace');
    const source = gitSource(first, 'design/billing');
    const firstInput = { ...source, intent: 'create', designKey: 'billing/workspace' };
    const response = await publish('same-request', first, firstInput);
    expect(response.status).toBe(201);
    const { designId } = (await response.json()).result;
    const deniedFirst = await publish('same-request', first, firstInput, { actor: 'git-designer' });
    expect(deniedFirst.status).toBe(409);
    expect(JSON.stringify(await deniedFirst.json())).toContain(designId);

    const revised = draft('Billing workspace refreshed');
    const revisedSource = gitSource(revised, source.sourcePath, 'c');
    const accidental = await publish('legacy-mistake', revised, revisedSource);
    expect(accidental.status).toBe(409);
    expect(JSON.stringify(await accidental.json())).toContain(designId);
    const alias = draft('Billing workspace refreshed', { id: 'DSN-fixture-alias' });
    const manifestMistake = await publish('manifest-mistake', alias, gitSource(alias, source.sourcePath, 'd'), { actor: 'git-designer' });
    expect(manifestMistake.status).toBe(409);
    expect(JSON.stringify(await manifestMistake.json())).toContain(designId);
    const explicit = { ...revisedSource, designId, intent: 'revise', expectedVersion: '1' };
    expect((await publish('explicit-peer', revised, explicit, { actor: 'git-designer' })).status).toBe(403);
    expect((await publish('old-explicit-peer', revised, { ...revisedSource, designId }, { actor: 'git-designer' })).status).toBe(403);
    expect((await publish('explicit-viewer', revised, explicit, { actor: 'read-designer' })).status).toBe(403);
    expect((await publish('explicit-outside', revised, explicit, { actor: 'outside' })).status).toBe(404);
    const afterRejections = await new FileProjectRevisionStore<DesignWorkspaceCommit>(directory).read(projectId, 0);
    expect(afterRejections).toHaveLength(1);
    expect((await publish('explicit-author', revised, explicit, { actor: 'rotated-designer' })).status).toBe(201);
    const replay = await publish('same-request', first, firstInput, { actor: 'rotated-designer' });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ reused: true, result: { designId, version: 1 } });
    expect((await publish('same-request', first, { ...firstInput, note: 'Changed request' })).status).toBe(409);
    expect((await (await get()).json()).designs).toEqual([expect.objectContaining({
      id: designId, versions: [expect.objectContaining({ version: 1, publisher: expect.objectContaining({ id: 'designer' }) }),
        expect.objectContaining({ version: 2, publisher: expect.objectContaining({ id: 'designer' }) })],
    })]);
  });

  it('admits exactly one first publication for a shared key across two stores and two publishers', async () => {
    const otherApi = await openApi(openWorkspace());
    const bytes = draft('Concurrent draft');
    const key = { intent: 'create', designKey: 'ledger/concurrent' };
    const firstSource = gitSource(bytes, 'design/ledger/a');
    const peerSource = gitSource(bytes, 'design/ledger/b');
    const collision = await Promise.all([
      publish('same-id', bytes, { ...firstSource, ...key }),
      publish('same-id', bytes, { ...peerSource, ...key }, { actor: 'git-designer', api: otherApi }),
    ]);
    expect(collision.map(row => row.status).sort()).toEqual([201, 409]);
    const accepted = collision.find(row => row.status === 201)!;
    const { designId } = (await accepted.json()).result;
    expect(JSON.stringify(await collision.find(row => row.status === 409)!.json())).toContain(designId);
    const entries = await new FileProjectRevisionStore<DesignWorkspaceCommit>(directory).read(projectId, 0);
    expect(entries).toHaveLength(1);
    const { designs } = await (await get('/intake', 'designer')).json();
    expect(designs).toHaveLength(1);
    expect(designs[0]).toMatchObject({ designId, designKey: key.designKey, latestVersion: 1 });
  });

  it('serializes competing revisions with the same expected version and leaves exact retries safe', async () => {
    const otherApi = await openApi(openWorkspace());
    const bytes = draft('Base version');
    const source = gitSource(bytes, 'design/fixtures/concurrent-version');
    const input = { ...source, intent: 'create', designKey: 'ledger/version-race' };
    const first = await Promise.all([publish('first-retry', bytes, input), publish('first-retry', bytes, input, { api: otherApi })]);
    expect(first.map(row => row.status).sort()).toEqual([200, 201]);
    const receipts = await Promise.all(first.map(row => row.json()));
    expect(receipts[0].result).toEqual(receipts[1].result);
    const { designId } = receipts[0].result;
    const v2a = draft('Candidate A'), v2b = draft('Candidate B');
    const revise = { designId, intent: 'revise', expectedVersion: '1' };
    const results = await Promise.all([
      publish('v2-a', v2a, { ...gitSource(v2a, source.sourcePath, 'b'), ...revise }),
      publish('v2-b', v2b, { ...gitSource(v2b, source.sourcePath, 'c'), ...revise }, { api: otherApi }),
    ]);
    expect(results.map(row => row.status).sort()).toEqual([201, 409]);
    expect(await results.find(row => row.status === 201)!.json()).toMatchObject({ result: { designId, version: 2 } });
    const commits = await new FileProjectRevisionStore<DesignWorkspaceCommit>(directory).read(projectId, 0);
    expect(commits).toHaveLength(2);
    expect(commits.map(commit => commit.design?.version?.version)).toEqual([1, 2]);
  });

  it('reuses an explicit-intent receipt when the same Git files were packaged again', async () => {
    const bytes = draft('Repacked draft');
    const repacked = withZipComment(bytes);
    expect(repacked.equals(bytes)).toBe(false);
    const input = { ...gitSource(bytes, 'design/repacked'), intent: 'create', designKey: 'ledger/repacked' };
    const requestId = 'intent-repack';
    const first = await publish(requestId, bytes, input);
    expect(first.status).toBe(201);
    const receipt = await first.json();

    const otherApi = await openApi(openWorkspace());
    const repeated = await publish(requestId, repacked, input, { api: otherApi });
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toEqual({ ...receipt, reused: true });
    const changed = await publish(requestId, draft('Different unpacked content'), input);
    expect(changed.status).toBe(409);
    expect(await changed.json()).toMatchObject({ message: expect.stringContaining('同一请求编号') });

    const commits = await new FileProjectRevisionStore<DesignWorkspaceCommit>(directory).read(projectId, 0);
    expect(commits).toHaveLength(1);
    expect(commits[0].design?.version).toMatchObject({ version: 1, sha256: createHash('sha256').update(bytes).digest('hex') });
  });

  it('keeps old explicit-ID updates compatible, binds an old draft once and permits independent modules', async () => {
    const bytes = draft('Same fixture title');
    const source = gitSource(bytes, 'design/legacy-intake');
    const first = await publish('legacy-first', bytes, source);
    expect(first.status).toBe(201);
    const { designId } = (await first.json()).result;
    expect((await publish('legacy-v2', bytes, { ...gitSource(bytes, source.sourcePath, 'b'), designId })).status).toBe(201);
    const designKey = 'legacy/module';
    const binding = { ...gitSource(bytes, source.sourcePath, 'c'), intent: 'revise', designId, designKey, expectedVersion: '2' };
    expect((await publish('bind-legacy', bytes, binding)).status).toBe(201);
    const wouldChangeKey = { ...binding, ...gitSource(bytes, source.sourcePath, 'd'), designKey: 'legacy/another', expectedVersion: '3' };
    expect((await publish('change-key', bytes, wouldChangeKey)).status).toBe(409);

    const otherSource = gitSource(bytes, 'design/new-module');
    const reserved = await publish('reserved-source', bytes, { ...source, intent: 'create', designKey: 'other/workspace' });
    expect(reserved.status).toBe(409);
    expect((await publish('separate-module', bytes, { ...otherSource, intent: 'create', designKey: 'other/workspace' })).status).toBe(201);
    const anchor = await get('/intake', 'designer');
    expect(anchor.status).toBe(200);
    expect((await anchor.json()).designs).toEqual(expect.arrayContaining([
      expect.objectContaining({ designId, designKey, latestVersion: 3, sourcePaths: [source.sourcePath] }),
      expect.objectContaining({ designKey: 'other/workspace', latestVersion: 1, sourcePaths: [otherSource.sourcePath] }),
    ]));
    const crossProject = draft('Same fixture title', { project: otherProjectId });
    const independentlyScoped = { ...gitSource(crossProject, source.sourcePath, 'a', otherProjectId), intent: 'create', designKey };
    const elsewhere = await publish('outside-independent', crossProject, independentlyScoped, { actor: 'outside', project: otherProjectId });
    expect(elsewhere.status).toBe(201);
    expect((await (await get('/intake', 'outside', otherProjectId)).json()).designs).toEqual([
      expect.objectContaining({ designKey, latestVersion: 1, canRevise: true }),
    ]);
  });

  it('prompts legacy agents to choose intent after the first project draft while permitting human first publications', async () => {
    const bytes = draft('Legacy agent draft');
    const git = gitSource(bytes, 'design/initial-legacy');
    const initial = await publish('old-request', bytes, git);
    expect(initial.status).toBe(201);
    const { designId } = (await initial.json()).result;
    const retry = await publish('old-request', bytes, git, { actor: 'rotated-designer' });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ reused: true, result: { designId, version: 1 } });
    const other = draft('Another draft with a different title and path');
    const otherGit = gitSource(other, 'design/different-legacy');
    expect((await publish('legacy-agent-other', other, otherGit)).status).toBe(409);
    expect((await publish('legacy-peer-other', other, otherGit, { actor: 'git-designer' })).status).toBe(409);
    expect(await new FileProjectRevisionStore<DesignWorkspaceCommit>(directory).read(projectId, 0)).toHaveLength(1);
    expect((await publish('legacy-human-other', other, otherGit, { actor: 'author' })).status).toBe(201);
    expect((await (await get()).json()).designs).toHaveLength(2);
    expect((await publish('legacy-human-duplicate', bytes, git, { actor: 'author' })).status).toBe(409);
  });

  it('blocks a legacy revision from first claiming a different draft’s verified path but preserves historical overlap', async () => {
    const first = draft('Owned path');
    const firstGit = gitSource(first, 'design/owned-path');
    const response = await publish('own-path', first, firstGit);
    expect(response.status).toBe(201);
    const { designId: ownerId } = (await response.json()).result;
    const other = draft('Separate draft');
    const otherGit = gitSource(other, 'design/separate-path');
    const separate = await publish('separate-path', other, otherGit, { actor: 'author' });
    expect(separate.status).toBe(201);
    const { designId } = (await separate.json()).result;
    const claimSource = gitSource(other, firstGit.sourcePath, 'b');
    const rejected = await publish('legacy-path-claim', other, { ...claimSource, designId }, { actor: 'author' });
    expect(rejected.status).toBe(409);
    expect(JSON.stringify(await rejected.json())).toContain(ownerId);

    const revisions = new FileProjectRevisionStore<DesignWorkspaceCommit>(directory);
    const entries = await revisions.read(projectId, 0);
    expect(entries).toHaveLength(2);
    const preceding = entries[1].design!.version!;
    expect(await revisions.append({ projectId, revision: 3,
      request: { key: 'fixture-historical-overlap', fingerprint: 'fixture', result: { type: 'package', designId, version: 2 } },
      design: { id: designId, version: { ...preceding, version: 2, ...claimSource } },
    })).toBe(true);
    const followup = await publish('legacy-known-path', other, { ...gitSource(other, firstGit.sourcePath, 'c'), designId }, { actor: 'author' });
    expect(followup.status).toBe(201);
    expect(await followup.json()).toMatchObject({ result: { designId, version: 3 } });
  });

  it('requires project Git source and explicit revision parameters for the intake contract', async () => {
    const bytes = draft('Validated input');
    const source = gitSource(bytes, 'design/validated-input');
    const initial = await publish('implicit-base', bytes, source);
    expect(initial.status).toBe(201);
    const { designId } = (await initial.json()).result;
    const create = { intent: 'create', designKey: 'test/another' };
    const unverified = await publish('no-git', bytes, { ...create, sourcePath: 'design/not-in-git' });
    expect([400, 409]).toContain(unverified.status);
    expect((await publish('no-key', bytes, { ...source, intent: 'create' })).status).toBe(400);
    expect((await publish('bad-key', bytes, { ...source, ...create, designKey: 'Test/NotValid' })).status).toBe(400);
    const updated = draft('Validated input revised', { id: designId });
    const complete = { ...gitSource(updated, source.sourcePath, 'b'), intent: 'revise' };
    expect((await publish('manifest-id-only', updated, { ...complete, expectedVersion: '1' })).status).toBe(400);
    expect((await publish('no-expected-version', updated, { ...complete, designId })).status).toBe(400);
    expect((await publish('non-integer-version', updated, { ...complete, designId, expectedVersion: '1.5' })).status).toBe(400);
    expect((await publish('complete-revision', updated, { ...complete, designId, expectedVersion: '1' })).status).toBe(201);
    const commits = await new FileProjectRevisionStore<DesignWorkspaceCommit>(directory).read(projectId, 0);
    expect(commits).toHaveLength(2);
  });

  it('only lets an assigned human reviewer freeze a version and inherits reviewers on publish', async () => {
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

  describe('implementation version lifecycle', () => {
    async function releaseVersion(designId: string, version: number) {
      const result = await publish(`prepare-lifecycle-v${version}`, draft(`Fixture V${version}`), {
        designId, sourceCommit: String(version).repeat(40),
      });
      expect(result.status).toBe(201);
      expect((await result.json()).result.version).toBe(version);
    }

    async function entry() {
      return (await (await get()).json()).designs[0];
    }

    it('moves the baseline directly across versions and requires a recorded reason for a historical target', async () => {
      const { designId } = (await (await publish('prepare-lifecycle-v1', draft())).json()).result;
      expect((await command('design.freeze', { designId, version: 1 })).status).toBe(201);
      await releaseVersion(designId, 2);
      await releaseVersion(designId, 3);

      expect((await command('design.freeze', { designId, version: 3, expectedBaseline: 2 })).status).toBe(409);
      expect((await entry()).frozen).toBe(1);
      expect((await command('design.freeze', { designId, version: 3, expectedBaseline: 1 })).status).toBe(201);
      expect((await entry()).implementedVersion).toBeUndefined();
      const rollback = { designId, version: 2, expectedBaseline: 3 };
      expect((await command('design.freeze', rollback)).status).toBe(409);
      const reason = 'Restore the previous release while verifying the issue';
      expect((await command('design.freeze', { ...rollback, reason }, 'designer')).status).toBe(403);
      expect((await command('design.freeze', { ...rollback, reason })).status).toBe(201);
      expect(await entry()).toMatchObject({ frozen: 2, freezes: [
        { version: 1 }, { version: 3 }, { version: 2, by: 'Fixture reviewer', at: clock, reason },
      ] });
      expect((await entry()).implementedVersion).toBeUndefined();
    });

    it('lets the pinned target sign after a revision and preserves the result across restart and replay', async () => {
      const { designId, runId } = await runWithScreenshot();
      const initial = await entry();
      expect(initial.implementedVersion).toBeUndefined();
      expect(initial.upgrade).toMatchObject({ targetVersion: 1, status: 'active' });
      await releaseVersion(designId, 2);
      expect((await entry()).frozen).toBe(1);
      expect((await command('acceptance.start', { designId, version: 2, pullRequest: 7 })).status).toBe(409);

      const signoff = { designId, runId };
      expect((await command('acceptance.sign', signoff, 'designer')).status).toBe(403);
      const sign = () => command('acceptance.sign', signoff, 'author', 'lifecycle-sign-v1');
      const concurrent = await Promise.all([sign(), sign()]);
      expect(concurrent.map(response => response.status).sort()).toEqual([200, 201]);
      const signed = concurrent.find(response => response.status === 201)!;
      const receipt = await signed.json();
      const completed = { frozen: 1, implementedVersion: 1, versionGap: { direction: 'aligned', count: 0 },
        runs: [{ id: runId, signed: { by: 'author' } }],
        upgrade: { id: initial.upgrade.id, targetVersion: 1, status: 'completed', signoffRunId: runId, completedAt: clock } };
      expect(await entry()).toMatchObject(completed);

      const restarted = await openApi(openWorkspace());
      const replay = await fetch(`${restarted}${projectId}/design/commands`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-fixture-user': 'author' },
        body: JSON.stringify({ type: 'acceptance.sign', requestId: 'lifecycle-sign-v1', ...signoff }),
      });
      expect(replay.status).toBe(200);
      expect(await replay.json()).toEqual({ ...receipt, reused: true });
      const restored = await (await fetch(`${restarted}${projectId}/design`, { headers: { 'x-fixture-user': 'author' } })).json();
      expect(restored.designs[0]).toMatchObject(completed);
      expect((await command('acceptance.sign', signoff)).status).toBe(409);
      expect(await entry()).toMatchObject(completed);
      const revisions = await new FileProjectRevisionStore<DesignWorkspaceCommit>(directory).read(projectId, 0);
      expect(revisions.filter(revision => revision.design?.run?.signed)).toHaveLength(1);
    });

    it('locks the latest version when work starts and requires cancellation before changing the target', async () => {
      const { designId } = (await (await publish('prepare-lifecycle-v1', draft())).json()).result;
      expect((await command('design.freeze', { designId, version: 1 })).status).toBe(201);
      await releaseVersion(designId, 2);
      await releaseVersion(designId, 3);

      expect((await command('implementation.start', { designId, expectedBaseline: 1 }, 'designer')).status).toBe(403);
      expect((await command('implementation.start', { designId, expectedBaseline: 2 })).status).toBe(409);
      expect((await command('implementation.start', { designId, expectedBaseline: 1 })).status).toBe(201);
      const { upgrade } = await entry();
      expect(typeof upgrade.id).toBe('string');
      expect(upgrade).toMatchObject({ targetVersion: 3, status: 'active', startedAt: clock });
      expect(upgrade.fromVersion).toBeUndefined();
      expect(await entry()).toMatchObject({ frozen: 3, freezes: [{ version: 1 }, { version: 3 }] });
      await releaseVersion(designId, 4);

      expect((await command('implementation.start', { designId })).ok).toBe(true);
      expect((await command('implementation.start', { designId, version: 4 })).status).toBe(409);
      expect((await command('design.freeze', { designId, version: 4 })).status).toBe(409);
      expect((await command('design.unfreeze', { designId, version: 3 })).status).toBe(409);
      expect(await entry()).toMatchObject({ frozen: 3, upgrade });

      const reason = 'Stop this implementation and start from the newly reviewed design';
      const cancel = { designId, upgradeId: upgrade.id, reason };
      expect((await command('implementation.cancel', cancel, 'designer')).status).toBe(403);
      expect((await command('implementation.cancel', { ...cancel, reason: '' })).status).toBe(400);
      expect((await command('implementation.cancel', cancel)).status).toBe(201);
      expect(await entry()).toMatchObject({ frozen: 3, upgrade: { ...upgrade, status: 'cancelled', reason } });
      expect((await command('implementation.start', { designId, expectedBaseline: 3 })).status).toBe(201);
      const current = await entry();
      expect(current).toMatchObject({ frozen: 4, upgrade: { status: 'active', targetVersion: 4 } });
      expect(current.upgrade.id).not.toBe(upgrade.id);
      expect((await command('implementation.cancel', cancel)).status).toBe(409);
    });

    it('derives version distance and preserves the last signed version through a failed sign and a rollback', async () => {
      const { designId, runId, record } = await runWithScreenshot();
      expect((await command('acceptance.sign', { designId, runId })).status).toBe(201);
      await releaseVersion(designId, 2);
      await releaseVersion(designId, 3);
      expect((await command('implementation.start', { designId, expectedBaseline: 1 })).status).toBe(201);
      expect(await entry()).toMatchObject({ frozen: 3, implementedVersion: 1, versionGap: { direction: 'behind', count: 2 },
        upgrade: { fromVersion: 1, targetVersion: 3, status: 'active' } });
      const intake = await (await get('/intake', 'read-designer')).json();
      expect(intake.designs[0]).toMatchObject({ latestVersion: 3, baselineVersion: 3, implementedVersion: 1,
        versionGap: { direction: 'behind', count: 2 }, upgrade: { targetVersion: 3, status: 'active' } });

      const startRun = async (version: number) => {
        const start = await command('acceptance.start', { designId, version, pullRequest: 7 });
        expect(start.status).toBe(201);
        const latest = (await start.json()).result.runId;
        expect((await command('acceptance.record', { ...record, runId: latest, commit: activeCommit })).status).toBe(201);
        return latest;
      };

      activeCommit = 'd'.repeat(40);
      const forwardRunId = await startRun(3);
      activePreviewUrl = `${previewUrl}moved/`;
      expect((await command('acceptance.sign', { designId, runId: forwardRunId })).status).toBe(409);
      expect(await entry()).toMatchObject({ implementedVersion: 1, upgrade: { status: 'active' } });
      activePreviewUrl = previewUrl;
      expect((await command('acceptance.sign', { designId, runId: forwardRunId, implementedVersion: 2 })).status).toBe(400);
      expect((await command('acceptance.sign', { designId, runId: forwardRunId })).status).toBe(201);
      expect(await entry()).toMatchObject({ implementedVersion: 3, versionGap: { direction: 'aligned', count: 0 } });

      const rollback = { designId, version: 1, expectedBaseline: 3, reason: 'Recover the signed V1 implementation' };
      expect((await command('design.freeze', rollback)).status).toBe(201);
      expect(await entry()).toMatchObject({ frozen: 1, implementedVersion: 3, versionGap: { direction: 'ahead', count: 2 } });
      activeCommit = previewCommit;
      expect((await entry()).currentSignoffRunId).toBeFalsy();
      activeCommit = 'e'.repeat(40);
      const rollbackRunId = await startRun(1);
      expect((await command('acceptance.sign', { designId, runId: rollbackRunId })).status).toBe(201);
      expect(await entry()).toMatchObject({ frozen: 1, implementedVersion: 1, versionGap: { direction: 'aligned', count: 0 },
        upgrade: { fromVersion: 3, targetVersion: 1, status: 'completed', signoffRunId: rollbackRunId },
        runs: [{ id: runId, signed: { by: 'author' } }, { id: forwardRunId, signed: { by: 'author' } }, { id: rollbackRunId, signed: { by: 'author' } }] });
    });

    it('keeps the baseline while cancellation invalidates the discarded run, even when restarting the same target', async () => {
      const { designId, runId, record } = await runWithScreenshot();
      const { upgrade } = await entry();
      expect(upgrade).toMatchObject({ targetVersion: 1, status: 'active' });
      expect((await command('implementation.cancel', { designId, upgradeId: upgrade.id, reason: 'Discard this attempt' })).status).toBe(201);
      expect(await entry()).toMatchObject({ frozen: 1, upgrade: { status: 'cancelled' } });
      expect((await command('acceptance.sign', { designId, runId })).status).toBe(409);
      expect((await command('implementation.start', { designId, version: 1 })).status).toBe(201);
      expect((await command('acceptance.sign', { designId, runId })).status).toBe(409);
      expect((await command('acceptance.record', record)).status).toBe(409);
      expect((await entry()).implementedVersion).toBeUndefined();
    });

    it('uses an existing signed run from legacy revisions without inventing an upgrade record', async () => {
      const { designId, runId } = await runWithScreenshot();
      const currentStore = new FileProjectRevisionStore<DesignWorkspaceCommit>(directory);
      const legacyDirectory = path.join(directory, 'legacy');
      const legacyStore = new FileProjectRevisionStore<DesignWorkspaceCommit>(legacyDirectory);
      const revisions = await currentStore.read(projectId, 0);
      for (const revision of revisions) {
        const oldRevision = structuredClone(revision);
        if (oldRevision.design) {
          Reflect.deleteProperty(oldRevision.design, 'upgrade');
          Reflect.deleteProperty(oldRevision.design, 'implementedVersion');
          if (oldRevision.design.run) Reflect.deleteProperty(oldRevision.design.run, 'upgradeId');
        }
        expect(await legacyStore.append(oldRevision)).toBe(true);
      }
      const { runs: [run] } = await entry();
      Reflect.deleteProperty(run, 'upgradeId');
      expect(await legacyStore.append({ projectId, revision: revisions.length + 1,
        request: { key: 'legacy-signature', fingerprint: 'legacy-run', result: { type: 'acceptance.sign', designId, runId } },
        design: { id: designId, run: { ...run, signed: { by: 'author', at: clock, verdict: 'passed' } } },
      })).toBe(true);
      const reopened = await openApi(openWorkspace(undefined, legacyDirectory));
      const restored = await (await fetch(`${reopened}${projectId}/design`, { headers: { 'x-fixture-user': 'author' } })).json();
      expect(restored.designs[0]).toMatchObject({ frozen: 1, implementedVersion: 1, versionGap: { direction: 'aligned', count: 0 },
        currentSignoffRunId: runId, runs: [{ id: runId, signed: { by: 'author', at: clock } }] });
      expect(restored.designs[0].upgrade).toBeUndefined();
    });
  });

  it('compares authored manifests in either direction and ignores transient revisions and generated differences', async () => {
    const screen = (id: string, name: string) => ({ id, name, route: `#/${id}`, viewport: 'desktop', themes: ['light'] });
    const rule = (id: string, screenId: string, expected: string) => ({ id, rule: 'Render content', how: 'human',
      slots: ['desktop-light'], screenId, expected });
    const members = screen('members', 'Members');
    const oldView = screen('old', 'Obsolete');
    const transient = screen('transient', 'Intermediate only');
    const baselineRule = rule('A-01', 'members', 'The prior layout renders');
    const obsoleteRule = rule('A-02', 'old', 'The old table renders');
    const pack = (screens: ReturnType<typeof screen>[], acceptance: ReturnType<typeof rule>[], files: Record<string, string>) =>
      draft('Version diff fixture', { screens, acceptance, source: 'src/' }, Object.entries(files)
        .map(([name, contents]) => ({ name: `bundle/${name}`, data: Buffer.from(contents) })));
    const fromFiles = { 'src/update.css': 'h1 { margin: 1rem }', 'src/old.ts': '// Removed later' };
    const toFiles = { 'src/update.css': 'h1 { margin: 2rem }', 'src/new.ts': '// Added in final draft', 'changes/v1-v3/summary.json': '{}' };
    const first = await publish('diff-v1', pack([members, oldView], [baselineRule, obsoleteRule], fromFiles));
    expect(first.status).toBe(201);
    const { designId } = (await first.json()).result;
    expect((await publish('diff-v2', pack([members, oldView, transient], [baselineRule, obsoleteRule, rule('A-03', 'transient', 'Transient')],
      { ...fromFiles, 'src/transient.ts': '// Intermediate only' }), { designId, sourceCommit: 'c'.repeat(40) })).status).toBe(201);
    const final = pack([{ ...members, name: 'Project members' }, screen('review', 'Review')],
      [{ ...baselineRule, expected: 'The current layout renders' }, rule('A-04', 'review', 'The review loads')], toFiles);
    expect((await publish('diff-v3', final, { designId, sourceCommit: 'd'.repeat(40) })).status).toBe(201);
    expect((await command('implementation.bind', { designId, version: 3, screens: [
      { screenId: 'members', path: '/implementation/', readySelector: 'h1' },
    ] })).status).toBe(201);

    const compare = (from: number, to: number, actor = 'read-designer', project = projectId) =>
      get(`/diff?${new URLSearchParams({ designId, from: String(from), to: String(to) })}`, actor, project);
    const forward = await compare(1, 3);
    expect(forward.status).toBe(200);
    const result = await forward.json();
    expect(result).toMatchObject({ fromVersion: 1, toVersion: 3, direction: 'upgrade',
      screens: { added: [{ id: 'review' }], removed: [{ id: 'old' }], changed: [
        { id: 'members', fields: ['name'], from: { name: 'Members' }, to: { name: 'Project members' } },
      ] },
      acceptance: { added: [{ id: 'A-04' }], removed: [{ id: 'A-02' }], changed: [
        { id: 'A-01', fields: ['expected'], from: { expected: 'The prior layout renders' }, to: { expected: 'The current layout renders' } },
      ] },
      sourcePaths: ['src/new.ts', 'src/old.ts', 'src/update.css'],
    });
    expect(result.files.added.map((row: { path: string }) => row.path)).toEqual(['src/new.ts']);
    expect(result.files.removed.map((row: { path: string }) => row.path)).toEqual(['src/old.ts']);
    const inverse = await (await compare(3, 1)).json();
    expect(inverse).toMatchObject({ direction: 'rollback', fromVersion: 3, toVersion: 1 });
    for (const key of ['screens', 'acceptance', 'files']) {
      expect(inverse[key].added).toEqual(result[key].removed);
      expect(inverse[key].removed).toEqual(result[key].added);
      expect(inverse[key].changed).toEqual(result[key].changed.map((row: { from: unknown; to: unknown }) => ({ ...row, from: row.to, to: row.from })));
    }
    const same = await (await compare(3, 3)).json();
    expect(same).toMatchObject({ direction: 'same', fromVersion: 3, toVersion: 3, sourcePaths: [] });
    for (const key of ['screens', 'acceptance', 'files']) expect(same[key]).toEqual({ added: [], removed: [], changed: [] });
    expect((await compare(1, 7)).status).toBe(404);
    expect((await compare(1, 3, 'outside')).status).toBe(404);
    expect((await compare(1, 3, 'author', otherProjectId)).status).toBe(404);
  });

  it('only lets publishers or stewards request review and checks the current assignment after replacement', async () => {
    const first = await publish('review-first', draft());
    expect(first.status).toBe(201);
    const { designId } = (await first.json()).result;

    expect((await command('design.freeze', { designId, version: 1 }, 'other')).status).toBe(201);
    expect((await command('design.review', { designId, reviewerIds: ['author'] }, 'designer')).status).toBe(201);
    const frozen = (await (await get()).json()).designs[0];
    expect(frozen).toMatchObject({ frozen: 1, reviewRequested: false, reviewers: [{ id: 'author' }] });
    expect(frozen.freezes).toHaveLength(1);
    expect(await service.reviewNotices(projectId, people.get('author')!)).toEqual([]);
    expect((await publish('set-on-update', draft(), { designId, sourceCommit: 'c'.repeat(40), reviewerIds: JSON.stringify(['author']) })).status).toBe(201);
    expect((await service.reviewNotices(projectId, people.get('author')!))[0]).toMatchObject({ version: 2 });
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
    const separate = await publish('different-design', draft('Separate fixture design'), { reviewerIds: JSON.stringify(['author']) }, { actor: 'steward' });
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
    expect((await publish('one', withZipComment(bytes))).status).toBe(409);
    expect((await publish('one', draft('Another title'))).status).toBe(409);
    const { designs } = await (await get()).json();
    expect(designs).toHaveLength(1);
    expect(designs[0].versions).toHaveLength(1);
    const endpoint = '/artifacts/' + designs[0].versions[0].prototypeId;
    const artifact = await get(endpoint);
    expect(await artifact.text()).toBe(html);
    expect(artifact.headers.get('cache-control')?.split(',').map(value => value.trim()))
      .toEqual(expect.arrayContaining(['private', 'no-store', 'no-transform']));
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

  describe('design feedback follow-up', () => {
    it('reverses the pinned baseline while keeping signed evidence, then freezes a revision of the same draft', async () => {
      const firstBytes = draft('Reversible fixture V1');
      const sourcePath = 'design/reversible-fixture';
      const designKey = 'fixture/reversible';
      const first = await publish('reversible-first', firstBytes, { sourceMode: 'private', intent: 'create',
        sourcePath, designKey, reviewerIds: JSON.stringify(['author']) });
      expect(first.status).toBe(201);
      const { designId } = (await first.json()).result;
      const baseline = { designId, version: 1 };
      const read = async () => (await (await get()).json()).designs[0];
      expect((await command('comment.create', { ...baseline, screenId: 'members', body: 'Keep this review note', x: 0.2, y: 0.3 })).status).toBe(201);
      expect((await command('design.freeze', baseline)).status).toBe(201);
      const started = await command('acceptance.start', { ...baseline, pullRequest: 7 });
      expect(started.status).toBe(201);
      const { runId } = (await started.json()).result;
      const capture = png(1280, 800);
      expect((await command('acceptance.record', { designId, runId, commit: previewCommit,
        cells: [{ itemId: 'A-1', slot: 'desktop-light', status: 'passed', actual: 'Verified synthetic fixture',
          image: `data:image/png;base64,${capture.toString('base64')}`,
          measured: { width: 1280, height: 800, theme: 'light', path: '/members/' } }],
      })).status).toBe(201);
      expect((await command('acceptance.sign', { designId, runId })).status).toBe(201);
      const before = await read();
      expect(before).toMatchObject({ id: designId, frozen: 1, currentSignoffRunId: runId });
      const denied = await Promise.all([
        command('design.unfreeze', baseline, 'agent-with-reviewer-id'),
        command('design.unfreeze', baseline, 'other'),
        command('design.unfreeze', baseline, 'reviewer-without-approval'),
        command('design.unfreeze', baseline, 'author', 'undo-cross-project', otherProjectId),
      ]);
      clock = '2026-11-21T09:30:00.000Z';
      const undone = await command('design.unfreeze', baseline, 'author', 'undo-v1');
      expect(undone.status).toBe(201);
      const receipt = await undone.json();
      expect(receipt).toMatchObject({ reused: false, result: { type: 'design.unfreeze', designId, version: 1 } });
      expect(denied.map(response => response.status)).toEqual([403, 403, 403, 404]);
      const unfrozen = await read();
      expect(unfrozen.frozen).toBeUndefined();
      expect(unfrozen.currentSignoffRunId).toBeFalsy();
      expect(unfrozen).toMatchObject({ reviewRequested: true, unfreezes: [{ version: 1, by: 'Fixture reviewer', at: clock }] });
      expect(unfrozen.versions).toEqual(before.versions);
      expect(unfrozen.freezes).toEqual(before.freezes);
      expect(unfrozen.comments).toEqual(before.comments);
      expect(unfrozen.runs).toEqual(before.runs);
      expect((await command('acceptance.start', { ...baseline, pullRequest: 7 })).status).toBe(409);
      const firstArchive = await get(`/artifacts/${before.versions[0].delivery.archiveId}`, 'read-designer');
      const firstCapture = await get(`/artifacts/${before.runs[0].cells[0].imageId}`, 'read-designer');
      expect(firstArchive.status).toBe(200);
      expect(Buffer.from(await firstArchive.arrayBuffer())).toEqual(firstBytes);
      expect(firstCapture.status).toBe(200);
      expect(Buffer.from(await firstCapture.arrayBuffer())).toEqual(capture);

      const secondBytes = draft('Reversible fixture V2', { id: designId });
      const revision = { sourceMode: 'private', intent: 'revise', designId, expectedVersion: '1',
        sourcePath, sourceCommit: '2'.repeat(40) };
      expect((await publish('reversible-wrong-author', secondBytes, revision, { actor: 'git-designer' })).status).toBe(403);
      const next = await publish('reversible-second', secondBytes, revision);
      expect(next.status).toBe(201);
      expect((await next.json()).result).toMatchObject({ designId, version: 2 });
      expect((await command('design.freeze', { designId, version: 2 })).status).toBe(201);
      expect((await command('design.unfreeze', baseline, 'author', 'stale-undo-v1')).status).toBe(409);
      const replay = await command('design.unfreeze', baseline, 'author', 'undo-v1');
      expect(replay.status).toBe(200);
      expect(await replay.json()).toEqual({ ...receipt, reused: true });
      const { designs } = await (await get()).json();
      expect(designs).toHaveLength(1);
      const after = designs[0];
      expect(after).toMatchObject({ id: designId, designKey, frozen: 2, reviewRequested: false });
      expect(after.versions.map((version: { version: number }) => version.version)).toEqual([1, 2]);
      expect(after.versions[0]).toEqual(before.versions[0]);
      expect(after.runs).toEqual(before.runs);
      expect(after.unfreezes).toEqual(unfrozen.unfreezes);
      expect(after.freezes).toMatchObject([...before.freezes, { version: 2, by: 'Fixture reviewer' }]);
    });

    it('extracts attached specs from the selected frozen source and applies an explicit framework revision', async () => {
      const frameworkId = 'FW-extracted-fixture';
      const sourcePath = 'design/extracted-framework';
      const firstTokens = { color: { primary: '#14578a' }, spacing: { unit: 8 } };
      const secondTokens = { color: { primary: '#4d2980' }, spacing: { unit: 8 } };
      const firstRules = '# Fixture rules\nUse the shared page heading.';
      const secondRules = '# New fixture rules\nDo not adopt this change yet.';
      const components = '# Fixture components\nReuse the shared card.';
      const skeleton = '<main><h1>Shared fixture</h1></main>';
      const withSpecs = (title: string, tokens: typeof firstTokens, rules: string, id?: string) => draft(title, { id, frameworkDraft: 'spec/' }, [
        { name: 'bundle/spec/tokens.json', data: Buffer.from(JSON.stringify(tokens)) },
        { name: 'bundle/spec/rules.md', data: Buffer.from(rules) },
        { name: 'bundle/spec/components.md', data: Buffer.from(components) },
        { name: 'bundle/spec/skeleton.html', data: Buffer.from(skeleton) },
      ]);
      const firstBytes = withSpecs('Attached framework V1', firstTokens, firstRules);
      const firstSource = gitSource(firstBytes, sourcePath, '1');
      const first = await publish('extract-source-first', firstBytes, { ...firstSource, intent: 'create', designKey: 'fixture/framework-source' });
      expect(first.status).toBe(201);
      const { designId } = (await first.json()).result;
      expect((await command('design.freeze', { designId, version: 1 })).status).toBe(201);
      const secondBytes = withSpecs('Attached framework V2', secondTokens, secondRules, designId);
      const secondSource = gitSource(secondBytes, sourcePath, '2');
      expect((await publish('extract-source-second', secondBytes, { ...secondSource, intent: 'revise', designId, expectedVersion: '1' })).status).toBe(201);

      const request = { designId, version: 1, frameworkId, expectedVersion: 0, title: 'Extracted fixture framework' };
      expect((await command('framework.extract', request, 'agent-with-reviewer-id')).status).toBe(403);
      expect((await command('framework.extract', request, 'without-approval')).status).toBe(403);
      const extracted = await command('framework.extract', request, 'author', 'extract-v1');
      expect(extracted.status).toBe(201);
      const prior = await extracted.json();
      expect(prior.result).toMatchObject({ type: 'framework.extract', frameworkId, version: 1 });
      const replay = await command('framework.extract', request, 'author', 'extract-v1');
      expect(replay.status).toBe(200);
      expect(await replay.json()).toEqual({ ...prior, reused: true });
      expect((await command('framework.extract', request, 'author', 'extract-stale-framework')).status).toBe(409);
      expect((await command('framework.extract', request, 'author', 'extract-cross-project', otherProjectId)).status).toBe(404);
      expect((await command('framework.extract', { ...request, version: 2, expectedVersion: 1 })).status).toBe(409);
      expect((await command('framework.extract', { ...request, expectedVersion: 1 })).status).toBe(409);
      const firstMaterial = { tokens: firstTokens, rules: firstRules, components, skeleton };
      const before = await (await get()).json();
      expect(before.frameworks).toHaveLength(1);
      expect(before.frameworks[0].versions).toMatchObject([{ version: 1, sourceCommit: firstSource.sourceCommit,
        from: { designId, version: 1 }, material: firstMaterial }]);
      expect(before.designs[0].versions.map((version: { sourceCommit: string }) => version.sourceCommit)).toEqual([
        firstSource.sourceCommit, secondSource.sourceCommit,
      ]);

      expect((await command('design.unfreeze', { designId, version: 2 })).status).toBe(409);
      expect((await command('design.unfreeze', { designId, version: 1 })).status).toBe(201);
      expect((await command('design.freeze', { designId, version: 2 })).status).toBe(201);
      expect((await command('framework.extract', { ...request, expectedVersion: 1 })).status).toBe(409);
      const adopted = await command('framework.extract', { designId, version: 2, frameworkId, expectedVersion: 1, keys: ['tokens'] });
      expect(adopted.status).toBe(201);
      expect((await adopted.json()).result).toMatchObject({ frameworkId, version: 2 });
      const { frameworks } = await (await get()).json();
      expect(frameworks[0].versions[0]).toEqual(before.frameworks[0].versions[0]);
      expect(frameworks[0].versions[1]).toMatchObject({ title: request.title, version: 2, sourceCommit: secondSource.sourceCommit,
        from: { designId, version: 2 }, material: { ...firstMaterial, tokens: secondTokens } });

      const consumer = { sourceMode: 'private', intent: 'create', designKey: 'fixture/framework-consumer',
        sourcePath: 'design/framework-consumer', sourceCommit: '3'.repeat(40) };
      expect((await publish('apply-missing-framework', draft('Fixture consumer', { framework: frameworkId, frameworkVersion: 3 }), consumer)).status).toBe(400);
      const applied = await publish('apply-pinned-framework', draft('Fixture consumer', { framework: frameworkId, frameworkVersion: 1 }), consumer);
      expect(applied.status).toBe(201);
      const { designId: consumerId } = (await applied.json()).result;
      const after = await (await get()).json();
      expect(after.frameworks).toEqual(frameworks);
      expect(after.designs).toHaveLength(2);
      expect(after.designs.find((entry: { id: string }) => entry.id === consumerId).versions[0]).toMatchObject({ framework: frameworkId, frameworkVersion: 1 });
      expect(after.designs.find((entry: { id: string }) => entry.id === designId).versions.every((version: { framework?: string }) => !version.framework)).toBe(true);
    });

    it('binds implementation for a fixed version without changing the archive and locks it after a run', async () => {
      const bytes = draft('Implementation binding fixture', {
        screens: [{ id: 'members', name: 'Members', route: '#members', viewport: 'desktop' }],
      });
      const published = await publish('binding-first', bytes, { sourceMode: 'private', intent: 'create',
        designKey: 'fixture/implementation', sourcePath: 'design/implementation-fixture' });
      expect(published.status).toBe(201);
      const { designId } = (await published.json()).result;
      const read = async () => (await (await get()).json()).designs[0];
      const before = (await read()).versions[0];
      expect(before.screens[0].impl).toBeNull();
      const binding = { designId, version: 1, screens: [{ screenId: 'members', path: '/expected/', readySelector: '#specific' }] };
      const denied = await Promise.all([
        command('implementation.bind', { ...binding, screens: [{ ...binding.screens[0], path: 'https://outside.fixture.test/' }] }),
        command('implementation.bind', { ...binding, version: 2 }),
        command('implementation.bind', binding, 'author', 'binding-cross-project', otherProjectId),
        command('implementation.bind', binding, 'agent-with-reviewer-id'),
      ]);
      const bound = await command('implementation.bind', binding, 'author', 'bind-v1');
      expect(bound.status).toBe(201);
      expect((await bound.json()).result).toMatchObject({ type: 'implementation.bind', designId, version: 1 });
      expect(denied.map(response => response.status)).toEqual([400, 404, 404, 403]);
      const projected = await read();
      expect(projected.versions[0]).toEqual({ ...before, screens: [{ ...before.screens[0], impl: '/expected/', readySelector: '#specific' }] });
      expect(projected.implementations[1]).toMatchObject([{ ...binding.screens[0], by: 'Fixture reviewer' }]);
      const archive = await get(`/artifacts/${before.delivery.archiveId}`, 'read-designer');
      expect(archive.status).toBe(200);
      expect(Buffer.from(await archive.arrayBuffer())).toEqual(bytes);

      expect((await command('design.freeze', { designId, version: 1 })).status).toBe(201);
      const started = await command('acceptance.start', { designId, version: 1, pullRequest: 7 });
      expect(started.status).toBe(201);
      const { runId } = (await started.json()).result;
      expect((await read()).runs[0]).toMatchObject({ id: runId, version: 1, cells: [{ itemId: 'A-1', status: 'unverified' }] });
      const changed = { ...binding, screens: [{ ...binding.screens[0], path: '/changed/' }] };
      expect((await command('implementation.bind', changed)).status).toBe(409);
      const capture = png(1280, 800);
      const record = (path: string) => command('acceptance.record', { designId, runId, commit: previewCommit,
        cells: [{ itemId: 'A-1', slot: 'desktop-light', status: 'passed', actual: 'Verified synthetic path',
          image: `data:image/png;base64,${capture.toString('base64')}`,
          measured: { width: 1280, height: 800, theme: 'light', path } }],
      });
      expect((await record('/changed/')).status).toBe(400);
      expect((await record('/expected/')).status).toBe(201);
      expect((await read()).runs[0]).toMatchObject({ cells: [{ status: 'passed', measured: { path: '/expected/' } }] });
      const final = await get(`/artifacts/${before.delivery.archiveId}`);
      expect(Buffer.from(await final.arrayBuffer())).toEqual(bytes);
    });
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


  it('keeps framework measurement unverified for shared routes without a verified entry state', async () => {
    const frameworkId = 'FW-entry-state';
    const rules = '| R-07 | 375px 手机没有横向溢出 | 自动：实测 |';
    expect((await command('framework.import', { frameworkId, title: 'Fixture shell',
      sourceCommit: 'c'.repeat(40), expectedVersion: 0, material: { rules } })).status).toBe(201);
    const baseScreen = { name: 'Shared route', route: '#shared', viewport: 'phone', themes: ['light'] };
    const bytes = draft('Fixture alternative states', { framework: frameworkId, frameworkVersion: 1, screens: [
      { ...baseScreen, id: 'cards' }, { ...baseScreen, id: 'list', entryActions: ['button[data-view="list"]'] },
    ] });
    frameworkMeasurements = ['cards', 'list'].map(screenId => ({ screenId, slot: 'phone-light', width: 375, contentWidth: 375 }));
    expect((await publish('state-unverified', bytes)).status).toBe(201);
    const { designs } = await (await get()).json();
    expect(designs[0].versions[0].frameworkCheck.items[0]).toMatchObject({
      ruleId: 'R-07', status: 'unverified', actual: expect.stringContaining('1 / 2'),
      measurements: [{ screenId: 'cards' }],
    });
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
    expect((await publish('outside-source', draft(), { sourcePath: 'design/source-not-visible', sourceCommit: 'f'.repeat(40) }, { actor: 'author' })).status).toBe(201);
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
    const repeated = await command('share.prepare', fields, 'author', 'share-request');
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toMatchObject({ reused: true, result });
    const replacement = await command('share.prepare', fields, 'author', 'replacement-share-request');
    expect(replacement.status).toBe(201);
    const { result: next } = await replacement.json();
    expect(next.id).not.toBe(result.id);
    expect((await (await get()).json()).designs[0].sharePreparations).toMatchObject([
      { id: result.id, packageSha256: fields.packageSha256 }, { id: next.id, packageSha256: fields.packageSha256 },
    ]);
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

  async function runWithScreenshot(bytes = draft()) {
    const published = await publish('version-for-signoff', bytes);
    expect(published.status).toBe(201);
    const { designId } = (await published.json()).result;
    expect((await command('design.freeze', { designId, version: 1 })).status).toBe(201);
    const started = await command('acceptance.start', { designId, version: 1, pullRequest: 7 });
    expect(started.status).toBe(201);
    const { runId } = (await started.json()).result;
    const record = { designId, runId, commit: previewCommit, cells: [{ itemId: 'A-1', slot: 'desktop-light', status: 'passed', actual: 'Verified fixture',
      image: `data:image/png;base64,${png(1280, 800).toString('base64')}`, measured: { width: 1280, height: 800, theme: 'light', path: '/members/' } }] };
    expect((await command('acceptance.record', record)).status).toBe(201);
    return { designId, runId, record };
  }

  const dataUrl = (bytes: Buffer) => `data:image/png;base64,${bytes.toString('base64')}`;
  const passed = (evidence: string) => ({ status: 'passed', evidence });
  const checks = {
    'V-01': passed('页头居顶，标签紧跟页头，主体是成员列表，浮层关闭，底部显示分页。'),
    'V-02': passed('同排两个按钮 y=212 px，高 28 px，顶边与底边误差 0 px。'),
    'V-03': passed('抽屉关闭，与工具栏重叠面积 0 px；成员名称完整显示。'),
    'V-04': passed('文档宽度 1280 px，横向多出 0 px，只有列表主内容滚动。'),
    'V-05': passed('列表标题、账号列和分页可见文本未出现原始 Markdown、JSON 或凭据。'),
    'V-06': passed('待评审徽标和成员列表都显示 6 条，两处入口都叫全文。'),
    'V-07': passed('深色列表正文与背景测得对比 5.2，缩略图未被深色覆盖。'),
    'V-08': passed('375 px 手机、Windows 125% 和 150% 实拍均显示成员标题和分页。'),
    'V-09': passed('单独的加载行显示骨架，成员清单行加载完成，空态行显示查找入口。'),
    'V-10': passed('输入 61 条成员记录及 80 字符长标题，列表仍分页且无横向滚动。'),
  };

  describe('逐画面视觉验收', () => {
    const desktopPng = png(1280, 800);
    const phonePng = png(375, 812);
    const bytes = (mobileBound = true) => draft('Visual acceptance fixture', {
      screens: [
        { id: 'members', name: 'Members', route: '#members', viewport: 'desktop', themes: ['light'], impl: '/members/', readySelector: 'h1' },
        { id: 'members-mobile', name: 'Mobile members', route: '#members-mobile', viewport: 'phone', themes: ['dark'],
          ...(mobileBound ? { impl: '/members/', readySelector: 'h1' } : {}) },
      ],
      acceptance: [{ id: 'A-1', screenId: 'members', rule: 'Members load', how: 'human', slots: ['desktop-light'] }],
    }, [
      { name: 'bundle/设计文档/视觉验收标准.md', data: Buffer.from('# 逐画面视觉验收标准\n') },
      { name: 'bundle/screens/members.light.png', data: desktopPng },
    ]);

    it('blocks signoff when visual proof is still missing despite passing the authored rules', async () => {
      const { designId, runId } = await runWithScreenshot(bytes());
      expect((await command('acceptance.sign', { designId, runId })).status).toBe(409);
      const { designs } = await (await get()).json();
      expect(designs[0].runs[0]).toMatchObject({ verdict: 'needs_evidence', cells: [{ status: 'passed' }] });
      expect(designs[0].runs[0].signed).toBeUndefined();
    });

    it('enables unfinished visual runs to bind missing screens while locking existing locations', async () => {
      const { designId, runId } = await runWithScreenshot(bytes(false));
      const visual = { designId, runId, commit: previewCommit, screenId: 'members-mobile', slot: 'phone-dark', checks: {},
        image: dataUrl(phonePng), measured: { width: 375, height: 812, theme: 'dark', path: '/members-mobile/' } };
      const bind = (screenId: string, path: string) => command('implementation.bind', { designId, version: 1,
        screens: [{ screenId, path, readySelector: 'h1' }] });
      expect((await command('acceptance.visual', visual)).status).toBe(409);
      expect((await bind('members-mobile', '/members-mobile/')).status).toBe(201);
      expect((await bind('members', '/changed/')).status).toBe(409);
      expect((await command('acceptance.visual', visual)).status).toBe(201);
      const { designs } = await (await get()).json();
      expect(designs[0].versions[0].screens).toMatchObject([{ impl: '/members/' }, { impl: '/members-mobile/' }]);
      expect(designs[0].runs[0]).toMatchObject({ id: runId, commit: previewCommit, cells: [{ status: 'passed' }], visual: {
        'members-mobile/phone-dark': { imageId: expect.any(String), measured: visual.measured },
      } });
    });

    it('pins an existing authored-rule screenshot only when its screen, theme, path and size match', async () => {
      const { designId, runId, record: authored } = await runWithScreenshot(bytes());
      const visual = { designId, runId, commit: previewCommit, screenId: 'members', slot: 'desktop-light', checks };
      const otherSize = { ...authored.cells[0], image: dataUrl(png(1200, 800)), measured: { ...authored.cells[0].measured, width: 1200 } };
      expect((await command('acceptance.record', { ...authored, cells: [{ ...otherSize, measured: { ...otherSize.measured, path: '/another/' } }] })).status).toBe(400);
      expect((await command('acceptance.record', { ...authored, cells: [otherSize] })).status).toBe(201);
      expect((await command('acceptance.visual', visual)).status).toBe(201);
      const read = async () => (await (await get()).json()).designs[0].runs[0];
      expect((await read()).visual['members/desktop-light'].imageId).toBeUndefined();

      expect((await command('acceptance.record', authored)).status).toBe(201);
      expect((await command('acceptance.visual', visual)).status).toBe(201);
      const picked = await read();
      expect(picked.visual['members/desktop-light']).toMatchObject({ imageId: picked.cells[0].imageId, measured: picked.cells[0].measured });
      expect((await command('acceptance.record', { ...authored, cells: [otherSize] })).status).toBe(201);
      expect((await read()).visual['members/desktop-light'].imageId).toBe(picked.cells[0].imageId);
    });

    it('records private visual evidence by screen and slot and signs only after all applicable rows pass', async () => {
      const { designId, runId, record: authored } = await runWithScreenshot(bytes());
      const common = { designId, runId, commit: previewCommit };
      const desktop = { ...common, screenId: 'members', slot: 'desktop-light', checks,
        image: dataUrl(desktopPng), measured: { width: 1280, height: 800, theme: 'light', path: '/members/' } };
      const record = (input: object, actor = 'designer', requestId?: string, project?: string) =>
        command('acceptance.visual', input, actor, requestId, project);
      const sign = () => command('acceptance.sign', { designId, runId });
      const read = async () => (await (await get()).json()).designs[0];
      const partial = { ...desktop, checks: { 'V-01': checks['V-01'] } };
      expect((await record(partial, 'designer', 'visual-desktop')).status).toBe(201);
      expect((await record(partial, 'designer', 'visual-desktop')).status).toBe(200);
      expect((await record(desktop, 'designer', 'visual-desktop')).status).toBe(409);
      expect((await sign()).status).toBe(409);
      expect((await record(desktop, 'read-designer')).status).toBe(403);
      expect((await record(desktop, 'git-designer')).status).toBe(403);
      expect((await (await get('', 'git-designer')).json()).permissions).toMatchObject({ write: true, visual: false });
      expect((await record(desktop, 'anonymous')).status).toBe(404);
      expect((await record(desktop, 'author', 'cross-project-visual', otherProjectId)).status).toBe(404);
      for (const invalid of [
        { ...desktop, slot: 'desktop-dark' },
        { ...desktop, referenceImage: dataUrl(desktopPng) },
        { ...desktop, image: dataUrl(phonePng) },
        { ...desktop, measured: undefined },
        { ...desktop, measured: { ...desktop.measured, path: '/another/' } },
        { ...desktop, measured: { ...desktop.measured, theme: 'dark' } },
        { ...desktop, checks: [] },
        { ...desktop, checks: { 'V-11': passed('不存在的视觉检查。') } },
        { ...desktop, checks: { 'V-01': passed('只比对了页头和主体。') } },
        { ...desktop, checks: { 'V-02': passed('看起来一致') } },
      ]) expect((await record(invalid)).status).toBe(400);

      const mobileChecks = { ...checks, 'V-04': passed('文档宽度 375 px，与视口相等，只有列表主内容滚动。') };
      const mobile = { ...common, screenId: 'members-mobile', slot: 'phone-dark', checks: mobileChecks,
        image: dataUrl(phonePng), measured: { width: 375, height: 812, theme: 'dark', path: '/members/' } };
      expect((await record(desktop)).status).toBe(201);
      expect((await record(mobile)).status).toBe(201);
      expect((await sign()).status).toBe(409);
      expect((await record({ ...mobile, checks: {}, referenceImage: dataUrl(phonePng), image: undefined, measured: undefined })).status).toBe(201);
      expect((await sign()).status).toBe(409);
      expect((await record(mobile)).status).toBe(201);
      const failed = { status: 'failed', evidence: '成员行工具按钮 y=212 px，邀请成员 y=208 px，差 4 px。' };
      expect((await record({ ...desktop, checks: { ...checks, 'V-02': failed } })).status).toBe(201);
      expect((await read()).runs[0]).toMatchObject({ verdict: 'failed' });
      expect((await sign()).status).toBe(409);
      expect((await record(desktop)).status).toBe(201);

      const beforeNewImage = (await read()).runs[0].visual['members/desktop-light'];
      const replacementPng = png(1280, 800, Buffer.alloc((1280 * 3 + 1) * 800, 1));
      expect((await record({ ...desktop, image: dataUrl(replacementPng), checks: {} })).status).toBe(201);
      const replaced = (await read()).runs[0];
      expect(replaced.verdict).toBe('needs_evidence');
      expect(replaced.visual['members/desktop-light'].imageId).not.toBe(beforeNewImage.imageId);
      expect(replaced.visual['members/desktop-light'].checks).toEqual({});
      expect((await sign()).status).toBe(409);
      expect((await record({ ...desktop, image: undefined, measured: undefined })).status).toBe(201);

      const failedRule = { ...authored, cells: [{ ...authored.cells[0], status: 'failed', actual: '成员列表内容未加载完成。' }] };
      expect((await command('acceptance.record', failedRule)).status).toBe(201);
      expect((await read()).runs[0]).toMatchObject({ verdict: 'failed', visual: { 'members/desktop-light': { checks } } });
      expect((await sign()).status).toBe(409);
      expect((await command('acceptance.record', authored)).status).toBe(201);

      const run = (await read()).runs[0];
      expect(run).toMatchObject({ verdict: 'passed', visual: {
        'members/desktop-light': { imageId: replaced.visual['members/desktop-light'].imageId, by: 'Fixture designer', at: clock, checks },
        'members-mobile/phone-dark': { imageId: expect.any(String), referenceImageId: expect.any(String), checks: mobileChecks },
      } });
      const proof = run.visual['members-mobile/phone-dark'];
      for (const id of [proof.referenceImageId, proof.imageId]) {
        const response = await get(`/artifacts/${id}`);
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe('image/png');
        expect(Buffer.from(await response.arrayBuffer())).toEqual(phonePng);
        expect((await get(`/artifacts/${id}`, 'anonymous')).status).toBe(404);
        expect((await get(`/artifacts/${id}`, 'author', otherProjectId)).status).toBe(404);
      }
      expect((await sign()).status).toBe(201);
      expect((await record(desktop)).status).toBe(409);
      expect((await read()).runs[0]).toMatchObject({ signed: { verdict: 'passed' }, visual: run.visual });
    });

    it('rejects recording against a superseded preview, PR or run', async () => {
      const { designId, runId } = await runWithScreenshot(bytes());
      const fields = { designId, runId, commit: previewCommit, screenId: 'members', slot: 'desktop-light', checks,
        image: dataUrl(desktopPng), measured: { width: 1280, height: 800, theme: 'light', path: '/members/' } };
      expect((await command('acceptance.visual', { ...fields, commit: 'd'.repeat(40) })).status).toBe(409);
      activeCommit = 'd'.repeat(40);
      expect((await command('acceptance.visual', fields)).status).toBe(409);
      activeCommit = previewCommit;
      expect((await command('design.link', { designId, pullRequest: 8 })).status).toBe(201);
      expect((await command('acceptance.visual', fields)).status).toBe(409);
      expect((await command('acceptance.start', { designId, version: 1, pullRequest: 7 })).status).toBe(201);
      expect((await command('acceptance.visual', fields)).status).toBe(409);
    });
  });

  describe('V11 验收手段', () => {
    const plan = {
      mece: { applicable: false, reason: '隔离夹具只核对流程和冒烟回填。' },
      compare: { applicable: false, reason: '该夹具没有外观改动。' },
      visual: { applicable: false, reason: '没有新增或改动画面。' },
      human: { applicable: false, reason: '已有自动断言覆盖。' },
    };
    const rule = { id: 'A-1', screenId: 'members', rule: '成员列表能够打开', how: 'measure',
      slots: ['desktop-light'], dimension: 'correctness' };
    const standard = { name: 'bundle/设计文档/验收手段.md', data: Buffer.from('# 验收手段\n\n逐项验证。\n') };
    const visualStandard = { name: 'bundle/设计文档/视觉验收标准.md', data: Buffer.from('# 逐画面视觉验收标准\n') };
    const flow = { id: 'member-list', title: '管理员打开成员清单', dimension: 'correctness', role: '管理员', steps: [
      { action: '进入成员管理入口', expected: '显示成员清单', actual: '成员清单显示 3 条记录', status: 'passed' },
      { action: '点开在用记录', expected: '打开成员详情', actual: '已打开当前成员详情', status: 'passed' },
    ] };
    const smoke = { id: 'members-api', title: '成员清单接口', dimension: 'operations', target: 'api', path: '/api/members',
      expected: '请求返回 200 和成员数组', actual: 'HTTP 200，返回 3 条成员记录', status: 'passed' };
    const planned = () => draft('验收手段夹具', { acceptancePlan: plan, acceptance: [rule] }, [visualStandard]);

    it('validates the method plan, exceptions and rule dimension before publishing', async () => {
      const invalidPackages = [
        { acceptancePlan: [] },
        { acceptancePlan: { unknown: { applicable: true } } },
        { acceptancePlan: { flow: { applicable: 'false', reason: '类型必须是布尔值。' } } },
        { acceptancePlan: { smoke: { applicable: false } } },
        { acceptancePlan: { human: { applicable: false, reason: '   ' } } },
        { acceptance: [{ ...rule, dimension: 'not-a-dimension' }] },
      ];
      for (const [index, fields] of invalidPackages.entries()) {
        expect((await publish(`bad-v11-plan-${index}`, draft('应拒绝的验收计划', fields))).status).toBe(400);
      }
      const response = await publish('valid-v11-plan', planned());
      expect(response.status).toBe(201);
      const { designs } = await (await get()).json();
      expect(designs[0].versions[0]).toMatchObject({ acceptancePlan: plan, acceptance: [rule] });
    });

    it('defaults methods to applicable for V11 packages with only the private acceptance document', async () => {
      const { designId, runId } = await runWithScreenshot(draft('标准携带夹具', { acceptance: [rule] }, [standard]));
      expect((await command('acceptance.sign', { designId, runId })).status).toBe(409);
      const { designs } = await (await get()).json();
      expect(designs[0].runs[0]).toMatchObject({ verdict: 'needs_evidence', cells: [{ status: 'passed' }] });
      const material = designs[0].versions[0].delivery.files.find((file: { path: string }) => file.path === '设计文档/验收手段.md');
      expect(material).toBeDefined();
      const path = `/artifacts/${material.id}?view=text`;
      expect((await (await get(path)).json()).text).toBe(standard.data.toString('utf8'));
      expect((await get(path, 'anonymous')).status).toBe(404);
      expect((await get(path, 'author', otherProjectId)).status).toBe(404);
    });

    it('updates flow and smoke results by id, and signs only when every applicable method passes', async () => {
      const { designId, runId, record: authored } = await runWithScreenshot(planned());
      const context = { designId, runId, commit: previewCommit };
      const failedStep = { ...flow.steps[1], actual: '点击后详情没有打开', status: 'failed' };
      const failedFlow = { ...flow, steps: [flow.steps[0], failedStep] };
      const sign = () => command('acceptance.sign', { designId, runId });
      const read = async () => (await (await get()).json()).designs[0].runs[0];
      expect((await command('acceptance.flow', { ...context, flow: failedFlow }, 'designer', 'v11-flow-first')).status).toBe(201);
      expect((await command('acceptance.flow', { ...context, flow: failedFlow }, 'designer', 'v11-flow-first')).status).toBe(200);
      expect((await command('acceptance.flow', { ...context, flow }, 'designer', 'v11-flow-first')).status).toBe(409);
      expect((await read()).flows).toEqual([expect.objectContaining({ ...failedFlow, status: 'failed', by: 'Fixture designer', at: clock })]);
      expect((await sign()).status).toBe(409);

      expect((await command('acceptance.flow', { ...context, flow }, 'designer')).status).toBe(201);
      expect((await read()).flows).toEqual([expect.objectContaining({ ...flow, status: 'passed' })]);
      expect((await sign()).status).toBe(409);
      const brokenSmoke = { ...smoke, actual: 'HTTP 503，成员列表接口暂不可用', status: 'failed' };
      expect((await command('acceptance.smoke', { ...context, smoke: brokenSmoke }, 'designer')).status).toBe(201);
      expect((await sign()).status).toBe(409);
      expect((await command('acceptance.smoke', { ...context, smoke }, 'designer', 'v11-smoke')).status).toBe(201);
      expect((await command('acceptance.smoke', { ...context, smoke }, 'designer', 'v11-smoke')).status).toBe(200);
      expect((await read()).smoke).toEqual([expect.objectContaining({ ...smoke, by: 'Fixture designer', at: clock })]);
      expect((await command('acceptance.record', { ...authored, cells: [{ ...authored.cells[0], status: 'failed', actual: '成员列表打开后仍报错。' }] })).status).toBe(201);
      expect((await sign()).status).toBe(409);
      expect((await command('acceptance.record', authored)).status).toBe(201);
      expect((await read()).visual).toBeUndefined();
      expect((await sign()).status).toBe(201);
      expect((await read()).signed).toMatchObject({ verdict: 'passed' });
      expect((await command('acceptance.flow', { ...context, flow })).status).toBe(409);
      expect((await command('acceptance.smoke', { ...context, smoke })).status).toBe(409);
    });

    it('requires a human reviewer and a real screenshot for the applicable manual method', async () => {
      const acceptancePlan = { ...plan, human: { applicable: true }, flow: plan.mece, smoke: plan.mece };
      const response = await publish('v11-human-review', draft('人工方法夹具', { acceptancePlan, acceptance: [{ ...rule, how: 'human' }] }));
      expect(response.status).toBe(201);
      const { result: { designId } } = await response.json();
      expect((await command('design.freeze', { designId, version: 1 })).status).toBe(201);
      const started = await command('acceptance.start', { designId, version: 1, pullRequest: 7 });
      expect(started.status).toBe(201);
      const { result: { runId } } = await started.json();
      const sign = () => command('acceptance.sign', { designId, runId });
      const cell = { itemId: 'A-1', slot: 'desktop-light', status: 'passed', actual: '逐个点开 3 个成员详情，信息与列表一致。' };
      const evidence = { ...cell, image: `data:image/png;base64,${png(1280, 800).toString('base64')}`,
        measured: { width: 1280, height: 800, theme: 'light', path: '/members/' } };
      expect((await sign()).status).toBe(409);
      expect((await command('acceptance.record', { designId, runId, commit: previewCommit, cells: [evidence] }, 'designer')).status).toBe(403);
      expect((await command('acceptance.record', { designId, runId, commit: previewCommit, cells: [cell] })).status).toBe(400);
      expect((await sign()).status).toBe(409);
      expect((await command('acceptance.record', { designId, runId, commit: previewCommit, cells: [evidence] })).status).toBe(201);
      expect((await sign()).status).toBe(201);
    });

    it('requires both images and a recorded comparison without forcing inapplicable visual checks', async () => {
      const acceptancePlan = { ...plan, compare: { applicable: true }, flow: plan.mece, smoke: plan.mece };
      const { designId, runId } = await runWithScreenshot(draft('对照图方法夹具', { acceptancePlan, acceptance: [rule],
        screens: [{ id: 'members', name: 'Members', route: '#members', viewport: 'desktop', themes: ['light'], impl: '/members/' }],
      }, [visualStandard]));
      const sign = () => command('acceptance.sign', { designId, runId });
      const context = { designId, runId, commit: previewCommit, screenId: 'members', slot: 'desktop-light' };
      const failed = { status: 'failed', evidence: '页头和标签位置一致，主体往下偏了 40 px，浮层关闭，底部已移出画面。' };
      const passed = { status: 'passed', evidence: '页头居顶，标签跟随页头，两图主体对齐，浮层关闭，底部都显示分页。' };
      const recordComparison = (check: object) => command('acceptance.visual', { ...context, checks: { 'V-01': check } });
      expect((await recordComparison(passed)).status).toBe(201);
      expect((await sign()).status).toBe(409);
      const referenceImage = `data:image/png;base64,${png(1280, 800).toString('base64')}`;
      expect((await command('acceptance.visual', { ...context, checks: {}, referenceImage })).status).toBe(201);
      const { designs } = await (await get()).json();
      expect(designs[0].runs[0].visual['members/desktop-light']).toMatchObject({ referenceImageId: expect.any(String),
        imageId: expect.any(String), checks: {} });
      expect((await sign()).status).toBe(409);
      expect((await recordComparison(failed)).status).toBe(201);
      expect((await sign()).status).toBe(409);
      expect((await recordComparison(passed)).status).toBe(201);
      expect((await sign()).status).toBe(201);
    });

    it('allows visual-only acceptance with all checks and a matching implementation capture, without a reference image', async () => {
      const acceptancePlan = { ...plan, visual: { applicable: true }, flow: plan.mece, smoke: plan.mece };
      const { designId, runId, record: authored } = await runWithScreenshot(draft('只做视觉验收夹具', { acceptancePlan, acceptance: [rule],
        screens: [{ id: 'members', name: 'Members', route: '#members', viewport: 'desktop', themes: ['light'], impl: '/members/' }],
      }, [visualStandard]));
      const sign = () => command('acceptance.sign', { designId, runId });
      const [cell] = authored.cells;
      const otherSize = { ...cell, image: dataUrl(png(1200, 800)), measured: { ...cell.measured, width: 1200 } };
      expect((await command('acceptance.record', { ...authored, cells: [otherSize] })).status).toBe(201);
      const visual = { designId, runId, commit: previewCommit, screenId: 'members', slot: 'desktop-light', checks };
      expect((await command('acceptance.visual', visual)).status).toBe(201);
      expect((await sign()).status).toBe(409);
      expect((await command('acceptance.visual', { ...visual, image: cell.image, measured: cell.measured })).status).toBe(201);
      expect((await sign()).status).toBe(201);
    });

    it('does not pair an older comparison with an implementation image that arrives later', async () => {
      const acceptancePlan = { ...plan, compare: { applicable: true }, flow: plan.mece, smoke: plan.mece };
      const { designId, runId, record: authored } = await runWithScreenshot(draft('对照时序夹具', { acceptancePlan, acceptance: [rule],
        screens: [{ id: 'members', name: 'Members', route: '#members', viewport: 'desktop', themes: ['light'], impl: '/members/' }],
      }, [{ name: 'bundle/screens/members.light.png', data: png(1280, 800) }]));
      const sign = () => command('acceptance.sign', { designId, runId });
      expect((await command('acceptance.record', { ...authored, cells: [{ itemId: 'A-1', slot: 'desktop-light',
        status: 'missing', actual: '实拍需要替换。' }] })).status).toBe(201);
      const context = { designId, runId, commit: previewCommit, screenId: 'members', slot: 'desktop-light' };
      const evidence = { 'V-01': { status: 'passed', evidence: '页头和标签都在顶部，主体居中，浮层关闭，底部显示分页。' } };
      expect((await command('acceptance.visual', { ...context, checks: evidence })).status).toBe(201);
      expect((await sign()).status).toBe(409);
      expect((await command('acceptance.record', authored)).status).toBe(201);
      expect((await sign()).status).toBe(409);
      expect((await command('acceptance.visual', { ...context, checks: { 'V-02': { status: 'passed', evidence: '两图按钮顶边都是 86 px。' } } })).status).toBe(201);
      expect((await sign()).status).toBe(409);
      expect((await command('acceptance.visual', { ...context, checks: evidence })).status).toBe(201);
      expect((await sign()).status).toBe(201);
    });

    it('permits conditional V11 signoff only after the normal-priority finding becomes formal project debt', async () => {
      const planning = new EngineeringPlanningService(new FileEngineeringPlanningStore(path.join(directory, 'project-debt')), () => new Date(clock));
      base = await openApi(openWorkspace(planning));
      const { designId, runId, record: authored } = await runWithScreenshot(planned());
      const context = { designId, runId, commit: previewCommit };
      const sign = () => command('acceptance.sign', { designId, runId });
      const read = async () => (await (await get()).json()).designs[0].runs[0];
      const failed = { ...authored.cells[0], status: 'failed', actual: '成员清单能打开，但列表尾部提示缺少翻页。' };
      expect((await command('acceptance.record', { ...authored, cells: [failed] })).status).toBe(201);
      expect((await command('acceptance.flow', { ...context, flow }, 'designer')).status).toBe(201);
      expect((await command('acceptance.smoke', { ...context, smoke }, 'designer')).status).toBe(201);
      expect((await command('acceptance.record', { ...authored, cells: [{ ...failed, debtId: 'made-up-debt' }] })).status).toBe(400);
      expect((await sign()).status).toBe(409);

      const issue = { designId, runId, itemId: failed.itemId };
      expect((await command('acceptance.debt', issue, 'designer')).status).toBe(201);
      const pending = (await read()).issues[failed.itemId];
      expect(pending).toMatchObject({ pending: true });
      expect((await planning.debts(projectId)).items).toEqual([]);
      expect((await sign()).status).toBe(409);

      const { result } = await planning.command(projectId, people.get('author')!, { type: 'proposal.accept', as: 'new',
        requestId: 'fixture-confirm-v11-debt', proposalId: pending.id });
      const { result: { id: debtId } } = result as { result: { id: string } };
      expect((await planning.debt(projectId, debtId)).debt).toMatchObject({ id: debtId, source: { type: 'test', ref: `${designId}/${runId}/${failed.itemId}` } });
      expect((await command('acceptance.debt', issue, 'designer')).status).toBe(201);
      expect((await read()).issues[failed.itemId]).toEqual({ id: debtId, pending: false });
      expect((await sign()).status).toBe(201);
      expect((await read()).signed).toMatchObject({ verdict: 'conditional' });
    });

    it('rejects invalid evidence and writes outside the current project and preview run', async () => {
      const { designId, runId } = await runWithScreenshot(planned());
      const context = { designId, runId, commit: previewCommit };
      for (const actor of ['reading-member', 'read-designer', 'git-designer']) {
        expect((await command('acceptance.flow', { ...context, flow }, actor)).status).toBe(403);
        expect((await command('acceptance.smoke', { ...context, smoke }, actor)).status).toBe(403);
      }
      expect((await command('acceptance.smoke', { ...context, smoke }, 'anonymous')).status).toBe(404);
      expect((await command('acceptance.flow', { ...context, flow }, 'author', 'cross-project-flow', otherProjectId)).status).toBe(404);
      for (const invalidFlow of [{ ...flow, dimension: 'unknown' }, { ...flow, steps: [] }, { ...flow, status: 'passed' },
        { ...flow, steps: [{ ...flow.steps[0], actual: ' ' }] }, { ...flow, steps: [{ ...flow.steps[0], status: 'unknown' }] }]) {
        expect((await command('acceptance.flow', { ...context, flow: invalidFlow })).status).toBe(400);
      }
      for (const invalidSmoke of [{ ...smoke, path: 'https://outside.fixture.test/api' },
        { ...smoke, target: 'unknown' }, { ...smoke, status: 'unknown' }, { ...smoke, by: 'other' }]) {
        expect((await command('acceptance.smoke', { ...context, smoke: invalidSmoke })).status).toBe(400);
      }
      expect((await command('acceptance.flow', { ...context, flow, commit: 'd'.repeat(40) })).status).toBe(409);
      activeCommit = 'd'.repeat(40);
      expect((await command('acceptance.smoke', { ...context, smoke })).status).toBe(409);
      activeCommit = previewCommit;
      activePreviewUrl = `${previewUrl}moved/`;
      expect((await command('acceptance.flow', { ...context, flow })).status).toBe(409);
      activePreviewUrl = previewUrl;
      expect((await command('design.link', { designId, pullRequest: 8 })).status).toBe(201);
      expect((await command('acceptance.flow', { ...context, flow })).status).toBe(409);
      expect((await command('acceptance.start', { designId, version: 1, pullRequest: 7 })).status).toBe(201);
      expect((await command('acceptance.smoke', { ...context, smoke })).status).toBe(409);
    });
  });

  describe('V17 客观验收门禁', () => {
    const notApplicable = { applicable: false, reason: '隔离夹具只覆盖验收方法的回填和签收。' };

    it('accepts default coverage and requires opt-in before a flow can affect signoff', async () => {
      const bytes = draft('客观验收夹具', { acceptanceMode: 'objective',
        acceptancePlan: { compare: notApplicable, visual: notApplicable, human: { applicable: true } },
        risks: ['compatibility', 'performance', 'security', 'operations', 'experience'].map(dimension => ({
          dimension, risk: '这个夹具只检查数据能否打开。', ruleIds: [], reason: '单一合成流程不覆盖该维度。',
        })) });
      const { designId, runId } = await runWithScreenshot(bytes);
      const read = async () => (await (await get()).json()).designs[0];
      const run = { designId, runId, commit: previewCommit };
      const flow = { id: 'open-members', title: '打开成员清单', dimension: 'correctness', role: '评审成员',
        steps: [{ action: '打开成员清单', expected: '出现成员区', actual: '成员区已显示', status: 'passed' }] };
      const enable = { designId, version: 1, method: 'flow' };
      expect((await command('acceptance.flow', { ...run, flow }, 'designer')).status).toBe(409);
      expect((await command('acceptance.enable', enable, 'designer')).status).toBe(403);
      expect((await command('acceptance.coverage', { ...run, dimension: 'correctness', risk: '成员清单不能打开', ruleIds: ['A-1'] }, 'designer')).status).toBe(201);
      expect((await read()).runs[0]).toMatchObject({ verdict: 'passed', coverage: { correctness: { ruleIds: ['A-1'] } } });
      expect((await command('acceptance.enable', enable)).status).toBe(201);
      expect(await read()).toMatchObject({ enabledMethods: { 1: ['flow'] }, runs: [{ verdict: 'needs_evidence' }] });
      const missingFlow = await command('acceptance.sign', { designId, runId });
      expect(missingFlow.status).toBe(409);
      expect((await missingFlow.json()).message).toContain('流程');
      expect((await command('acceptance.flow', { ...run, flow }, 'designer')).status).toBe(201);
      expect((await command('acceptance.sign', { designId, runId })).status).toBe(201);
      expect(await read()).toMatchObject({ implementedVersion: 1, runs: [{ flows: [{ id: 'open-members', status: 'passed' }], signed: { verdict: 'passed' } }] });
    });

    it('makes a recorded recurring issue mandatory and blocks unrelated or outdated evidence', async () => {
      const bytes = draft('历史易错夹具', { acceptanceMode: 'objective', acceptancePlan: {
        mece: notApplicable, compare: notApplicable, visual: notApplicable, regress: notApplicable, human: { applicable: true },
      } });
      const { designId, runId } = await runWithScreenshot(bytes);
      const read = async () => (await (await get()).json()).designs[0];
      expect((await read()).runs[0].verdict).toBe('passed');
      const report = { designId, problem: '成员标签切换后被遮挡', sources: [{ kind: 'defect', ref: 'DEF-123', count: 2 }],
        how: '逐次切换标签', check: '确认标签保留可点击区域', screenIds: ['members'] };
      const known = await command('known.create', report, 'designer');
      expect(known.status).toBe(201);
      const { id: issueId } = (await known.json()).result;
      const { id: duplicateId } = (await (await command('known.create', { ...report, sources: [{ kind: 'defect', ref: 'DEF-123', count: 1 }] }, 'designer')).json()).result;
      expect(duplicateId).toBe(issueId);
      expect(await read()).toMatchObject({ knownIssues: [{ id: issueId, sources: [{ ref: 'DEF-123', count: 2 }] }],
        runs: [{ verdict: 'needs_evidence' }] });
      const sign = () => command('acceptance.sign', { designId, runId });
      const missing = await sign();
      expect(missing.status).toBe(409);
      expect((await missing.json()).message).toContain('历史易错');
      const regression = { designId, runId, issueId, commit: previewCommit, status: 'passed', evidence: '复查三次，标签均能点击且完全可见。' };
      expect((await command('acceptance.regress', { ...regression, issueId: 'K-missing' }, 'designer')).status).toBe(404);
      expect((await command('acceptance.regress', { ...regression, commit: 'c'.repeat(40) }, 'designer')).status).toBe(409);
      expect((await command('acceptance.regress', regression, 'read-designer')).status).toBe(403);
      expect((await command('acceptance.regress', { ...regression, status: 'failed', evidence: '第一次切换即被遮挡。' }, 'designer')).status).toBe(201);
      expect((await read()).runs[0]).toMatchObject({ verdict: 'failed', regress: { [issueId]: { status: 'failed' } } });
      expect((await sign()).status).toBe(409);
      expect((await read()).implementedVersion).toBeUndefined();
      expect((await command('acceptance.regress', regression, 'designer')).status).toBe(201);
      expect((await sign()).status).toBe(201);
      expect(await read()).toMatchObject({ implementedVersion: 1, knownIssues: [{ id: issueId }],
        runs: [{ regress: { [issueId]: { status: 'passed', evidence: regression.evidence } }, signed: { verdict: 'passed' } }] });
    });
  });

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

  it('signs the verified installed build without a PR and rejects evidence from another build or URL', async () => {
    const commit = installedCommit;
    const url = installedUrl;
    const installed = await get('/installed', 'read-designer');
    expect(installed.status).toBe(200);
    expect(await installed.json()).toMatchObject({ commit, url });
    expect((await get('/installed', 'outside')).status).toBe(404);
    expect((await get('/installed', 'author', otherProjectId)).status).toBe(404);

    const { designId } = (await (await publish('installed-build-design', draft())).json()).result;
    expect((await command('design.freeze', { designId, version: 1 })).status).toBe(201);
    const target = { designId, version: 1, target: 'installed', commit };
    expect((await command('acceptance.start', target, 'read-designer')).status).toBe(403);
    expect((await command('acceptance.start', target, 'author', 'outside-installation', otherProjectId)).status).toBe(404);
    expect((await command('acceptance.start', { ...target, pullRequest: 7 })).status).toBe(400);
    expect((await command('acceptance.start', { ...target, commit: 'd'.repeat(40) })).status).toBe(409);
    const started = await command('acceptance.start', target);
    expect(started.status).toBe(201);
    const { runId } = (await started.json()).result;
    const read = async () => (await (await get()).json()).designs[0];
    const opened = await read();
    expect(opened.runs[0]).toMatchObject({ id: runId, version: 1, target: 'installed', commit, previewUrl: url });
    expect(opened.runs[0].pullRequest).toBeUndefined();
    expect(opened.pullRequest).toBeUndefined();
    const record = { designId, runId, commit, cells: [{ itemId: 'A-1', slot: 'desktop-light', status: 'passed',
      actual: 'Verified the installed fixture members page', image: dataUrl(png(1280, 800)),
      measured: { width: 1280, height: 800, theme: 'light', path: '/members/' },
    }] };
    installedCommit = 'd'.repeat(40);
    expect((await command('acceptance.record', record)).status).toBe(409);
    installedCommit = commit;
    installedUrl = `${url}moved/`;
    expect((await command('acceptance.record', record)).status).toBe(409);
    installedUrl = url;
    activeCommit = 'e'.repeat(40);
    expect((await command('acceptance.record', record)).status).toBe(201);
    installedCommit = 'f'.repeat(40);
    expect((await command('acceptance.sign', { designId, runId })).status).toBe(409);
    expect((await read()).implementedVersion).toBeUndefined();
    installedCommit = commit;
    expect((await command('acceptance.sign', { designId, runId })).status).toBe(201);
    expect(await read()).toMatchObject({ frozen: 1, implementedVersion: 1, currentSignoffRunId: runId,
      upgrade: { status: 'completed', signoffRunId: runId },
      runs: [{ id: runId, target: 'installed', commit, previewUrl: url, signed: { by: 'author', verdict: 'passed' } }],
    });
    expect((await read()).runs[0].pullRequest).toBeUndefined();
    installedCommit = 'f'.repeat(40);
    const superseded = await read();
    expect(superseded.implementedVersion).toBe(1);
    expect(superseded.currentSignoffRunId).toBeNull();
  });

  it('projects only the latest run of the implementation baseline to planning', async () => {
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
    expect((await projection()).signed).toMatchObject({ runId: newRunId });
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
