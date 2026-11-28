import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { AgentWorkspaceRuntimeError } from '../errors.js';
import { OPEN_DESIGN_CODEX_HOME_RELATIVE } from '../prompts.js';
import { readRegularFileNoFollow } from '../workspace/output-preflight.js';
import { sha256 } from '../workspace/primitives.js';
import type { WorkspacePackageFile } from '../workspace/transfer.js';

export const CODE_FILM_SKILL_ID = 'lemo-opuscar';
const SKILL_SOURCE = '/opt/map-design-runtime/lemo-opuscar';
const LIBRARY_SOURCE = '/opt/map-design-runtime/opuscar-library';
const LIBRARY_REVISION = '439b98af08b04400f8fd8a8dd19cd773c0c96532';
const WATERCOLOR_DEMO_SHA256 = 'bc140bd92ec602768416503d5954c1997810f35f936f6810f755104eedf76e18';

function codeFilmLibraryDirectory(dataDir: string): string {
  return path.join(path.dirname(path.join(dataDir, OPEN_DESIGN_CODEX_HOME_RELATIVE)), 'lemo-opuscar');
}
const SKILL_FILES = {
  'SKILL.md': '17c2f1c2a337becf28ec1e23eec46b42a6f0ffa2691b40d8b97b35d043b79f65',
  'scripts/setup.sh': '6b5e39efe99e42d671edb365e11b89d065ccda7188a45e81fe5757f5f46661be',
} as const;

function codexSkillDirectory(dataDir: string): string {
  return path.join(dataDir, OPEN_DESIGN_CODEX_HOME_RELATIVE, 'skills', CODE_FILM_SKILL_ID);
}

export function registerCodeFilmSkill(dataDir: string, chownForEngine: (target: string) => void): void {
  // Register on the coding agent's native surface. OpenDesign's catalogue
  // classifies the upstream guide as an image skill because it mentions an
  // image generator for other styles, then enforces direct media dispatch.
  const target = codexSkillDirectory(dataDir);
  for (const [file, digest] of Object.entries(SKILL_FILES)) {
    const bytes = readRegularFileNoFollow(path.join(SKILL_SOURCE, file), 1024 * 1024);
    if (sha256(bytes) !== digest) {
      throw new AgentWorkspaceRuntimeError('code_film_skill_invalid', 'Lemo-Opuscar skill does not match its upstream revision');
    }
    const output = path.join(target, file);
    fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o755 });
    fs.writeFileSync(output, bytes, { flag: 'wx', mode: 0o644 });
  }
  // The original setup script looks for the library in this task's HOME.
  // Each job can install its own dependencies without changing the image or
  // leaving files visible to later jobs.
  fs.cpSync(LIBRARY_SOURCE, codeFilmLibraryDirectory(dataDir), {
    recursive: true, force: false, errorOnExist: true, mode: fs.constants.COPYFILE_FICLONE,
  });
  chownForEngine(path.join(dataDir, 'sandbox'));
}

export function verifyCodeFilmInput(
  dataDir: string,
  workspaceDir: string,
  inputs: ReadonlyArray<{ path: string; sha256: string; size: number }>,
): Record<string, unknown> {
  const staged = codexSkillDirectory(dataDir);
  for (const [file, digest] of Object.entries(SKILL_FILES)) {
    if (sha256(readRegularFileNoFollow(path.join(staged, file), 1024 * 1024)) !== digest) {
      throw new AgentWorkspaceRuntimeError('code_film_skill_not_loaded', 'The Codex skill directory did not retain the original Lemo-Opuscar skill');
    }
  }
  for (const input of inputs) {
    const actual = sha256(readRegularFileNoFollow(path.join(workspaceDir, input.path), input.size));
    if (actual !== input.sha256) {
      throw new AgentWorkspaceRuntimeError('workspace_input_changed', 'The original material inside the OpenDesign workspace changed');
    }
  }
  const demoPath = path.join(codeFilmLibraryDirectory(dataDir), 'styles/watercolor/DEMO.md');
  if (sha256(readRegularFileNoFollow(demoPath, 128 * 1024)) !== WATERCOLOR_DEMO_SHA256) {
    throw new AgentWorkspaceRuntimeError('code_film_library_changed', 'The pinned Lemo-Opuscar library is incomplete or has changed');
  }
  return { skillId: CODE_FILM_SKILL_ID, skillSha256: SKILL_FILES['SKILL.md'],
    libraryRevision: LIBRARY_REVISION, watercolorDemoSha256: WATERCOLOR_DEMO_SHA256,
    sourceSha256: inputs[0]?.sha256, inputHashes: inputs.map(input => ({ path: input.path, sha256: input.sha256 })) };
}

