import fs from 'node:fs';
import path from 'node:path';

import { readRegularFileNoFollow } from '../workspace/output-preflight.js';
import { sha256 } from '../workspace/primitives.js';
import { hasCompletedMovie } from './film-recovery.js';

const MIB = 1024 * 1024;
// A project retains separate scene encodes and uncompressed narration. Its
// working set can be larger than the final film even before the preview exists.
const MAX_PROJECT_BYTES = 80 * MIB;
const MAX_CHECKPOINT_BYTES = Math.ceil(MAX_PROJECT_BYTES / 3) * 4 + 256 * 1024;
const MAX_STORE_BYTES = 3 * MAX_CHECKPOINT_BYTES;
const MAX_FILE_COUNT = 160;
const MAX_NODES = 512;
const RETENTION_MS = 24 * 60 * 60 * 1000;
const SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/;
const FILE_SEGMENT = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}$/;
const RUN_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const EXTENSIONS = new Set(['.md', '.txt', '.json', '.html', '.css', '.js', '.mjs', '.ts', '.svg', '.sh', '.py',
  '.png', '.jpg', '.webp', '.wav', '.mp3', '.srt', '.woff', '.woff2', '.ttf', '.mp4']);
const OMIT_DIRECTORIES = new Set(['node_modules', 'venv', '__pycache__', 'cache']);

type CheckpointFile = { path: string; sha: string; bytes: string };
type ProjectCheckpoint = { owner: string; inputHash: string; project: string; files: CheckpointFile[] };

export function filmProjectInputHash(instruction: string, inputs: ReadonlyArray<{path: string; sha256: string}>): string {
  return sha256(JSON.stringify([instruction, inputs.map(input => [input.path, input.sha256])]));
}

function isNarration(relative: string): boolean {
  return /^(?:voice|narration|tts)\/(?:[^/]+\/)*[^/]+\.wav$/i.test(relative);
}

function isSceneVideo(relative: string): boolean {
  return /^scenes\/(?:[1-9]\d?|100)\.mp4$/.test(relative);
}

function isSceneProgram(relative: string): boolean {
  return /^scenes\/[1-9]\d?\.mjs$/.test(relative);
}

function isCompletedAsset(relative: string, bytes: Buffer): boolean {
  if (isSceneProgram(relative)) return bytes.length > 0;
  if (isSceneVideo(relative)) return hasCompletedMovie(bytes);
  if (!isNarration(relative) || bytes.length <= 44 || bytes.toString('ascii', 0, 4) !== 'RIFF'
    || bytes.toString('ascii', 8, 12) !== 'WAVE' || bytes.readUInt32LE(4) + 8 !== bytes.length) return false;
  let format = false;
  let data = false;
  for (let offset = 12; offset < bytes.length;) {
    if (bytes.length - offset < 8) return false;
    const tag = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    if (size + (size % 2) > bytes.length - offset - 8) return false;
    format ||= tag === 'fmt ' && size >= 16;
    data ||= tag === 'data' && size > 0;
    offset += 8 + size + (size % 2);
  }
  return format && data;
}

function decode(file: CheckpointFile): Buffer {
  const bytes = Buffer.from(file.bytes, 'base64');
  if (sha256(bytes) !== file.sha) throw new Error('Film checkpoint file digest mismatch');
  return bytes;
}

function summarize(checkpoint: ProjectCheckpoint) {
  const saved = checkpoint.files.filter(file => (isNarration(file.path) || isSceneVideo(file.path) || isSceneProgram(file.path))
    && isCompletedAsset(file.path, decode(file)));
  const plan = checkpoint.files.find(file => file.path === 'scenes/plan.json');
  const indexes = new Set(saved.filter(file => isSceneVideo(file.path)).map(file => Number(path.parse(file.path).name)));
  let incompleteScene: number | undefined;
  if (plan && indexes.size >= 1) {
    try {
      const entries: unknown = JSON.parse(decode(plan).toString('utf8'));
      if (Array.isArray(entries) && entries.length <= 100 && entries.length === indexes.size + 1
          && entries.every((index, offset) => index === offset + 1)
          && [...indexes].every(index => entries.includes(index))) {
        incompleteScene = entries.find(index => !indexes.has(index));
      }
    } catch {
      // Other native projects can still retain progress without an ordered scene plan.
    }
  }
  return {
    completedScenes: new Set(saved.filter(file => isSceneVideo(file.path) || isSceneProgram(file.path))
      .map(file => Number(path.parse(file.path).name))).size,
    narrationClips: saved.filter(file => isNarration(file.path)).length,
    ...(incompleteScene ? { incompleteScene } : {}),
  };
}

export class FilmProjectCheckpointStore {
  constructor(readonly directory: string) {}

