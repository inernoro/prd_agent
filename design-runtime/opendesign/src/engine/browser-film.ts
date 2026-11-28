import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { AgentWorkspaceRuntimeError } from '../errors.js';
import { readRegularFileNoFollow } from '../workspace/output-preflight.js';
import { sha256 } from '../workspace/primitives.js';
import type { WorkspacePackageFile } from '../workspace/transfer.js';
import { parseFilmCaptions } from './code-film.js';

const exec = promisify(execFile);
const MiB = 1024 * 1024;
const unsafeAnimation = /\b(?:Date\.now|performance\.now|Math\.random|requestAnimationFrame|fetch|XMLHttpRequest|WebSocket|localStorage|sessionStorage|indexedDB|importScripts)\b/;

export function isValidBrowserSceneProgram(code: Buffer): boolean {
  if (code.length === 0 || code.length > 2 * MiB || unsafeAnimation.test(code.toString('utf8'))) return false;
  // 检查模块语法，不加载或执行用户产出的模块。
  return spawnSync(process.execPath, ['--input-type=module', '--check'], {
    input: code, timeout: 2000, env: {}, stdio: ['pipe', 'ignore', 'ignore'],
  }).status === 0;
}

export function makeBrowserFilmContract(target: number, scenes: number, trial: boolean) {
  return {
    mode: trial ? 'trial' : 'complete', targetSeconds: target, expectedScenes: scenes,
    delivery: 'Organize a playable project with the original style and skill. Render the user\'s source as deterministic Canvas frames and audio assets. Do not encode or render video on the server.',
    projectFolder: '<film-slug>', treatment: 'TREATMENT.md',
    deliverables: {
      readyManifest: 'browser-film.json (JSON object: { "scenes": number[] } in exact consecutive 1-based playback order)',
      sceneModule: 'scenes/<number>.mjs (self-contained ES module, exports async prepare(canvas) and renderFrame(canvas, seconds); preload any assets from data URLs. No I/O, clocks, random, or animation loops.)',
      voiceFile: 'voice/out/<number>.wav (natural narration and any soundtrack for that scene, already aligned)',
      captions: 'subtitles_zh.srt (complete timed subtitle cues synchronized to the delivered narration. For a silent title, the voice WAV still sets its actual duration.)',
    },
    canvas: { width: 1920, height: 1080, fps: 24 },
    required: trial ? 'Deliver only the complete title and first content scene. Stop after these two scenes and their audio. The next approved run will resume the project.'
      : 'Deliver all scenes and the complete narration. Preserve any completed source modules and WAV tracks from the checkpoint. Agent writes the project files, the application packages playback.',
  };
}

function invalid(message: string): never {
  throw new AgentWorkspaceRuntimeError('design_output_invalid', message);
}

function regular(file: string, maxBytes: number) {
  if (fs.realpathSync(file) !== file) invalid('Browser film contains a linked output');
  return readRegularFileNoFollow(file, maxBytes);
}

export function parseBrowserFilmSceneIndexes(text: string): number[] | undefined {
  try {
    const manifest = JSON.parse(text) as { scenes?: unknown } | null;
    const scenes = manifest?.scenes;
    if (Array.isArray(scenes) && scenes.length > 0 && scenes.length <= 40
        && scenes.every((value, index) => value === index + 1)) return scenes;
  } catch {
    // A partially written manifest cannot certify completed scenes.
  }
  return undefined;
}

export function findBrowserFilm(workspace: string): { root: string; indexes: number[] } | undefined {
  const roots = fs.readdirSync(workspace, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^[a-z0-9][a-z0-9-]{0,79}$/.test(entry.name))
    .map(entry => path.join(workspace, entry.name))
    .filter(root => fs.lstatSync(path.join(root, 'browser-film.json'), { throwIfNoEntry: false })?.isFile());
  if (!roots.length) return undefined;
  if (roots.length !== 1) invalid('Provide one browser film project');
  const root = roots[0];
  const indexes = parseBrowserFilmSceneIndexes(regular(path.join(root, 'browser-film.json'), 8 * 1024).toString('utf8'));
  if (!indexes) invalid('Browser film scene order is invalid');
  return { root, indexes };
}

