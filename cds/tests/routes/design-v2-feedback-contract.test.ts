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
import type { DesignWorkspace } from '../../src/shared/design-workspace.js';
import { buildZip, crc32 } from '../../src/utils/zip.js';
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
  ['implementer', { kind: 'agent', id: 'implementer', label: 'Fixture implementer', permissions: ['read'], feedback: true, designRole: 'impl-agent' }],
  ['confirmer', { kind: 'human', id: 'confirmer', label: 'Fixture confirmer', permissions: ['read', 'write', 'approve'] }],
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
  let store: FileProjectRevisionStore<DesignWorkspaceCommit>;
  let server: Server;
  let api: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'cds-design-v2-feedback-'));
    store = new FileProjectRevisionStore(directory);
    const service = new DesignWorkspaceService(store, {
      feedbackAssignees: async project => project === projectId ? [
        { id: 'publisher', label: 'Fixture publisher', kind: 'person' },
        { id: 'implementer', label: 'Fixture implementer', kind: 'impl-agent' },
        { id: 'confirmer', label: 'Fixture confirmer', kind: 'person' },
      ] : [],
    });
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

  async function publish(filePath: string, options: { prior?: string; sibling?: boolean; data?: Buffer } = {}) {
    const screen = options.prior
      ? { id: 'revised-phone', name: 'Fixture phone', route: '#/revised', viewport: 'phone', themes: ['dark'], impl: '/revised/' }
      : { id: 'initial-desktop', name: 'Fixture desktop', route: '#/initial', viewport: 'desktop', themes: ['light'], impl: '/initial/' };
    const manifest = { project: projectId, title: 'Fixture feedback draft',
      screens: [{ ...screen, entryReadySelector: 'h1' }], docs: [filePath],
      acceptance: [{ id: 'A-01', how: 'measure', screenId: screen.id, rule: 'The feedback example opens', expected: '检查：标题可见。' }],
      ...(options.prior ? { id: options.prior } : {}) };
    const previous = options.prior ? { commit: 'a'.repeat(40), addedScreens: ['revised-phone'], removedScreens: ['initial-desktop'],
      changedRules: ['A-01'] } : undefined;
    const archive = versionedDesignFixture(manifest, 'Compare revision evidence.', [
      { name: 'dist/index.html', data: '<!doctype html><html><body><h1>Fixture feedback</h1></body></html>' },
      { name: filePath, data: options.data ?? '# Fixture delivery file\nOnly this exact revision contains the file.' },
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

  function handoverReport(designId: string) {
    return { ...report(designId), handlerId: 'implementer', body: '## 诉求\n\n核对交付记录。\n\n## 怎么算解决\n\n能打开对应反馈。' };
  }

  async function deliveryFiles(designId: string, version: number) {
    const response = await read(`?designId=${designId}&version=${version}`);
    expect(response.status).toBe(200);
    const { designs } = await response.json() as DesignWorkspace;
    return designs[0].versions.find(row => row.version === version)!.delivery!.files;
  }

  it('A-76 persists the holder, makes repeated transitions idempotent, and requires CDS screenshot proof', async () => {
    const designId = await publish(initialFile);
    const create = handoverReport(designId);
    expect((await send('/feedback', { ...create, handlerId: 'reader' }, 'publisher')).status).toBe(400);
    const opened = await send('/feedback', create, 'publisher');
    expect(opened.status).toBe(201);
    const { result: { id: feedbackId } } = await opened.json();
    const stage = { type: 'feedback.stage', designId, feedbackId, action: 'take', expectedStage: 'raised',
      body: '我会核对交付记录。', requestId: 'fixture-take-once' };
    expect((await send('/feedback', stage, 'publisher')).status).toBe(403);
    expect((await send('/feedback', stage)).status).toBe(201);
    expect((await send('/feedback', stage)).status).toBe(200);
    expect((await send('/feedback', { ...stage, requestId: randomUUID() })).status).toBe(409);

    const submit = { ...stage, requestId: randomUUID(), action: 'deliver', expectedStage: 'working',
      body: '已经核对记录，请确认。' };
    expect((await send('/feedback', submit)).status).toBe(400);
    const image = dataUrl(phonePng());
    expect((await send('/feedback/attachments', { type: 'feedback.attach', designId, feedbackId, title: '普通附图', image })).status).toBe(201);
    expect((await send('/feedback', submit)).status).toBe(400);
    expect((await send('/feedback', { type: 'feedback.resolve', designId, feedbackId, decision: 'close', body: '提前关闭' }, 'publisher')).status).toBe(409);

    const reopened = new DesignWorkspaceService(new FileProjectRevisionStore(directory));
    const thread = (await reopened.workspace(projectId, actors.get('publisher')!)).designs[0].feedback?.[0];
    expect(thread).toMatchObject({ stage: 'working', status: 'open', handler: { id: 'implementer', kind: 'impl-agent' },
      transitions: [{ action: 'take', author: { id: 'implementer', kind: 'impl-agent' } }] });
    const inbox = await read('?view=inbox', 'implementer');
    expect(inbox.status).toBe(200);
    expect(await inbox.json()).toMatchObject({ projectId, items: [{ designId, feedbackId, stage: 'working' }] });
    expect(await (await read('?view=inbox', 'publisher')).json()).toMatchObject({ projectId, items: [] });
    expect(await (await read('?view=inbox', 'implementer', otherProject)).json()).toMatchObject({ projectId: otherProject, items: [] });
  });

  it('A-77 and A-79 validate structured messages and persist the authenticated author role', async () => {
    const designId = await publish(initialFile);
    const opened = await send('/feedback', handoverReport(designId), 'publisher');
    expect(opened.status).toBe(201);
    const { result: { id: feedbackId } } = await opened.json();
    const reply = { type: 'feedback.reply', designId, feedbackId, body: '布局已经调整，我会复查。' };
    const message = { kind: 'answer', lead: '已调整页面布局。', items: ['A-01'] };
    for (const invalid of [
      { ...reply },
      { ...reply, message: { ...message, lead: 'https://fixture.invalid/example' } },
      { ...reply, message: { ...message, items: ['A-999'] } },
      { ...reply, message: { ...message, authorKind: 'person' } },
      { ...reply, message: { ...message, kind: 'confirm' } },
    ]) expect((await send('/feedback', invalid)).status).toBe(400);
    expect((await send('/feedback', { ...reply, message })).status).toBe(201);
    const { designs } = await (await read()).json() as DesignWorkspace;
    expect(designs[0].feedback?.[0]).toMatchObject({ author: { kind: 'person' }, stage: 'raised',
      replies: [{ author: { id: 'implementer', kind: 'impl-agent' }, message }],
    });
  });

  it('round-trips program evidence through delivery, return and final human confirmation', async () => {
    const designId = await publish(initialFile);
    const proof = { runId: 'RUN-fixture', screenId: 'initial-desktop', slot: 'desktop-light' } as const;
    const artifactId = 'fixture-program-image';
    const at = '2026-11-21T00:00:00.000Z';
    const commit = 'd'.repeat(40);
    const dataset = 'e'.repeat(64);
    const provenance = { dataset, commit, capturedBy: 'cds' as const };
    expect(await store.append({
      projectId, revision: 2,
      request: { key: 'fixture-program-proof', fingerprint: 'fixture-program-proof', result: { type: 'acceptance.capture' } },
      assets: [{ id: artifactId, mime: 'image/png', base64: phonePng().toString('base64') }],
      design: { id: designId, run: { id: proof.runId, version: 1, commit, previewUrl: 'https://fixture.invalid',
        createdAt: at, verdict: 'pending', issues: {}, cells: [],
        programEvidence: { 'initial-desktop/desktop-light': { ...provenance, fixtureDigest: dataset, digest: dataset, by: 'implementer', at } },
        visual: { 'initial-desktop/desktop-light': { ...provenance, imageId: artifactId, checks: {}, by: 'CDS', at } },
      } },
    })).toBe(true);
    const opened = await send('/feedback', handoverReport(designId), 'publisher');
    const { result: { id: feedbackId } } = await opened.json();
    const stage = (action: string, expectedStage: string, body: string, actor = 'implementer', evidence?: typeof proof) => send('/feedback',
      { type: 'feedback.stage', designId, feedbackId, action, expectedStage, body, ...(evidence ? { proof: evidence } : {}) }, actor);

    expect((await stage('take', 'raised', '我会核对反馈。')).status).toBe(201);
    expect((await stage('deliver', 'working', '我已核对反馈。', 'implementer', { ...proof, slot: 'desktop-dark' } as typeof proof)).status).toBe(400);
    expect((await stage('deliver', 'working', '我已核对反馈。', 'implementer', proof)).status).toBe(201);
    expect((await stage('confirm', 'review', '可以完结。', 'implementer', proof)).status).toBe(403);
    expect((await stage('return', 'review', '请补充关闭时的画面。', 'publisher')).status).toBe(201);
    expect((await stage('deliver', 'returned', '已经补充画面。', 'implementer', proof)).status).toBe(201);
    expect((await stage('confirm', 'review', '结果已经核对。', 'publisher', proof)).status).toBe(201);
    const { designs } = await (await read()).json() as DesignWorkspace;
    const thread = designs[0].feedback?.[0];
    expect(thread).toMatchObject({ stage: 'done', status: 'closed' });
    expect(thread?.transitions?.map(step => step.action)).toEqual(['take', 'deliver', 'return', 'deliver', 'confirm']);
    expect(thread?.transitions?.at(-1)?.proof).toMatchObject({ ...proof, imageId: artifactId, commit });
    expect((await read('/artifacts/' + artifactId)).status).toBe(200);

    const agentReport = { ...handoverReport(designId), handlerId: 'publisher' };
    expect((await send('/feedback', agentReport)).status).toBe(400);
    expect((await send('/feedback', { ...agentReport, confirmerId: 'reader' })).status).toBe(400);
    expect((await send('/feedback', { ...agentReport, confirmerId: 'publisher' })).status).toBe(400);
    const delegated = await send('/feedback', { ...agentReport, confirmerId: 'confirmer' });
    expect(delegated.status).toBe(201);
    const { result: { id: delegatedId } } = await delegated.json();
    const next = (action: string, expectedStage: string, actor: string, evidence?: typeof proof) => send('/feedback',
      { type: 'feedback.stage', designId, feedbackId: delegatedId, action, expectedStage,
        body: '已核对本次交接。', ...(evidence ? { proof: evidence } : {}) }, actor);
    expect((await next('take', 'raised', 'publisher')).status).toBe(201);
    expect((await next('deliver', 'working', 'publisher', proof)).status).toBe(201);
    expect(await (await read('?view=inbox', 'confirmer')).json()).toMatchObject({ items: [{ feedbackId: delegatedId, stage: 'review' }] });
    expect((await next('confirm', 'review', 'implementer', proof)).status).toBe(403);
    expect((await next('confirm', 'review', 'publisher', proof)).status).toBe(403);
    expect((await next('confirm', 'review', 'confirmer', proof)).status).toBe(201);
    expect((await (await read()).json() as DesignWorkspace).designs[0].feedback?.find(row => row.id === delegatedId)).toMatchObject({
      stage: 'done', author: { id: 'implementer', kind: 'impl-agent' }, confirmer: { id: 'confirmer', kind: 'person' },
    });
  });

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

  it('reads new source diffs from the selected version and preserves the original download bytes', async () => {
    const filePath = 'docs/fixture-source.diff';
    const patches = ['初版', '修订版'].map(label => Buffer.from(`--- a/example.txt\r\n+++ b/example.txt\r\n@@ -1 +1 @@\r\n-before\r\n+${label}\r\n`));
    const designId = await publish(filePath, { data: patches[0] });
    await publish(filePath, { prior: designId, data: patches[1] });

    const ids = new Set<string>();
    for (const [index, bytes] of patches.entries()) {
      const file = (await deliveryFiles(designId, index + 1)).find(row => row.path === filePath)!;
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      expect(file).toMatchObject({ text: true, sha256 });
      ids.add(file.id);
      const artifactPath = `/artifacts/${file.id}`;
      const text = await read(`${artifactPath}?view=text`);
      expect(text.status).toBe(200);
      expect(await text.json()).toMatchObject({ artifactId: file.id, path: filePath, sha256, offset: 0, nextOffset: null, text: bytes.toString('utf8') });
      const download = await read(`${artifactPath}?download=true`);
      expect(download.status).toBe(200);
      expect(download.headers.get('content-disposition')).toContain('attachment');
      expect(Buffer.from(await download.arrayBuffer())).toEqual(bytes);
      expect((await read(`${artifactPath}?view=text`, 'reader', otherProject)).status).toBe(404);
    }
    expect(ids.size).toBe(2);
  });

  it('opens valid historical patches indexed as binary and rejects invalid UTF-8 and NUL in text view', async () => {
    const id = 'DSN-legacy-patches';
    const archiveId = 'fixture-legacy-archive';
    const legacy = [
      { path: 'changes/source.patch', bytes: Buffer.from('--- a/fixture\n+++ b/fixture\n@@ -1 +1 @@\n-old\n+历史内容\n') },
      { path: 'changes/invalid-encoding.diff', bytes: Buffer.from([0x61, 0xc3, 0x28, 0x62]) },
      { path: 'changes/invalid-nul.patch', bytes: Buffer.from('valid UTF-8\0with NUL') },
    ];
    const files = legacy.map(({ path: filePath, bytes }, index) => ({ id: `legacy-patch-${index}`, path: filePath,
      kind: 'attachment' as const, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), text: false }));
    const prototypeId = 'fixture-legacy-prototype';
    const prototype = '<!doctype html><main>Fixture prototype</main>';
    const archive = buildZip([
      { name: 'bundle/design.json', data: JSON.stringify({ project: projectId, title: 'Historical differences', screens: [], acceptance: [] }) },
      { name: 'bundle/思路.md', data: 'Historical fixture.' },
      { name: 'bundle/dist/index.html', data: prototype },
      ...legacy.map(({ path: filePath, bytes }) => ({ name: `bundle/${filePath}`, data: bytes })),
    ]);
    expect(await store.append({ projectId, revision: 1, request: { key: id, fingerprint: id, result: { type: 'package', designId: id, version: 1 } },
      assets: [{ id: archiveId, mime: 'application/zip', base64: archive.toString('base64') }],
      design: { id, version: { version: 1, title: 'Historical differences', createdAt: '2026-11-20T00:00:00Z',
        publisher: { id: 'publisher', label: 'Fixture publisher' }, sourceCommit: 'a'.repeat(40),
        sha256: createHash('sha256').update(archive).digest('hex'), prototypeId,
        rationale: 'Historical fixture.', spec: {}, screens: [], acceptance: [], tags: [], decisionIds: [], resolves: {},
        delivery: { archiveId, archiveRoot: 'bundle/', warnings: [], files: [...files,
          { id: prototypeId, path: 'dist/index.html', kind: 'prototype', size: Buffer.byteLength(prototype),
            sha256: createHash('sha256').update(prototype).digest('hex'), text: true }] },
      } },
    })).toBe(true);
    expect(await deliveryFiles(id, 1)).toEqual(expect.arrayContaining(files));

    const text = await read(`/artifacts/${files[0].id}?view=text`);
    expect(text.status).toBe(200);
    expect(await text.json()).toMatchObject({ sha256: files[0].sha256, text: legacy[0].bytes.toString('utf8') });
    for (const file of files.slice(1)) {
      const denied = await read(`/artifacts/${file.id}?view=text`);
      expect(denied.status).toBe(400);
      expect(await denied.json()).toMatchObject({ error: 'invalid_design' });
    }
    for (const [index, file] of files.entries()) {
      const download = await read(`/artifacts/${file.id}?download=true`);
      expect(download.status).toBe(200);
      expect(Buffer.from(await download.arrayBuffer())).toEqual(legacy[index].bytes);
    }
    expect((await read(`/artifacts/${files[0].id}?view=text`, 'reader', otherProject)).status).toBe(404);
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
