// map-design-executor-v1 协议层测试：能力、鉴权、提交、忙时 409、幂等、事件续读（JSON 与 SSE）、取消、
// 超时、失败，以及隔离方案 A 的核心不变量——任务无论怎样结束，工作目录与引擎数据都被清空、引擎换新令牌重启。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { codeFilmDefaultAnswers, parseFilmCaptions, readFilmCaptionSidecar } from '../src/engine/code-film.js';
import { MAX_BROWSER_FILM_EXPORT_REQUEST_BYTES, parseBrowserFilmExport } from '../src/engine/browser-film-export.js';
import { FilmRecoveryStore } from '../src/engine/film-recovery.js';
import { FilmProjectCheckpointStore, filmProjectInputHash } from '../src/engine/film-project-checkpoint.js';
import { normalizeTaskRequest } from '../src/protocol.js';
import { sha256 } from '../src/workspace/primitives.js';
import { MAP_DESIGN_WORKSPACE_SCHEMA, parseWorkspacePackage } from '../src/workspace/transfer.js';
import {
  API_KEY,
  auth,
  buildPackage,
  directoryEntries,
  startFakeMap,
  startHarness,
  taskRequest,
  waitFor,
  type FakeMap,
  type Harness,
} from './helpers.js';

const GOOD_PAGE = '<!doctype html><html lang="zh-CN"><head><title>Launch</title></head><body><main id="top"><h1>Launch page</h1><p>Product overview for the launch.</p><a href="#top">Back to top</a></main></body></html>';

let harness: Harness | undefined;
let map: FakeMap | undefined;

afterEach(async () => {
  await harness?.close();
  await map?.close();
  harness = undefined;
  map = undefined;
});

/** 每个任务的第一轮写出一张合格页面（工作区在任务之间被清空，所以「还没有 index.html」就是第一轮）。 */
function writesGoodPage(context: { workspaceDir: string }) {
  const target = path.join(context.workspaceDir, 'index.html');
  if (!fs.existsSync(target)) fs.writeFileSync(target, GOOD_PAGE);
  return { status: 'succeeded' as const };
}

function taskDirectoriesAreEmpty(h: Harness): boolean {
  return [h.config.workspaceDir, h.config.odDataDir, h.config.templatesDir, h.config.outputDir]
    .every((directory) => directoryEntries(directory).length === 0);
}

async function terminalView(h: Harness, taskId: string) {
  return waitFor(async () => {
    const response = await h.request('GET', `/v1/tasks/${taskId}`, undefined, auth);
    return response.body.task?.state !== 'running' ? response.body.task : undefined;
  }, `task ${taskId} to finish`);
}

async function cleanedUp(h: Harness, taskId: string) {
  return waitFor(async () => {
    const response = await h.request('GET', `/v1/tasks/${taskId}`, undefined, auth);
    return response.body.task?.cleanup === 'completed' && h.runtime.tasks.slotState() === 'idle' ? response.body.task : undefined;
  }, `task ${taskId} cleanup`);
}

describe('film recovery', () => {
  it('serves only a complete retained MP4 after the OpenDesign workspace has been reset', async () => {
    harness = await startHarness();
    const recovery = new FilmRecoveryStore(path.join(harness.root, 'film-recovery'));
    const box = (type: string) => {
      const bytes = Buffer.alloc(12);
      bytes.writeUInt32BE(bytes.length);
      bytes.write(type, 4, 'ascii');
      return bytes;
    };
    const movie = Buffer.concat([box('ftyp'), box('mdat'), box('moov')]);
    const retain = (bytes: Buffer) => recovery.retain('film-recovery-test', {
      path: 'film.mp4',
      mediaType: 'video/mp4',
      size: bytes.length,
      sha256: sha256(bytes),
      contentBase64: bytes.toString('base64'),
    });
    expect(retain(movie.subarray(0, -1))).toBe(false);
    expect(retain(movie)).toBe(true);

    await harness.runtime.lifecycle.reset();
    expect(taskDirectoriesAreEmpty(harness)).toBe(true);
    expect(harness.runtime.tasks.get('film-recovery-test')).toBeUndefined();
    const url = harness.baseUrl + '/v1/tasks/film-recovery-test/film-recovery';
    expect((await fetch(url)).status).toBe(401);
    const response = await fetch(url, { headers: auth });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-content-sha256')).toBe(sha256(movie));
    expect(Buffer.from(await response.arrayBuffer())).toEqual(movie);

    const persisted = path.join(recovery.directory, 'film-recovery-test.film');
    const corrupted = fs.readFileSync(persisted);
    corrupted[corrupted.length - 1] ^= 1;
    fs.writeFileSync(persisted, corrupted);
    expect((await fetch(url, { headers: auth })).status).toBe(404);
  });
});

