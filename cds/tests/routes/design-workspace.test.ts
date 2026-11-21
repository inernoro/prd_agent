import { once } from 'node:events';
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
import { buildZip, crc32 } from '../../src/utils/zip.js';

const projectId = 'fixture-design-a';
const sourceCommit = 'a'.repeat(40);
const previewCommit = 'b'.repeat(40);
const html = '<!doctype html><html><head><meta charset="utf-8"></head><body><h1>Fixture</h1></body></html>';
const permissions = ['read', 'propose', 'write', 'approve'] as const;
const people = new Map<string, DesignActor>([
  ['designer', { kind: 'agent', id: 'designer', label: 'Fixture designer', permissions }],
  ['author', { kind: 'human', id: 'author', label: 'Fixture reviewer', permissions }],
  ['other', { kind: 'human', id: 'other', label: 'Other member', permissions }],
]);

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

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'cds-design-test-'));
    activeCommit = previewCommit;
    const service = new DesignWorkspaceService(new FileProjectRevisionStore<DesignWorkspaceCommit>(directory), {
      resolvePreview: async (project, pr, commit) => project === projectId && pr === 7 && (!commit || commit === activeCommit)
        ? { commit: activeCommit, url: 'https://preview.fixture.test/' } : undefined,
      sourcePackage: async (project, sha, sourcePath) => project === projectId && sha === sourceCommit && sourcePath === 'design/fixture' ? draft() : undefined,
    });
    const server = express();
    server.use('/api', createDesignWorkspaceRouter({ service, resolveAccess: (req, project) =>
      (project === projectId || project === 'fixture-design-b') ? people.get(req.get('x-fixture-user') ?? '') ?? null : null }));
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

  function command(type: string, fields: object, actor = 'author') {
    return fetch(`${base}${projectId}/design/commands`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-fixture-user': actor },
      body: JSON.stringify({ type, requestId: crypto.randomUUID(), ...fields }),
    });
  }

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

  it('acknowledges the source only after matching the archive against the project Git tree', async () => {
    const source = { sourcePath: 'design/fixture' };
    expect((await publish('fake-source', draft('Modified archive'), source)).status).toBe(409);
    expect((await publish('known-source', draft(), source)).status).toBe(201);
    expect((await publish('outside-source', draft(), { ...source, sourceCommit: 'f'.repeat(40) })).status).toBe(201);
    const { designs } = await (await get()).json();
    expect(designs.map((entry: any) => entry.versions[0].sourceVerification).sort()).toEqual(['declared', 'git']);
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
});
