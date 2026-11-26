import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDesignWorkspaceRouter } from '../../src/routes/design-workspace.js';
import { DesignWorkspaceService, type DesignActor, type DesignWorkspaceCommit } from '../../src/services/design-workspace.js';
import { FileProjectRevisionStore } from '../../src/services/project-revision-store.js';
import { crc32 } from '../../src/utils/zip.js';
import { versionedDesignFixture } from '../helpers/versioned-design-fixture.js';

const projectId = 'fixture-v2-feedback';
const otherProject = 'fixture-v2-feedback-other';
const initialFile = 'docs/fixture-baseline.md';
const revisedFile = 'docs/fixture-revision.md';
const siblingFile = 'docs/fixture-sibling.md';
const textLimit = 48 * 1024;
const imageLimit = 1.5 * 1024 * 1024;
const actors = new Map<string, DesignActor>([
  ['publisher', { kind: 'human', id: 'publisher', label: 'Fixture publisher', permissions: ['read', 'write', 'approve'] }],
  ['implementer', { kind: 'agent', id: 'implementer', label: 'Fixture implementer', permissions: ['read'], feedback: true }],
  ['reader', { kind: 'agent', id: 'reader', label: 'Fixture read-only actor', permissions: ['read'] }],
]);

function chunk(name: string, data: Buffer) {
  const bytes = Buffer.alloc(12 + data.length);
  bytes.writeUInt32BE(data.length, 0);
  bytes.write(name, 4, 'ascii');
  data.copy(bytes, 8);
  bytes.writeUInt32BE(crc32(bytes.subarray(4, 8 + data.length)), 8 + data.length);
  return bytes;
}

function phonePng(options: { uncompressed?: boolean; textBytes?: number } = {}) {
  const width = 375;
  const height = 812;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const pixels = deflateSync(Buffer.alloc((width * 3 + 1) * height), { level: options.uncompressed ? 0 : 6 });
  const text = options.textBytes ? [chunk('tEXt', Buffer.concat([
    Buffer.from('Description\0'), Buffer.alloc(options.textBytes, 0x61),
  ]))] : [];
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), ...text,
    chunk('IDAT', pixels), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const dataUrl = (bytes: Buffer) => `data:image/png;base64,${bytes.toString('base64')}`;