/**
 * The authorized isolated run may submit one round of the form's own
 * recommended radio answers. Use safe field/option identifiers and never
 * promote arbitrary assistant prose into the user's reply.
 */
export function codeFilmDefaultAnswers(content: string): string | undefined {
  const formBlocks = [...content.matchAll(/<(question-form|ask-question)\b([^>]{0,512})>\s*([\s\S]{1,8192}?)\s*<\/\1>/gi)];
  if (formBlocks.length !== 1) return undefined;
  const [, , attributes, body] = formBlocks[0];
  let candidate: unknown;
  try {
    candidate = JSON.parse(body.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, ''));
  } catch {
    return undefined;
  }
  if (!candidate || typeof candidate !== 'object') return undefined;
  const form = candidate as Record<string, unknown>;
  const token = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,64}$/.test(value);
  const questions = Array.isArray(candidate) ? candidate : form.questions;
  const id = /(?:^|\s)id=(?:"([^"]+)"|'([^']+)')/i.exec(attributes);
  const candidateId = id?.[1] ?? id?.[2] ?? form.id;
  const formId = token(candidateId) ? candidateId : 'discovery';
  if (!Array.isArray(questions) || questions.length < 1 || questions.length > 6) return undefined;
  const values = new Map<string, string>();
  for (const entry of questions) {
    if (!entry || typeof entry !== 'object') return undefined;
    const field = entry as Record<string, unknown>;
    if (!token(field.id) || values.has(field.id)) return undefined;
    // OpenDesign's untouched optional free-text fields are submitted as skipped.
    // A required free-text question needs an actual user answer.
    if (field.type === 'text' || field.type === 'textarea') {
      if (field.required === true) return undefined;
      values.set(field.id, '(skipped)');
      continue;
    }
    if ((field.type !== 'radio' && field.type !== 'select') || !token(field.defaultValue)
        || !Array.isArray(field.options)
        || !field.options.some(option => option && option.value === field.defaultValue)) return undefined;
    values.set(field.id, field.defaultValue);
  }
  return [`[form answers — ${formId}]`, ...[...values].map(([field, value]) => `- ${field}: ${value}`)].join('\n');
}

export function collectCodeFilm(workspaceDir: string, maxOutputBytes: number): { film: WorkspacePackageFile; source: string } | undefined {
  // Upstream writes <name>/<name>.mp4. Accept that and a plain root MP4.
  // Restrict the scan to that shape. Skip references, symlinks and render intermediates.
  const candidates: string[] = [];
  for (const entry of fs.readdirSync(workspaceDir, { withFileTypes: true })) {
    if (entry.isFile() && /^[a-z0-9][a-z0-9_-]*\.mp4$/i.test(entry.name)) {
      candidates.push(path.join(workspaceDir, entry.name));
    }
    if (!entry.isDirectory() || !/^[a-z0-9][a-z0-9-]*$/.test(entry.name)) continue;
    const candidate = path.join(workspaceDir, entry.name, entry.name + '.mp4');
    if (fs.lstatSync(candidate, { throwIfNoEntry: false })?.isFile()) candidates.push(candidate);
  }
  if (candidates.length === 0) return undefined;
  if (candidates.length !== 1) {
    throw new AgentWorkspaceRuntimeError(
      'design_output_missing',
      'OpenDesign must deliver exactly one final MP4 at the project root or in its named film folder',
    );
  }
  const candidate = candidates[0];
  if (fs.realpathSync(candidate) !== candidate) {
    throw new AgentWorkspaceRuntimeError('design_output_invalid', 'The film is not a regular workspace file');
  }
  const bytes = readRegularFileNoFollow(candidate, Math.floor(maxOutputBytes * 0.75) - 4096);
  if (bytes.length < 32 || bytes.toString('ascii', 4, 8) !== 'ftyp') {
    throw new AgentWorkspaceRuntimeError('design_output_invalid', 'OpenDesign did not return a valid MP4 container');
  }
  return {
    film: {
      path: 'film.mp4', mediaType: 'video/mp4', size: bytes.length,
      sha256: sha256(bytes), contentBase64: bytes.toString('base64'),
    },
    source: candidate,
  };
}

export function parseFilmCaptions(text: string, durationSec: number) {
  const parseTime = (value: string) => {
    const [hours, minutes, seconds, millis] = value.split(/[:,.]/).map(Number);
    return hours * 3600 + minutes * 60 + seconds + millis / 1000;
  };
  return text.trim().split(/\r?\n(?:[ \t]*\r?\n)+/).slice(0, 500).flatMap(block => {
    const lines = block.trim().split(/\r?\n/);
    if (/^\d+$/.test(lines[0])) lines.shift();
    const timing = /^(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})/.exec(lines.shift() ?? '');
    if (!timing) return [];
    const fromSec = parseTime(timing[1]);
    const toSec = Math.min(durationSec, parseTime(timing[2]));
    const caption = lines.join('\n').replace(/<[^>]+>/g, '').trim().slice(0, 300);
    return fromSec >= 0 && toSec > fromSec && caption ? [{ fromSec, toSec, text: caption }] : [];
  }).sort((first, second) => first.fromSec - second.fromSec);
}