describe('GET /v1/capabilities', () => {
  it('reports protocol, engine, versions, design systems and a live healthy engine', async () => {
    harness = await startHarness();
    const response = await harness.request('GET', '/v1/capabilities');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      protocol: 'map-design-executor-v1',
      engine: 'open-design',
      engineVersion: '0.21.1',
      codexVersion: 'codex-cli 0.143.0',
      designSystems: ['default', 'editorial'],
      browserQuality: { ready: true, observation: 'test Chromium' },
      healthy: true,
      busy: false,
      acceptingTasks: true,
      maxConcurrentTasks: 1,
      state: 'idle',
      reason: null,
    });
    const ready = await harness.request('GET', '/healthz/ready');
    expect(ready.status).toBe(200);
  });

  it('refuses readiness and new tasks when the isolated quality browser is missing', async () => {
    harness = await startHarness({ overrides: {
      selfCheck: {
        codexVersion: 'codex-cli 0.143.0',
        codexMatches: true,
        codexObservation: 'codex-cli 0.143.0',
        missingSkillFiles: [],
        designSystems: ['default', 'editorial'],
        browserQuality: { ready: false, executablePath: '/missing/chromium', observation: 'browser executable missing' },
      },
    } });
    const capabilities = await harness.request('GET', '/v1/capabilities');
    expect(capabilities.body.engineReady).toBe(false);
    expect(capabilities.body.browserQuality).toEqual({ ready: false, observation: 'browser executable missing' });
    expect(capabilities.body.conditions.map((condition: { code: string }) => condition.code)).toContain('browser_quality_unavailable');
    expect((await harness.request('GET', '/healthz/ready')).status).toBe(503);
  });

  it('actually probes the daemon: a failing /api/health turns healthy false with an external-cause-first reason', async () => {
    harness = await startHarness();
    harness.daemon.healthStatus = 503;
    const response = await harness.request('GET', '/v1/capabilities');
    expect(response.body.healthy).toBe(false);
    expect(response.body.reason.code).toBe('engine_unhealthy');
    // 第一句是「谁 + 做了什么」，内因只在「技术细节」之后。
    expect(response.body.reason.message.startsWith('OpenDesign 引擎进程没有通过健康检查')).toBe(true);
    expect(response.body.reason.message.indexOf('HTTP 503')).toBeGreaterThan(response.body.reason.message.indexOf('技术细节'));
    const ready = await harness.request('GET', '/healthz/ready');
    expect(ready.status).toBe(503);
    // 引擎不健康时新任务不接，原因与能力接口同一份。
    const pkg = buildPackage([]);
    map = await startFakeMap(pkg);
    const submit = await harness.request('POST', '/v1/tasks', taskRequest(map, pkg), auth);
    expect(submit.status).toBe(503);
    expect(submit.body.error.code).toBe('engine_unhealthy');
    expect(map.inputRequests).toBe(0);
  });

  it('flags an engine version that does not match the pinned image', async () => {
    harness = await startHarness();
    harness.daemon.version = '0.22.0';
    const response = await harness.request('GET', '/v1/capabilities');
    expect(response.body.healthy).toBe(false);
    expect(response.body.reason.code).toBe('engine_version_mismatch');
    expect(response.body.reason.message).toContain('运行镜像');
  });
});

describe('authentication', () => {
  it('refuses every task endpoint when DESIGN_RUNTIME_API_KEY is not configured and says why in capabilities', async () => {
    harness = await startHarness({ apiKey: '' });
    const capabilities = await harness.request('GET', '/v1/capabilities');
    expect(capabilities.body.healthy).toBe(false);
    expect(capabilities.body.reason.code).toBe('api_key_not_configured');
    expect(capabilities.body.reason.message).toContain('部署配置没有提供 DESIGN_RUNTIME_API_KEY');
    // 引擎本身是好的：就绪探针不因缺 key 而失败。
    expect((await harness.request('GET', '/healthz/ready')).status).toBe(200);
    for (const [method, pathname] of [
      ['POST', '/v1/tasks'], ['GET', '/v1/tasks/any'], ['GET', '/v1/tasks/any/events'], ['POST', '/v1/tasks/any/cancel'],
    ] as const) {
      const response = await harness.request(method, pathname, method === 'POST' ? {} : undefined, { Authorization: 'Bearer anything' });
      expect(response.status, `${method} ${pathname}`).toBe(503);
      expect(response.body.error.code).toBe('api_key_not_configured');
    }
  });

  it('rejects a missing or wrong bearer key with 401', async () => {
    harness = await startHarness();
    expect((await harness.request('POST', '/v1/tasks', {})).status).toBe(401);
    const wrong = await harness.request('POST', '/v1/tasks', {}, { Authorization: `Bearer ${API_KEY}x` });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get('www-authenticate')).toBe('Bearer');
  });
});

describe('native code film form continuation', () => {
  const form = {
    id: 'film-brief',
    questions: [
      { id: 'duration', type: 'radio', defaultValue: '60s', options: [{ label: '60 秒', value: '60s' }] },
      { id: 'audio', type: 'radio', defaultValue: 'auto_voice', options: [{ label: '由你安排配音', value: 'auto_voice' }] },
      { id: 'review', type: 'radio', defaultValue: 'direct', options: [{ label: '直接制作完整短片', value: 'direct' }] },
    ],
  };
  const body = (value: unknown) => `<question-form>
${JSON.stringify(value)}
</question-form>`;

  it('echoes the recommended choices through the native conversation protocol', () => {
    expect(codeFilmDefaultAnswers(body(form))).toBe(
      '[form answers — film-brief]\n- duration: 60s\n- audio: auto_voice\n- review: direct',
    );
  });

  it('uses the native tagged form identity and leaves optional text unanswered', () => {
    const questions = [
      { ...form.questions[0], defaultValue: '90s', options: [{ label: '约 90 秒', value: '90s' }] },
      { id: 'audio', type: 'textarea', defaultValue: '无，按默认方案制作。' },
      { ...form.questions[2], id: 'storyboard' },
    ];
    const markup = `<question-form id="adr-film-brief" title="确认短片制作方向">
${JSON.stringify({ questions })}
</question-form>`;
    expect(codeFilmDefaultAnswers(markup)).toBe(
      '[form answers — adr-film-brief]\n- duration: 90s\n- audio: (skipped)\n- storyboard: direct',
    );
  });

  it('skips custom questions, invalid choices and ambiguous forms', () => {
    expect(codeFilmDefaultAnswers(body(form) + body(form))).toBeUndefined();
    expect(codeFilmDefaultAnswers(body({ ...form, questions: [{ id: 'draft', type: 'textarea', required: true }] }))).toBeUndefined();
    expect(codeFilmDefaultAnswers(body({
      ...form, questions: [{ ...form.questions[0], defaultValue: '300s' }],
    }))).toBeUndefined();
  });
});

