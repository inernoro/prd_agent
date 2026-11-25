import fs from 'node:fs';
import path from 'node:path';

import { AgentWorkspaceRuntimeError } from '../errors.js';
import { OPEN_DESIGN_CODEX_HOME_RELATIVE } from '../prompts.js';
import { readRegularFileNoFollow } from '../workspace/output-preflight.js';
import { sha256 } from '../workspace/primitives.js';
import type { WorkspacePackageFile } from '../workspace/transfer.js';

export const CODE_FILM_SKILL_ID = 'lemo-opuscar';
const SKILL_SOURCE = '/opt/map-design-runtime/lemo-opuscar';
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
  chownForEngine(path.join(dataDir, 'sandbox'));
}

export function verifyCodeFilmInput(
  dataDir: string,
  workspaceDir: string,
  source: { path: string; sha256: string },
): Record<string, unknown> {
  const staged = codexSkillDirectory(dataDir);
  for (const [file, digest] of Object.entries(SKILL_FILES)) {
    if (sha256(readRegularFileNoFollow(path.join(staged, file), 1024 * 1024)) !== digest) {
      throw new AgentWorkspaceRuntimeError('code_film_skill_not_loaded', 'The Codex skill directory did not retain the original Lemo-Opuscar skill');
    }
  }
  const sourceSha256 = sha256(readRegularFileNoFollow(path.join(workspaceDir, source.path), 1024 * 1024));
  if (sourceSha256 !== source.sha256) {
    throw new AgentWorkspaceRuntimeError('workspace_input_changed', 'The original Markdown inside the OpenDesign workspace changed');
  }
  return { skillId: CODE_FILM_SKILL_ID, skillSha256: SKILL_FILES['SKILL.md'], sourceSha256 };
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

export function collectCodeFilm(workspaceDir: string, maxOutputBytes: number): WorkspacePackageFile | undefined {
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
    path: 'film.mp4',
    mediaType: 'video/mp4',
    size: bytes.length,
    sha256: sha256(bytes),
    contentBase64: bytes.toString('base64'),
  };
}
