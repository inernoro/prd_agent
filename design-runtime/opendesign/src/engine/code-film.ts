import fs from 'node:fs';
import path from 'node:path';

import { AgentWorkspaceRuntimeError } from '../errors.js';
import { readRegularFileNoFollow } from '../workspace/output-preflight.js';
import { sha256 } from '../workspace/primitives.js';
import type { WorkspacePackageFile } from '../workspace/transfer.js';

export const CODE_FILM_SKILL_ID = 'lemo-opuscar';
const SKILL_SOURCE = '/opt/map-design-runtime/lemo-opuscar';
const SKILL_FILES = {
  'SKILL.md': '17c2f1c2a337becf28ec1e23eec46b42a6f0ffa2691b40d8b97b35d043b79f65',
  'scripts/setup.sh': '6b5e39efe99e42d671edb365e11b89d065ccda7188a45e81fe5757f5f46661be',
} as const;

export function registerCodeFilmSkill(dataDir: string, chownForEngine: (target: string) => void): void {
  const target = path.join(dataDir, 'skills', CODE_FILM_SKILL_ID);
  for (const [file, digest] of Object.entries(SKILL_FILES)) {
    const bytes = readRegularFileNoFollow(path.join(SKILL_SOURCE, file), 1024 * 1024);
    if (sha256(bytes) !== digest) {
      throw new AgentWorkspaceRuntimeError('code_film_skill_invalid', 'Lemo-Opuscar skill does not match its upstream revision');
    }
    const output = path.join(target, file);
    fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o755 });
    fs.writeFileSync(output, bytes, { flag: 'wx', mode: 0o644 });
  }
  chownForEngine(path.dirname(target));
}

export function verifyCodeFilmInput(
  workspaceDir: string,
  source: { path: string; sha256: string },
): Record<string, unknown> {
  const staged = path.join(workspaceDir, '.od-skills', CODE_FILM_SKILL_ID);
  for (const [file, digest] of Object.entries(SKILL_FILES)) {
    if (sha256(readRegularFileNoFollow(path.join(staged, file), 1024 * 1024)) !== digest) {
      throw new AgentWorkspaceRuntimeError('code_film_skill_not_loaded', 'OpenDesign did not stage the original Lemo-Opuscar skill');
    }
  }
  const sourceSha256 = sha256(readRegularFileNoFollow(path.join(workspaceDir, source.path), 1024 * 1024));
  if (sourceSha256 !== source.sha256) {
    throw new AgentWorkspaceRuntimeError('workspace_input_changed', 'The original Markdown inside the OpenDesign workspace changed');
  }
  return { skillId: CODE_FILM_SKILL_ID, skillSha256: SKILL_FILES['SKILL.md'], sourceSha256 };
}

export function collectCodeFilm(workspaceDir: string, maxOutputBytes: number): WorkspacePackageFile {
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
    path: 'film.mp4',
    mediaType: 'video/mp4',
    size: bytes.length,
    sha256: sha256(bytes),
    contentBase64: bytes.toString('base64'),
  };
}