describe('POST /v1/tasks', () => {
  it('preserves the exact film command and original text without using the HTML output contract', async () => {
    const pkg = buildPackage([]);
    map = await startFakeMap(pkg);
    const source = Buffer.from('# ADR 原文\r\n\r\n  保留空白。\n');
    const serialized = Buffer.from(JSON.stringify({
      schemaVersion: MAP_DESIGN_WORKSPACE_SCHEMA,
      runId: pkg.runId,
      baseRevision: pkg.baseRevision,
      files: [{
        path: 'decisions.md', mediaType: 'text/markdown', sha256: sha256(source),
        size: source.length, contentBase64: source.toString('base64'),
      }],
    }));
    const command = '  用视觉笔记风格给我做一支关于架构决策记录的片子。\n';
    const request = taskRequest(map, pkg);
    const filmRequest = {
      ...request,
      envelope: { schemaVersion: 'map-code-film-command-v1', runId: pkg.runId, command },
      transfer: { ...(request.transfer as object), inputSha256: sha256(serialized), allowedOutputPaths: ['film.mp4'] },
    };
    const normalized = normalizeTaskRequest(filmRequest);

    expect(normalized.codeFilm).toBe(true);
    expect(normalized.instruction).toBe(command);
    expect(parseWorkspacePackage(serialized, normalized.transfer).files[0].bytes).toEqual(source);
    expect(() => normalizeTaskRequest({ ...filmRequest, transfer: request.transfer })).toThrow('film.mp4 and film.json');
    expect(normalizeTaskRequest({
      ...filmRequest, transfer: { ...filmRequest.transfer, allowedOutputPaths: ['film.mp4', 'film.json'] },
    }).transfer.allowedOutputPaths).toEqual(['film.mp4', 'film.json']);
    expect(() => normalizeTaskRequest({ ...filmRequest, envelope: request.envelope })).toThrow('index.html');
  });

  it('accepts a quick creation film package with original sources, style and image references', async () => {
    const pkg = buildPackage([]);
    map = await startFakeMap(pkg);
    const source = Buffer.from('# ADR 原文\r\n  保留空白\n');
    const secondSource = Buffer.from('第二份稿件\n');
    const guide = Buffer.from('# Sketchnote STYLE.md\n');
    const reference = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const original = (filePath: string, mediaType: string, bytes: Buffer) => ({
      path: filePath, mediaType, sha256: sha256(bytes), size: bytes.length, contentBase64: bytes.toString('base64'),
    });
    const files = [
      original('source-1.md', 'text/markdown', source),
      original('source-2.md', 'text/markdown', secondSource),
      original('styles/sketchnote/STYLE.md', 'text/markdown', guide),
      original('reference/screenshot-01.png', 'image/png', reference),
    ];
    const request = taskRequest(map, pkg);
    const parse = (inputs: typeof files, browserFilm = false) => {
      const bytes = Buffer.from(JSON.stringify({
        schemaVersion: MAP_DESIGN_WORKSPACE_SCHEMA, runId: pkg.runId, baseRevision: pkg.baseRevision, files: inputs,
      }));
      const task = normalizeTaskRequest({
        ...request,
        envelope: { schemaVersion: 'map-code-film-command-v1', runId: pkg.runId, command: '制作视频',
          ...(browserFilm ? { browserFilm: { target: 180, scenes: 13, trial: true } } : {}) },
        transfer: { ...(request.transfer as object), inputSha256: sha256(bytes),
          allowedOutputPaths: [browserFilm ? 'film-bundle.json' : 'film.mp4', 'film.json'] },
      });
      return parseWorkspacePackage(bytes, task.transfer).files;
    };
    expect(parse(files).map(file => file.bytes)).toEqual([source, secondSource, guide, reference]);
    expect(parse(files, true).map(file => file.bytes)).toEqual([source, secondSource, guide, reference]);
    expect(() => parse([files[0], files[1], files[3]], true)).toThrow('one original STYLE.md');
    const userRequests = Buffer.from('只展示第二部分\n\n不要出现联系方式');
    const brief = original('brief/user-requests.txt', 'text/plain', userRequests);
    expect(parse([...files, brief]).map(file => file.bytes)).toEqual([source, secondSource, guide, reference, userRequests]);
    const creationRequest = Buffer.from('保留完整创作要求。'.repeat(800));
    const longRequest = original('brief/creation-request.txt', 'text/plain', creationRequest);
    expect(parse([...files, brief, longRequest]).at(-1)?.bytes).toEqual(creationRequest);
    expect(() => parse([...files, { ...brief, mediaType: 'text/markdown' }])).toThrow('optional reference images');
    expect(() => parse([files[0], files[1], files[3]])).toThrow('one original STYLE.md');
    expect(() => parse([...files, original('brief/task.json', 'application/json', Buffer.from('{}'))])).toThrow('optional reference images');
  });

  it('keeps real caption timing, clips it to measured duration and ignores malformed cues', () => {
    const captions = parseFilmCaptions('1\n00:00:01,000 --> 00:00:03,600\n<i>架构决定</i>\n\n'
      + '2\n00:00:06,000 --> 00:00:08,000\n超出成片\n\n不合法的字幕', 3);
    expect(captions).toEqual([{ fromSec: 1, toSec: 3, text: '架构决定' }]);
  });

  it('reads the original skill subtitle filename without overlaying its burned captions', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'film-captions-'));
    try {
      const film = path.join(directory, 'review.mp4');
      const sidecar = path.join(directory, 'subtitles_zh-CN.srt');
      const separate = path.join(directory, 'review.srt');
      fs.writeFileSync(separate, '1\n00:00:07,000 --> 00:00:09,000\n先画出边界');
      const captions = [{ fromSec: 7, toSec: 9, text: '先画出边界' }];
      fs.writeFileSync(sidecar, 'invalid');
      expect(readFilmCaptionSidecar(film, 14)).toEqual({ captions, captionsBurnedIn: false });
      fs.copyFileSync(separate, sidecar);
      expect(readFilmCaptionSidecar(film, 14)).toEqual({ captions, captionsBurnedIn: true });
      fs.rmSync(sidecar);
      fs.symlinkSync(separate, sidecar);
      expect(readFilmCaptionSidecar(film, 14)).toEqual({ captions, captionsBurnedIn: false });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('restores a completed narration clip only for matching project owner and original inputs', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'film-project-'));
    try {
      const work = path.join(directory, 'work');
      const next = path.join(directory, 'next');
      fs.mkdirSync(next);
      const project = path.join(work, 'review');
      const voice = path.join(project, 'voice', 'out');
      fs.mkdirSync(voice, { recursive: true });
      fs.writeFileSync(path.join(project, 'TREATMENT.md'), '# Review');
      const clip = Buffer.alloc(46);
      clip.write('RIFF');
      clip.writeUInt32LE(38, 4);
      clip.write('WAVE', 8);
      clip.write('fmt ', 12);
      clip.writeUInt32LE(16, 16);
      clip.writeUInt16LE(1, 20);
      clip.writeUInt16LE(1, 22);
      clip.writeUInt32LE(24000, 24);
      clip.writeUInt32LE(48000, 28);
      clip.writeUInt16LE(2, 32);
      clip.writeUInt16LE(16, 34);
      clip.write('data', 36);
      clip.writeUInt32LE(2, 40);
      fs.writeFileSync(path.join(voice, 'v01.wav'), clip);
      fs.writeFileSync(path.join(voice, 'v02.wav'), clip.subarray(0, 20));
      fs.symlinkSync('v01.wav', path.join(voice, 'external.wav'));
      fs.writeFileSync(path.join(project, '.env'), 'not a checkpoint file');
      const store = new FilmProjectCheckpointStore(path.join(directory, 'checkpoints'));
      const hash = filmProjectInputHash('original', [{ path: 'source-1.md', sha256: 'source' }]);
      expect(store.capture('first', 'owner', hash, work)).toBe(true);
      fs.rmSync(work, { recursive: true });
      expect(store.inspect('first')).toEqual({ completedScenes: 0, narrationClips: 1 });
      expect(store.restore('first', 'someone-else', hash, next)).toBeUndefined();
      expect(store.restore('first', 'owner', 'changed-input', next)).toBeUndefined();
      const restored = store.restore('first', 'owner', hash, next);
      expect(restored?.protectedMedia).toEqual([{ absolute: path.join(next, 'review', 'voice', 'out', 'v01.wav'), sha: sha256(clip), size: 46 }]);
      expect(fs.readFileSync(restored!.protectedMedia[0].absolute)).toEqual(clip);
      expect(fs.readdirSync(path.dirname(restored!.protectedMedia[0].absolute))).toEqual(['v01.wav']);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps partially written browser scenes editable and protects completed scene/audio pairs', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-film-checkpoint-'));
    try {
      const work = path.join(directory, 'work');
      const next = path.join(directory, 'next');
      const root = path.join(work, 'review');
      const scenes = path.join(root, 'scenes');
      const voice = path.join(root, 'voice', 'out');
      fs.mkdirSync(next);
      fs.mkdirSync(scenes, { recursive: true });
      fs.mkdirSync(voice, { recursive: true });
      fs.writeFileSync(path.join(root, 'TREATMENT.md'), '# Review');
      fs.writeFileSync(path.join(root, 'browser-film.json'), '{"scenes":[1,2,3]}');
      const finished = 'export async function prepare(canvas) {} export function renderFrame(canvas, seconds) {}';
      const partial = 'export async function prepare(';
      fs.writeFileSync(path.join(scenes, '1.mjs'), finished);
      fs.writeFileSync(path.join(scenes, '2.mjs'), partial);
      fs.writeFileSync(path.join(scenes, '3.mjs'), finished);
      const clip = Buffer.alloc(46);
      clip.write('RIFF');
      clip.writeUInt32LE(38, 4);
      clip.write('WAVEfmt ', 8);
      clip.writeUInt32LE(16, 16);
      clip.write('data', 36);
      clip.writeUInt32LE(2, 40);
      fs.writeFileSync(path.join(voice, '1.wav'), clip);
      fs.writeFileSync(path.join(voice, '2.wav'), clip);
      const store = new FilmProjectCheckpointStore(path.join(directory, 'checkpoints'));
      expect(store.capture('first', 'owner', 'inputs', work)).toBe(true);
      expect(store.inspect('first')).toEqual({ completedScenes: 1, narrationClips: 2 });
      const restored = store.restore('first', 'owner', 'inputs', next)!;
      expect(restored.protectedMedia.filter(asset => asset.absolute.endsWith('.mjs'))
        .map(asset => path.basename(asset.absolute))).toEqual(['1.mjs']);
      const draft = path.join(restored.root, 'scenes', '2.mjs');
      expect(fs.readFileSync(draft, 'utf8')).toBe(partial);
      fs.writeFileSync(draft, finished);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('accepts the export request for a large committed playback bundle', () => {
    const payload = { html: '<!doctype html>' + 'a'.repeat(35 * 1024 * 1024),
      aac: 'A'.repeat(13 * 1024 * 1024), durationSec: 600 };
    expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThan(MAX_BROWSER_FILM_EXPORT_REQUEST_BYTES);
    expect(parseBrowserFilmExport(payload)).toEqual(payload);
    expect(() => parseBrowserFilmExport({ ...payload, durationSec: 691 })).toThrow('input is invalid');
  });

  it('identifies one missing scene and keeps all completed clips beyond the former 16 MiB checkpoint ceiling', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'film-scene-'));
    try {
      const work = path.join(directory, 'work');
      const next = path.join(directory, 'next');
      fs.mkdirSync(next);
      const project = path.join(work, 'review');
      const scenes = path.join(project, 'scenes');
      fs.mkdirSync(scenes, { recursive: true });
      fs.writeFileSync(path.join(project, 'TREATMENT.md'), '# Review');
      fs.writeFileSync(path.join(scenes, 'plan.json'), '[1,2,3,4,5,6]');
      const box = (tag: string) => {
        const value = Buffer.alloc(12);
        value.writeUInt32BE(value.length);
        value.write(tag, 4);
        return value;
      };
      const media = Buffer.alloc(4 * 1024 * 1024);
      media.writeUInt32BE(media.length);
      media.write('mdat', 4);
      const movie = Buffer.concat([box('ftyp'), media, box('moov')]);
      for (const index of [1, 2, 3, 5, 6]) fs.writeFileSync(path.join(scenes, `${index}.mp4`), movie);
      fs.writeFileSync(path.join(scenes, '4.mp4'), movie.subarray(0, movie.length - 12));
      const store = new FilmProjectCheckpointStore(path.join(directory, 'checkpoints'));
      expect(store.capture('first', 'owner', 'inputs', work)).toBe(true);
      expect(store.inspect('first')).toEqual({ completedScenes: 5, narrationClips: 0, incompleteScene: 4 });
      const restored = store.restore('first', 'owner', 'inputs', next)!;
      expect(FilmProjectCheckpointStore.hasCompletedScene(restored.root, 4)).toBe(false);
      fs.writeFileSync(path.join(restored.root, 'scenes', '4.mp4'), movie);
      expect(FilmProjectCheckpointStore.hasCompletedScene(restored.root, 4)).toBe(true);
      expect(restored.protectedMedia.map(file => file.sha)).toEqual(Array(5).fill(sha256(movie)));
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('accepts only the configured direct LLMGW authority and binds its identity to the task', async () => {
    const pkg = buildPackage([]);
    map = await startFakeMap(pkg);
    const direct = taskRequest(map, pkg, {
      model: {
        baseUrl: 'http://gateway/gw/v1',
        protocol: 'openai',
        apiKey: 'run-scoped-grant',
        model: 'default-chat-curated',
        sourceSystem: 'map',
        appCallerCode: 'prd-agent-web.web-hosting.generate-html::chat',
        userId: 'user-1',
        runId: pkg.runId,
      },
    });

    const normalized = normalizeTaskRequest(direct, 'http://gateway/gw/v1');

    expect(normalized.model).toMatchObject({
      baseUrl: 'http://gateway/gw/v1',
      sourceSystem: 'map',
      appCallerCode: 'prd-agent-web.web-hosting.generate-html::chat',
      userId: 'user-1',
      runId: pkg.runId,
    });
    expect(() => normalizeTaskRequest({
      ...direct,
      model: { ...(direct.model as object), baseUrl: 'https://other-internal.example/gw/v1' },
    }, 'http://gateway/gw/v1')).toThrow(/configured LLMGW endpoint/);
    expect(() => normalizeTaskRequest({
      ...direct,
      model: { ...(direct.model as object), runId: 'another-run' },
    }, 'http://gateway/gw/v1')).toThrow(/model.runId must equal taskId/);
  });

  it('runs a task end to end, streams status / text_delta / done, commits to MAP and empties every task directory', async () => {
    harness = await startHarness();
    const pkg = buildPackage([{ path: 'knowledge/source.md', content: 'Product overview for the launch.', mediaType: 'text/markdown' }]);
    map = await startFakeMap(pkg);
    let workspaceDuringRun: string[] = [];
    harness.daemon.onRun = (context) => {
      if (context.index === 1) workspaceDuringRun = fs.readdirSync(context.workspaceDir).sort();
      return writesGoodPage(context);
    };
    const tokenBefore = harness.daemon.current()!.apiToken;

    const submitted = await harness.request('POST', '/v1/tasks', taskRequest(map, pkg), auth);
    expect(submitted.status).toBe(202);
    expect(submitted.body.task).toMatchObject({ taskId: 'map-run-1', attempt: 1, state: 'running' });

    // SSE：从头读到终态，连接随任务结束自然关闭。
    const stream = await fetch(`${harness.baseUrl}/v1/tasks/map-run-1/events?afterSeq=0`, {
      headers: { ...auth, Accept: 'text/event-stream' },
    });
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    const raw = await stream.text();
    const frames = raw.split('\n\n').filter((frame) => frame.includes('data: ') && !frame.includes('event: keepalive'));
    const events = frames.map((frame) => JSON.parse(frame.slice(frame.indexOf('data: ') + 6)));
    expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index + 1));
    expect(events.map((event) => event.type)).toContain('status');
    expect(events.map((event) => event.type)).toContain('text_delta');
    const done = events.at(-1);
    expect(done.type).toBe('done');
    expect(done.payload).toMatchObject({
      artifactRef: 'map://design-artifact/map-run-1/result',
      openDesignRunId: 'od-run-2',
    });
    expect(done.payload.resultSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(done.payload.files.map((file: { path: string }) => file.path)).toEqual([
      'assets/accessibility-static-report.json', 'assets/design-tokens.json', 'assets/page-outline.json',
      'assets/provenance.json', 'assets/quality/attempt-0-desktop.png', 'assets/quality/attempt-0-mobile.png',
      'assets/visual-quality-report.json', 'index.html', 'manifest.json',
    ]);
    // 与 CDS 回传给 MAP 的阶段名一致，MAP 的 OpenDesignStageProgress 能直接认。
    const reasons = events.filter((event) => event.type === 'status').map((event) => event.payload.reason);
    expect(reasons).toEqual(expect.arrayContaining([
      'task_accepted', 'workspace_downloading', 'workspace_materialized', 'open_design_importing',
      'open_design_run_starting', 'open_design_running', 'open_design_reviewing', 'workspace_collecting',
      'deliverable_entry_resolved', 'workspace_committing',
    ]));

    // MAP 收到的是同一个结果包，工作区里铺好的是任务包与平台模板。
    expect(map.commits).toHaveLength(1);
    expect(map.commits[0]).toMatchObject({ schemaVersion: 'map-design-workspace-v1', sessionId: 'map-run-1', runId: 'map-run-1', baseRevision: 'rev-1' });
    expect(workspaceDuringRun).toEqual(['.od-skills', 'brief', 'knowledge']);
    // 第一轮指令就是 MAP 的任务信封原文。
    expect(JSON.parse(String(harness.daemon.runBodies[0].message))).toEqual(taskRequest(map, pkg).envelope);
    expect(harness.daemon.runBodies[0]).toMatchObject({ agentId: 'codex', model: 'map-managed', projectId: 'od-project' });

    // 隔离方案 A：任务结束后四个目录全部清空，引擎以新令牌重新拉起。
    await cleanedUp(harness, 'map-run-1');
    expect(taskDirectoriesAreEmpty(harness)).toBe(true);
    expect(harness.daemon.current()!.apiToken).not.toBe(tokenBefore);
    expect(harness.daemon.freezes).toBe(harness.daemon.thaws);
    const capabilities = await harness.request('GET', '/v1/capabilities');
    expect(capabilities.body).toMatchObject({ healthy: true, busy: false, acceptingTasks: true });
  });

  it('returns 409 with retryAfterSeconds while another task occupies the only slot', async () => {
    harness = await startHarness();
    const pkg = buildPackage([]);
    map = await startFakeMap(pkg);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    harness.daemon.onRun = async (context) => {
      if (context.index === 1) await held;
      return writesGoodPage(context);
    };
    expect((await harness.request('POST', '/v1/tasks', taskRequest(map, pkg), auth)).status).toBe(202);
    await waitFor(() => harness!.daemon.runBodies.length === 1, 'first run to start');
    const other = buildPackage([], { runId: 'map-run-2' });
    const busy = await harness.request('POST', '/v1/tasks', taskRequest(map, other), auth);
    expect(busy.status).toBe(409);
    expect(busy.body.error.code).toBe('executor_busy');
    expect(busy.body.retryAfterSeconds).toBeGreaterThan(0);
    expect(busy.headers.get('retry-after')).toBe(String(busy.body.retryAfterSeconds));
    expect(busy.body.error.message.startsWith('本服务正在执行另一个设计任务')).toBe(true);
    const capabilities = await harness.request('GET', '/v1/capabilities');
    expect(capabilities.body).toMatchObject({ busy: true, acceptingTasks: false, state: 'running', healthy: true });
    release();
    await cleanedUp(harness, 'map-run-1');
  });

  it('treats a repeated submission of the same taskId as idempotent and a different payload as a conflict', async () => {
    harness = await startHarness();
    const pkg = buildPackage([]);
    map = await startFakeMap(pkg);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    harness.daemon.onRun = async (context) => {
      if (context.index === 1) await held;
      return writesGoodPage(context);
    };
    const first = await harness.request('POST', '/v1/tasks', taskRequest(map, pkg), auth);
    expect(first.status).toBe(202);
    const again = await harness.request('POST', '/v1/tasks', taskRequest(map, pkg), auth);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ replayed: true, task: { taskId: 'map-run-1', attempt: 1, state: 'running' } });
    const changed = await harness.request('POST', '/v1/tasks', taskRequest(map, pkg, { timeoutSeconds: 120 }), auth);
    expect(changed.status).toBe(409);
    expect(changed.body.error.code).toBe('task_id_conflict');
    // 只有一次输入下载、一次引擎导入：重复提交没有产生第二次执行。
    release();
    await cleanedUp(harness, 'map-run-1');
    expect(map.inputRequests).toBe(1);
    expect(harness.daemon.imports).toHaveLength(1);
    const afterDone = await harness.request('POST', '/v1/tasks', taskRequest(map, pkg), auth);
    expect(afterDone.status).toBe(200);
    expect(afterDone.body.task.state).toBe('succeeded');
    const retrySucceeded = await harness.request('POST', '/v1/tasks', taskRequest(map, pkg, { attempt: 2 }), auth);
    expect(retrySucceeded.status).toBe(409);
    expect(retrySucceeded.body.error.code).toBe('task_already_succeeded');
  });

  it('resumes the event log from afterSeq in one-shot JSON mode', async () => {
    harness = await startHarness();
    const pkg = buildPackage([]);
    map = await startFakeMap(pkg);
    harness.daemon.onRun = writesGoodPage;
    await harness.request('POST', '/v1/tasks', taskRequest(map, pkg), auth);
    await terminalView(harness, 'map-run-1');
    const all = await harness.request('GET', '/v1/tasks/map-run-1/events', undefined, auth);
    expect(all.body).toMatchObject({ taskId: 'map-run-1', state: 'succeeded', terminal: true });
    const total = all.body.events.length;
    expect(total).toBeGreaterThan(5);
    const tail = await harness.request('GET', `/v1/tasks/map-run-1/events?afterSeq=${total - 2}`, undefined, auth);
    expect(tail.body.events.map((event: { seq: number }) => event.seq)).toEqual([total - 1, total]);
    expect(tail.body.events.at(-1).type).toBe('done');
    expect((await harness.request('GET', '/v1/tasks/unknown-task/events', undefined, auth)).status).toBe(404);
  });

  it('cancels a running task, cancels the OpenDesign run, reports task_cancelled and still empties the workspace', async () => {
    harness = await startHarness();
    const pkg = buildPackage([]);
    map = await startFakeMap(pkg);
    harness.daemon.onRun = (context) => new Promise((resolve) => {
      fs.writeFileSync(path.join(context.workspaceDir, 'index.html'), GOOD_PAGE);
      context.signal.addEventListener('abort', () => resolve({ status: 'failed' }));
    });
    await harness.request('POST', '/v1/tasks', taskRequest(map, pkg), auth);
    await waitFor(() => harness!.daemon.runBodies.length === 1, 'first run to start');
    const cancelled = await harness.request('POST', '/v1/tasks/map-run-1/cancel', undefined, auth);
    expect(cancelled.status).toBe(200);
    const view = await terminalView(harness, 'map-run-1');
    expect(view.state).toBe('cancelled');
    expect(view.error.code).toBe('task_cancelled');
    expect(view.error.message.startsWith('调用方（MAP）请求取消了这次设计任务')).toBe(true);
    expect(harness.daemon.cancels).toContain('od-run-1');
    expect(map.commits).toHaveLength(0);
    await cleanedUp(harness, 'map-run-1');
    expect(taskDirectoriesAreEmpty(harness)).toBe(true);
    // 已结束的任务再取消：原样返回，不报错。
    const again = await harness.request('POST', '/v1/tasks/map-run-1/cancel', undefined, auth);
    expect(again.body.task.state).toBe('cancelled');
    // 取消之后允许以更大的 attempt 重新提交同一个 taskId。
    harness.daemon.onRun = writesGoodPage;
    const retry = await harness.request('POST', '/v1/tasks', taskRequest(map, pkg, { attempt: 2 }), auth);
    expect(retry.status).toBe(202);
    const finished = await terminalView(harness, 'map-run-1');
    expect(finished).toMatchObject({ attempt: 2, state: 'succeeded' });
    const events = (await harness.request('GET', '/v1/tasks/map-run-1/events', undefined, auth)).body.events;
    expect(events.map((event: { seq: number }) => event.seq)).toEqual(events.map((_: unknown, index: number) => index + 1));
    expect(new Set(events.map((event: { attempt: number }) => event.attempt))).toEqual(new Set([1, 2]));
  });

  it('fails a task that exceeds its timeout and still empties the workspace', async () => {
    harness = await startHarness();
    const pkg = buildPackage([]);
    map = await startFakeMap(pkg);
    harness.daemon.onRun = (context) => new Promise((resolve) => {
      context.signal.addEventListener('abort', () => resolve({ status: 'failed' }));
    });
    const request = normalizeTaskRequest(taskRequest(map, pkg));
    // 协议下限是 30 秒；这里直接交给任务槽一个 1 秒的超时，验证的是同一条超时路径。
    const outcome = harness.runtime.tasks.submit({ ...request, timeoutSeconds: 1 });
    expect(outcome.kind).toBe('accepted');
    const view = await terminalView(harness, 'map-run-1');
    expect(view.state).toBe('failed');
    expect(view.error.code).toBe('open_design_run_timeout');
    expect(harness.daemon.cancels).toContain('od-run-1');
    await cleanedUp(harness, 'map-run-1');
    expect(taskDirectoriesAreEmpty(harness)).toBe(true);
  });

  it('reports a failed run with a redacted error and empties the workspace', async () => {
    harness = await startHarness();
    const pkg = buildPackage([]);
    map = await startFakeMap(pkg);
    harness.daemon.onRun = () => ({ status: 'failed', error: 'model call rejected token=model-ticket-secret' });
    await harness.request('POST', '/v1/tasks', taskRequest(map, pkg), auth);
    const view = await terminalView(harness, 'map-run-1');
    expect(view.state).toBe('failed');
    expect(view.error.code).toBe('open_design_run_failed');
    expect(JSON.stringify(view.error)).not.toContain('model-ticket-secret');
    await cleanedUp(harness, 'map-run-1');
    expect(taskDirectoriesAreEmpty(harness)).toBe(true);
  });

  it('does not let the next task see anything the previous task wrote', async () => {
    harness = await startHarness();
    const first = buildPackage([{ path: 'knowledge/secret.md', content: 'First tenant private notes.', mediaType: 'text/markdown' }]);
    map = await startFakeMap(first);
    harness.daemon.onRun = (context) => {
      fs.writeFileSync(path.join(context.workspaceDir, 'scratch-note.txt'), 'left behind by task one');
      return writesGoodPage(context);
    };
    // scratch-note.txt 不在白名单里：第一个任务会因此失败，但文件必须随清空一起消失。
    await harness.request('POST', '/v1/tasks', taskRequest(map, first), auth);
    await cleanedUp(harness, 'map-run-1');
    await map.close();

    const second = buildPackage([], { runId: 'map-run-2' });
    map = await startFakeMap(second);
    let seen: string[] = [];
    harness.daemon.onRun = (context) => {
      if (context.index === harness!.daemon.runBodies.length && seen.length === 0) seen = fs.readdirSync(context.workspaceDir).sort();
      return { status: 'succeeded' };
    };
    await harness.request('POST', '/v1/tasks', taskRequest(map, second), auth);
    await terminalView(harness, 'map-run-2');
    expect(seen).toEqual(['.od-skills', 'brief']);
    expect(seen).not.toContain('scratch-note.txt');
    expect(seen).not.toContain('knowledge');
  });

  it('rejects malformed requests before touching MAP or the engine', async () => {
    harness = await startHarness();
    const pkg = buildPackage([]);
    map = await startFakeMap(pkg);
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ taskId: '../escape' }, 'task_request_invalid'],
      [{ envelope: { ...taskRequest(map, pkg).envelope, runId: 'someone-else' } }, 'task_request_invalid'],
      [{ model: { ...taskRequest(map, pkg).model, baseUrl: 'http://127.0.0.1:1/llm/v1' } }, 'model_authority_origin_mismatch'],
      [{ timeoutSeconds: 5 }, 'task_request_invalid'],
      [{ transfer: { ...taskRequest(map, pkg).transfer, inputPackageUrl: `${map.origin}/input?token=leak` } }, 'workspace_transfer_invalid'],
    ];
    for (const [override, code] of cases) {
      const response = await harness.request('POST', '/v1/tasks', taskRequest(map, pkg, override), auth);
      expect(response.status, JSON.stringify(override)).toBe(400);
      expect(response.body.error.code).toBe(code);
    }
    expect(map.inputRequests).toBe(0);
    expect(harness.daemon.imports).toHaveLength(0);
  });
});