describe('CDS V2 feedback contract', () => {
  let directory: string;
  let server: Server;
  let api: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'cds-design-v2-feedback-'));
    const store = new FileProjectRevisionStore<DesignWorkspaceCommit>(directory);
    const service = new DesignWorkspaceService(store);
    const app = express();
    app.use('/api', createDesignWorkspaceRouter({ service, resolveAccess: (request, project) =>
      project === projectId || project === otherProject ? actors.get(request.get('x-fixture-user') ?? '') ?? null : null,
    }));
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture server');
    api = `http://127.0.0.1:${address.port}/api/projects`;
  });

  afterEach(async () => {
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  const endpoint = (project: string, suffix?: string) => `${api}/${project}/design${suffix ?? ''}`;

  function read(suffix = '', actor = 'reader', project = projectId) {
    return fetch(endpoint(project, suffix), { headers: { 'x-fixture-user': actor } });
  }

  function send(suffix: string, payload: object | string, actor = 'implementer', project = projectId) {
    return fetch(endpoint(project, suffix), {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-fixture-user': actor },
      body: typeof payload === 'string' ? payload : JSON.stringify({ requestId: randomUUID(), ...payload }),
    });
  }

  async function publish(filePath: string, options: { prior?: string; sibling?: boolean } = {}) {
    const screen = options.prior
      ? { id: 'revised-phone', name: 'Fixture phone', route: '#/revised', viewport: 'phone', themes: ['dark'], impl: '/revised/' }
      : { id: 'initial-desktop', name: 'Fixture desktop', route: '#/initial', viewport: 'desktop', themes: ['light'], impl: '/initial/' };
    const manifest = { project: projectId, title: 'Fixture feedback draft',
      screens: [{ ...screen, entryReadySelector: 'h1' }], acceptance: [], docs: [filePath],
      ...(options.prior ? { id: options.prior } : {}) };
    const previous = options.prior ? { commit: 'a'.repeat(40), addedScreens: ['revised-phone'], removedScreens: ['initial-desktop'] } : undefined;
    const archive = versionedDesignFixture(manifest, 'Compare revision evidence.', [
      { name: 'dist/index.html', data: '<!doctype html><html><body><h1>Fixture feedback</h1></body></html>' },
      { name: filePath, data: '# Fixture delivery file\nOnly this exact revision contains the file.' },
    ], previous);
    const query = new URLSearchParams({ requestId: randomUUID(), sourceCommit: (options.prior ? 'b' : 'a').repeat(40),
      sourceMode: 'private', sourcePath: options.sibling ? 'design/fixture-sibling' : 'design/fixture-feedback',
      ...(options.prior ? { intent: 'revise', designId: options.prior, expectedVersion: '1' }
        : { intent: 'create', designKey: options.sibling ? 'fixture/sibling' : 'fixture/feedback' }),
    });
    const response = await fetch(endpoint(projectId, `/packages?${query}`), {
      method: 'POST', headers: { 'Content-Type': 'application/zip', 'x-fixture-user': 'publisher' },
      body: new Uint8Array(archive),
    });
    const body = await response.json();
    expect(response.status, body.message).toBe(201);
    return body.result.designId as string;
  }

  function report(designId: string) {
    return { type: 'feedback.create', designId, version: 1, screenId: 'initial-desktop', category: 'implementation',
      title: 'Fixture feedback', body: 'Check the archived design revision.' };
  }

  it('keeps text feedback at 48 KiB and accepts only attachments on the independent upload endpoint', async () => {
    const designId = await publish(initialFile);
    const payload = report(designId);
    const atSize = (size: number) => JSON.stringify({ requestId: randomUUID(), ...payload }).padEnd(size, ' ');

    expect((await send('/feedback', payload, 'reader')).status).toBe(403);
    const exact = atSize(textLimit);
    expect(Buffer.byteLength(exact)).toBe(textLimit);
    expect((await send('/feedback', exact)).status).toBe(201);
    const over = atSize(textLimit + 1);
    expect(Buffer.byteLength(over)).toBe(textLimit + 1);
    expect((await send('/feedback', over)).status, 'the text request limit is enforced before a valid larger body can write').toBe(413);
    expect((await send('/feedback/attachments', payload)).status).toBe(400);
    expect((await (await read()).json()).designs[0].feedback).toHaveLength(1);
  });

  it('round-trips a delivery file on its exact draft version and rejects other versions and drafts', async () => {
    const designId = await publish(initialFile);
    expect(await publish(revisedFile, { prior: designId })).toBe(designId);
    const sibling = await publish(siblingFile, { sibling: true });
    expect(sibling).not.toBe(designId);
    const payload = report(designId);

    for (const filePath of [revisedFile, siblingFile, 'docs/missing.md']) {
      expect((await send('/feedback', { ...payload, filePath })).status, filePath).toBe(400);
    }
    const response = await send('/feedback', { ...payload, filePath: initialFile });
    const created = await response.json();
    expect(response.status, created.message).toBe(201);
    const { designs } = await (await read()).json();
    expect(designs.find((row: { id: string }) => row.id === designId).feedback).toEqual([
      expect.objectContaining({ id: created.result.id, version: 1, screenId: 'initial-desktop',
        filePath: initialFile, author: expect.objectContaining({ id: 'implementer' }) }),
    ]);
  });

  it('uploads a large PNG on the scoped endpoint and validates its selected version, screen and slot', async () => {
    const designId = await publish(initialFile);
    expect(await publish(revisedFile, { prior: designId })).toBe(designId);
    const thread = await send('/feedback', report(designId));
    expect(thread.status).toBe(201);
    const { result: { id: feedbackId } } = await thread.json();
    const capture = phonePng({ uncompressed: true });
    expect(capture.length).toBeGreaterThan(textLimit);
    expect(capture.length).toBeLessThan(imageLimit);
    const metadata = { type: 'feedback.attach', designId, feedbackId, title: 'Fixture revision screenshot',
      version: 2, screenId: 'revised-phone', slot: 'phone-dark' };
    const details = { ...metadata, image: dataUrl(capture) };

    const upload = await send('/feedback/attachments', details);
    expect(upload.status, 'the dedicated endpoint accepts a valid PNG larger than the text limit').toBe(201);
    const { result } = await upload.json();
    expect(result).toMatchObject({ type: 'feedback.attach', designId, id: feedbackId, version: 2, artifactId: expect.any(String) });
    expect((await send('/feedback', details)).status).toBe(413);
    const small = { ...metadata, image: dataUrl(phonePng()) };
    expect((await send('/feedback/attachments', { ...small, version: 99 })).status).toBe(404);
    for (const invalid of [
      { screenId: 'initial-desktop' }, { screenId: undefined },
      { slot: 'desktop-dark' }, { slot: 'phone-light' }, { slot: 'wide-dark' },
    ]) {
      expect((await send('/feedback/attachments', { ...small, ...invalid })).status).toBe(400);
    }
    expect((await send('/feedback/attachments', small, 'reader')).status).toBe(403);
    expect((await read('', 'implementer', otherProject)).status).toBe(200);
    expect((await send('/feedback/attachments', small, 'implementer', otherProject)).status).toBe(404);
    const oversized = phonePng({ uncompressed: true, textBytes: 700 * 1024 });
    expect(oversized.length).toBeGreaterThan(imageLimit);
    expect([400, 413]).toContain((await send('/feedback/attachments', { ...metadata, image: dataUrl(oversized) })).status);

    const { designs } = await (await read()).json();
    expect(designs[0].feedback).toEqual([expect.objectContaining({
      id: feedbackId, version: 1, screenId: 'initial-desktop', status: 'open',
      attachments: [expect.objectContaining({ id: result.artifactId, version: 2, screenId: 'revised-phone', slot: 'phone-dark',
        size: capture.length, sha256: createHash('sha256').update(capture).digest('hex') })],
    })]);
    const artifactPath = `/artifacts/${result.artifactId}`;
    const artifact = await read(artifactPath);
    expect(artifact.status).toBe(200);
    expect(artifact.headers.get('content-type')).toContain('image/png');
    expect(artifact.headers.get('cache-control')).toBe('private, no-store');
    expect(Buffer.from(await artifact.arrayBuffer()).equals(capture)).toBe(true);
    expect((await read(artifactPath, 'reader', otherProject)).status).toBe(404);
  });
});