  capture(runId: string, owner: string, inputHash: string, workspace: string): boolean {
    const output = this.file(runId);
    if (!output) return false;
    const projects = fs.readdirSync(workspace, { withFileTypes: true }).filter(entry => entry.isDirectory()
      && SLUG.test(entry.name)
      && fs.lstatSync(path.join(workspace, entry.name, 'TREATMENT.md'), { throwIfNoEntry: false })?.isFile());
    if (projects.length !== 1) return false;
    const project = projects[0].name;
    const root = path.join(workspace, project);
    if (fs.realpathSync(root) !== root) return false;
    let total = 0;
    let nodes = 0;
    const files: CheckpointFile[] = [];
    const walk = (directory: string, prefix: string, depth: number) => {
      if (depth > 5) return;
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (++nodes > MAX_NODES) throw new Error('Film checkpoint has too many workspace entries');
        if (!FILE_SEGMENT.test(entry.name) || /^\s*(?:credentials|secrets?|tokens?)\./i.test(entry.name)) continue;
        const absolute = path.join(directory, entry.name);
        const relative = prefix + entry.name;
        if (entry.isDirectory() && !OMIT_DIRECTORIES.has(entry.name)) walk(absolute, relative + '/', depth + 1);
        const extension = path.extname(entry.name).toLowerCase();
        if (!entry.isFile() || !EXTENSIONS.has(extension) || (extension === '.mp4' && !isSceneVideo(relative))) continue;
        const stat = fs.lstatSync(absolute, { throwIfNoEntry: false });
        if (!stat?.isFile() || stat.size === 0 || fs.realpathSync(absolute) !== absolute) continue;
        if (stat.size > MAX_PROJECT_BYTES) throw new Error('Film checkpoint file exceeds the workspace storage limit');
        const bytes = readRegularFileNoFollow(absolute, MAX_PROJECT_BYTES);
        if ((isNarration(relative) || isSceneVideo(relative)) && !isCompletedAsset(relative, bytes)) continue;
        if (total + bytes.length > MAX_PROJECT_BYTES || files.length >= MAX_FILE_COUNT)
          throw new Error('Film checkpoint exceeds the workspace storage limit');
        total += bytes.length;
        files.push({ path: relative, sha: sha256(bytes), bytes: bytes.toString('base64') });
      }
    };
    walk(root, '', 1);
    if (!files.some(file => file.path === 'TREATMENT.md') || !files.some(file => isNarration(file.path) || isSceneVideo(file.path))) return false;
    const checkpoint: ProjectCheckpoint = { owner, inputHash, project, files };
    const serialized = JSON.stringify(checkpoint);
    if (Buffer.byteLength(serialized) > MAX_CHECKPOINT_BYTES) return false;
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const entries = fs.readdirSync(this.directory, { withFileTypes: true }).filter(entry => entry.isFile() && entry.name.endsWith('.json'))
      .map(entry => {
        const file = path.join(this.directory, entry.name);
        return { file, stat: fs.lstatSync(file) };
      }).sort((first, second) => first.stat.mtimeMs - second.stat.mtimeMs);
    let used = entries.reduce((sum, entry) => sum + (entry.file === output ? 0 : entry.stat.size), Buffer.byteLength(serialized));
    for (const { file, stat } of entries) {
      if (file !== output && (Date.now() - stat.mtimeMs >= RETENTION_MS || used > MAX_STORE_BYTES)) {
        fs.rmSync(file, { force: true });
        used -= stat.size;
      }
    }
    const pending = output + '.pending';
    try {
      fs.writeFileSync(pending, serialized, { flag: 'wx', mode: 0o600 });
      fs.renameSync(pending, output);
    } finally {
      fs.rmSync(pending, { force: true });
    }
    return true;
  }

  inspect(runId: string) {
    const checkpoint = this.read(runId);
    return checkpoint ? summarize(checkpoint) : undefined;
  }

  restore(runId: string, owner: string, inputHash: string, workspace: string) {
    const checkpoint = this.read(runId);
    if (!checkpoint || checkpoint.owner !== owner || checkpoint.inputHash !== inputHash || !SLUG.test(checkpoint.project)) return undefined;
    const root = path.join(workspace, checkpoint.project);
    const protectedMedia: Array<{ absolute: string; sha: string; size: number }> = [];
    fs.mkdirSync(root, { mode: 0o755 });
    for (const file of checkpoint.files) {
      if (file.path.split('/').some(segment => !FILE_SEGMENT.test(segment))) throw new Error('Invalid film checkpoint path');
      const destination = path.join(root, file.path);
      const bytes = decode(file);
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o755 });
      fs.writeFileSync(destination, bytes, { flag: 'wx', mode: 0o644 });
      if (isCompletedAsset(file.path, bytes)) protectedMedia.push({ absolute: destination, sha: file.sha, size: bytes.length });
    }
    return { root, protectedMedia, ...summarize(checkpoint) };
  }

  static hasCompletedScene(root: string, index: number): boolean {
    const directory = path.join(root, 'scenes');
    const file = path.join(directory, `${index}.mp4`);
    return fs.lstatSync(file, { throwIfNoEntry: false })?.isFile() === true && fs.realpathSync(file) === file
      && hasCompletedMovie(readRegularFileNoFollow(file, MAX_PROJECT_BYTES));
  }

  private read(runId: string): ProjectCheckpoint | undefined {
    const target = this.file(runId);
    if (!target) return undefined;
    const stat = fs.lstatSync(target, { throwIfNoEntry: false });
    if (!stat?.isFile() || Date.now() - stat.mtimeMs >= RETENTION_MS) return undefined;
    return JSON.parse(readRegularFileNoFollow(target, MAX_CHECKPOINT_BYTES).toString('utf8')) as ProjectCheckpoint;
  }

  private file(runId: string): string | undefined {
    return RUN_ID.test(runId) ? path.join(this.directory, runId + '.json') : undefined;
  }
}