export function readFilmCaptionSidecar(file: string, durationSec: number) {
  const directory = path.dirname(file);
  const nativeSidecars = fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && /^subtitles_[a-z]{2,3}(?:[-_][a-z0-9]{2,8})*\.srt$/i.test(entry.name))
    .map(entry => entry.name).sort();
  const candidates = [...nativeSidecars, path.parse(file).name + '.srt', 'captions.srt', 'subtitles.srt'];
  for (const name of candidates) {
    const candidate = path.join(directory, name);
    if (!fs.lstatSync(candidate, { throwIfNoEntry: false })?.isFile() || fs.realpathSync(candidate) !== candidate) continue;
    try {
      const captions = parseFilmCaptions(readRegularFileNoFollow(candidate, 128 * 1024).toString('utf8'), durationSec);
      if (captions.length) return { captions, captionsBurnedIn: nativeSidecars.includes(name) };
    } catch {
      // A subsequent sidecar may still contain the complete track.
    }
  }
  return { captions: [], captionsBurnedIn: false };
}

function probeCodeFilm(file: string) {
  const probe = JSON.parse(execFileSync('ffprobe', [
    '-v', 'error', '-protocol_whitelist', 'file,pipe',
    '-show_entries', 'format=duration:stream=codec_type,start_time,width,height',
    '-of', 'json', file,
  ], { encoding: 'utf8', timeout: 8000, maxBuffer: 64 * 1024 })) as {
    format?: { duration?: string };
    streams?: { codec_type?: string; start_time?: string; width?: number; height?: number }[];
  };
  const durationSec = Number(probe.format?.duration);
  const audio = probe.streams?.find(stream => stream.codec_type === 'audio');
  const video = probe.streams?.find(stream => stream.codec_type === 'video');
  if (!Number.isFinite(durationSec) || durationSec <= 0 || durationSec > 7200
      || !video || !audio) {
    throw new AgentWorkspaceRuntimeError('design_output_invalid', 'The completed file must contain playable video and audio');
  }
  return { durationSec, audio, video };
}

function packetDigest(file: string, stream: 'a' | 'v'): string {
  return execFileSync('ffmpeg', ['-v', 'error', '-nostdin', '-protocol_whitelist', 'file,pipe', '-i', file,
    '-map', `0:${stream}:0`, '-c', 'copy', '-f', 'hash', '-hash', 'sha256', '-'], {
    encoding: 'utf8', timeout: 8000, maxBuffer: 8 * 1024,
  }).trim();
}

export function collectCodeFilmMetadata(file: string, previewLimit: number): WorkspacePackageFile[] {
  const main = probeCodeFilm(file);
  const captionTrack = readFilmCaptionSidecar(file, main.durationSec);
  const previewPath = file.slice(0, -4) + '.preview.mp4';
  let preview: WorkspacePackageFile | undefined;
  if (captionTrack.captionsBurnedIn && previewLimit > 0 && fs.lstatSync(previewPath, { throwIfNoEntry: false })?.isFile()
      && fs.realpathSync(previewPath) === previewPath) {
    try {
      const bytes = readRegularFileNoFollow(previewPath, previewLimit);
      const alternate = probeCodeFilm(previewPath);
      const audioDigest = packetDigest(file, 'a');
      if (Math.abs(main.durationSec - alternate.durationSec) <= 0.06
          && Math.abs(Number(main.audio.start_time) - Number(alternate.audio.start_time)) <= 0.035
          && main.video.width === alternate.video.width && main.video.height === alternate.video.height
          && /^SHA256=[0-9a-f]{64}$/i.test(audioDigest) && audioDigest === packetDigest(previewPath, 'a')
          && packetDigest(file, 'v') !== packetDigest(previewPath, 'v')) {
        preview = { path: 'film-preview.mp4', mediaType: 'video/mp4', size: bytes.length,
          sha256: sha256(bytes), contentBase64: bytes.toString('base64') };
      }
    } catch {
      // Play the verified original if the optional clean preview cannot be read.
    }
  }
  const bytes = Buffer.from(JSON.stringify({ durationSec: main.durationSec, hasAudio: true,
    ...captionTrack, hasSubtitleFreePreview: preview !== undefined }), 'utf8');
  const metadata = { path: 'film.json', mediaType: 'application/json', size: bytes.length,
    sha256: sha256(bytes), contentBase64: bytes.toString('base64') };
  return preview ? [metadata, preview] : [metadata];
}