function file(path: string, mediaType: string, bytes: Buffer): WorkspacePackageFile {
  return { path, mediaType, size: bytes.length, sha256: sha256(bytes), contentBase64: bytes.toString('base64') };
}

export async function packageBrowserFilm(project: { root: string; indexes: number[] }, target: number,
    trial: boolean, signal: AbortSignal): Promise<WorkspacePackageFile[]> {
  if (trial && project.indexes.length !== 2) invalid('Trial must contain the title and first scene');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'map-film-audio-'));
  try {
    const scenes: Array<{ code: string; durationSec: number }> = [];
    const formats = { aac: ['-c:a', 'aac', '-b:a', '96k', '-f', 'mp4'], opus: ['-c:a', 'libopus', '-b:a', '64k', '-f', 'webm'] };
    const options = { signal, timeout: 75_000, maxBuffer: 128 * 1024 };
    let elapsed = 0;
    const concat: string[] = [];
    for (const index of project.indexes) {
      const code = regular(path.join(project.root, 'scenes', `${index}.mjs`), 2 * MiB);
      if (!isValidBrowserSceneProgram(code)) invalid(`Scene ${index} has invalid browser animation code`);
      const wav = regular(path.join(project.root, 'voice', 'out', `${index}.wav`), 16 * MiB);
      if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') invalid(`Scene ${index} has no valid narration`);
      const input = path.join(scratch, `${index}.wav`);
      const pcm = path.join(scratch, `${index}-normalized.wav`);
      fs.writeFileSync(input, wav, { flag: 'wx' });
      await exec('ffmpeg', ['-v', 'error', '-nostdin', '-protocol_whitelist', 'file,pipe', '-i', input,
        '-map', '0:a:0', '-vn', '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', pcm], options);
      const probe = await exec('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file,pipe',
        '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', pcm], options);
      const durationSec = Number(probe.stdout.trim());
      if (!Number.isFinite(durationSec) || durationSec <= 0 || durationSec > 180) invalid(`Scene ${index} has invalid audio timing`);
      elapsed += durationSec;
      scenes.push({ code: code.toString('base64'), durationSec });
      concat.push(`file '${index}-normalized.wav'`);
    }
    if (trial ? elapsed < 12 || elapsed > 45 : Math.abs(elapsed - target) > target * 0.15)
      invalid(`The verified audio lasts ${Math.round(elapsed)} seconds, outside the requested ${trial ? 'trial' : 'film'} duration`);
    fs.writeFileSync(path.join(scratch, 'concat.txt'), concat.join('\n'), { flag: 'wx' });
    const encode = async (format: keyof typeof formats) => {
      const audioName = `${format}.audio`;
      await exec('ffmpeg', ['-v', 'error', '-nostdin', '-protocol_whitelist', 'file,pipe',
        '-f', 'concat', '-safe', '1', '-i', path.join(scratch, 'concat.txt'), '-map', '0:a:0', '-vn',
        ...formats[format], path.join(scratch, audioName)], options);
      return regular(path.join(scratch, audioName), 12 * MiB);
    };
    const [aac, opus] = await Promise.all([encode('aac'), encode('opus')]);
    const captions = parseFilmCaptions(regular(path.join(project.root, 'subtitles_zh.srt'), 128 * 1024).toString('utf8'), elapsed);
    if (!captions.length) invalid('Browser film is missing timed captions');
    const metadata = { durationSec: elapsed, hasAudio: true, captionsBurnedIn: false, hasSubtitleFreePreview: false, captions };
    const bundle = { version: 1, width: 1920, height: 1080, fps: 24, durationSec: elapsed, scenes,
      aac: aac.toString('base64'), opus: opus.toString('base64'), captions };
    return [file('film-bundle.json', 'application/json', Buffer.from(JSON.stringify(bundle))),
      file('film.json', 'application/json', Buffer.from(JSON.stringify(metadata)))];
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