describe('engine process supervision', () => {
  it('fails the running task when the engine dies, reports it in capabilities, and recovers with a clean restart', async () => {
    harness = await startHarness();
    const pkg = buildPackage([]);
    map = await startFakeMap(pkg);
    harness.daemon.onRun = () => new Promise(() => undefined);
    await harness.request('POST', '/v1/tasks', taskRequest(map, pkg), auth);
    await waitFor(() => harness!.daemon.runBodies.length === 1, 'first run to start');
    const startsBefore = harness.daemon.starts;
    await harness.daemon.crash();
    const view = await terminalView(harness, 'map-run-1');
    expect(view.state).toBe('failed');
    expect(view.error.code).toBe('open_design_engine_exited');
    expect(view.error.message.startsWith('OpenDesign 引擎进程在')).toBe(true);
    await cleanedUp(harness, 'map-run-1');
    expect(harness.daemon.starts).toBe(startsBefore + 1);
    const capabilities = await harness.request('GET', '/v1/capabilities');
    expect(capabilities.body.engineProcess.unexpectedExitsInLast10Minutes).toBe(1);
    expect(capabilities.body.engineProcess.lastUnexpectedExitAt).toBeTruthy();
    expect(capabilities.body.healthy).toBe(true);
  });

  it('restarts an idle engine that died on its own instead of silently reporting it healthy', async () => {
    harness = await startHarness();
    const startsBefore = harness.daemon.starts;
    await harness.daemon.crash();
    const during = await harness.request('GET', '/v1/capabilities');
    expect(during.body.engineProcess.unexpectedExitsInLast10Minutes).toBe(1);
    await waitFor(() => harness!.daemon.starts === startsBefore + 1 && harness!.runtime.tasks.slotState() === 'idle', 'engine restart');
    expect((await harness.request('GET', '/v1/capabilities')).body.healthy).toBe(true);
  });

  it('restarts again when the fresh engine exits right after the reset health check', async () => {
    harness = await startHarness();
    const lifecycle = harness.runtime.lifecycle;
    const originalReset = lifecycle.reset.bind(lifecycle);
    let exitAfterNextReset = true;
    lifecycle.reset = async () => {
      await originalReset();
      if (exitAfterNextReset) {
        exitAfterNextReset = false;
        // 健康检查已通过、槽位还是 resetting 的那一刻引擎自己退出。
        await harness!.daemon.crash();
      }
    };
    const startsBefore = harness.daemon.starts;
    await harness.daemon.crash();
    await waitFor(
      () => harness!.runtime.tasks.slotState() === 'idle' && harness!.daemon.current() !== null,
      'engine to be running again once the slot is idle',
    );
    expect(harness.daemon.starts).toBe(startsBefore + 2);
    expect((await harness.request('GET', '/v1/capabilities')).body.healthy).toBe(true);
  });

  it('blocks new tasks while the workspace cannot be emptied, and says so', async () => {
    harness = await startHarness();
    // 把输出目录换成一个文件：清空它会失败，reset 失败即槽位 blocked。
    fs.rmSync(harness.config.outputDir, { recursive: true, force: true });
    fs.writeFileSync(harness.config.outputDir, 'not a directory');
    await harness.daemon.crash();
    await waitFor(() => harness!.runtime.tasks.slotState() === 'blocked', 'slot to block');
    const capabilities = await harness.request('GET', '/v1/capabilities');
    expect(capabilities.body.healthy).toBe(false);
    expect(capabilities.body.reason.code).toBe('workspace_reset_failed');
    expect(capabilities.body.reason.message.startsWith('本服务在上一个任务结束后清空工作目录')).toBe(true);
    const pkg = buildPackage([]);
    map = await startFakeMap(pkg);
    const submit = await harness.request('POST', '/v1/tasks', taskRequest(map, pkg), auth);
    expect(submit.status).toBe(503);
    expect(submit.body.error.code).toBe('workspace_reset_failed');
    // 修好之后自动重试成功，恢复接单。
    fs.rmSync(harness.config.outputDir, { force: true });
    await waitFor(() => harness!.runtime.tasks.slotState() === 'idle', 'slot to recover');
  });
});
