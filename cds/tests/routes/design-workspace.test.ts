import { once } from 'node:events';
import { createHash, createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { deflateSync } from 'node:zlib';
import path from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHumanProjectAccessMiddleware } from '../../src/middleware/human-project-access.js';
import { createDesignWorkspaceRouter } from '../../src/routes/design-workspace.js';
import { DesignWorkspaceService, type DesignActor, type DesignWorkspaceCommit } from '../../src/services/design-workspace.js';
import { humanPrincipalId } from '../../src/services/human-project-access.js';
import { FileProjectRevisionStore } from '../../src/services/project-revision-store.js';
import { StateService } from '../../src/services/state.js';
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
  ['rotated-designer', { kind: 'agent', id: 'designer', label: 'Fixture refreshed key', permissions }],
  ['git-designer', { kind: 'agent', id: 'git-designer', label: 'Fixture restricted designer', permissions, gitPublishOnly: true }],
  ['read-designer', { kind: 'agent', id: 'read-designer', label: 'Read-only designer', permissions: ['read'] }],
  ['reading-member', { kind: 'human', id: 'reading-member', label: 'Reading member', permissions: ['read'] }],
  ['implementer', { kind: 'agent', id: 'implementer', label: 'Implementation agent', permissions: ['read'], feedback: true }],
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

  function openWorkspace() {
    const dependencies = {
      now: () => new Date(clock),
      approvedPlanFor: async (project: string, plan: string) => project === projectId && plan === 'PLN-approved'
        ? { planVersion: approvedPlanVersion, proposalId: 'PRO-fixture', title: 'Approved brief', requirements: 'Original **approved** requirements' } : undefined,
      frameworkProbe: async () => frameworkMeasurements,
      resolvePreview: async (project: string, pr: number, commit?: string) => project === projectId && [7, 8].includes(pr) && (!commit || commit === activeCommit)
        ? { commit: activeCommit, url: pr === 7 ? 'https://preview.fixture.test/' : 'https://preview.fixture.test/other/' } : undefined,
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
    return new DesignWorkspaceService(new FileProjectRevisionStore<DesignWorkspaceCommit>(directory), dependencies);
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
    expect(delivery.files.map((file: { path: string }) => file.path)).toHaveLength(10);
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
