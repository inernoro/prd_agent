#!/usr/bin/env node
/**
 * Migrate Claude Code style skills into another local skills directory.
 *
 * Default source: .claude/skills
 * Default target: .agents/skills
 *
 * Examples:
 *   node scripts/migrate-claude-skills.mjs --dry-run
 *   node scripts/migrate-claude-skills.mjs --link --skill create-visual-test-to-kb
 *   node scripts/migrate-claude-skills.mjs --target ~/.codex/skills --skill create-visual-test-to-kb
 *   node scripts/migrate-claude-skills.mjs --source .claude/skills --target .agents/skills --overwrite
 */

import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const DEFAULT_SOURCE = '.claude/skills';
const DEFAULT_TARGET = '.agents/skills';

const IGNORE_NAMES = new Set([
  '.DS_Store',
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  '__pycache__',
]);

function usage() {
  return `
Usage:
  node scripts/migrate-claude-skills.mjs [options]

Options:
  --source <dir>       Claude Code skills directory. Default: ${DEFAULT_SOURCE}
  --target <dir>       Destination skills directory. Default: ${DEFAULT_TARGET}
  --skill <name[,..]>  Migrate only selected skill(s). Can be repeated.
  --all                Migrate all skills from source. Default when --skill is omitted.
  --mode <copy|link>   copy duplicates files; link creates symlink references. Default: copy.
  --link               Alias for --mode link.
  --relative-link      Force relative symlink targets. By default only in-repo targets are relative.
  --dry-run            Print planned actions without writing files.
  --overwrite          Replace an existing target skill directory.
  --manifest <file>    Write a JSON migration manifest.
  --list               List source skills and exit.
  --help               Show this help.

Examples:
  node scripts/migrate-claude-skills.mjs --dry-run
  node scripts/migrate-claude-skills.mjs --link --skill create-visual-test-to-kb
  node scripts/migrate-claude-skills.mjs --target ~/.codex/skills --skill create-visual-test-to-kb
  node scripts/migrate-claude-skills.mjs --source .claude/skills --target .agents/skills --overwrite
`.trim();
}

function expandHome(p) {
  if (!p.startsWith('~')) return p;
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) throw new Error('Cannot expand "~": HOME is not set.');
  return p === '~' ? home : join(home, p.slice(2));
}

function toAbs(p) {
  const expanded = expandHome(p);
  return isAbsolute(expanded) ? expanded : resolve(ROOT, expanded);
}

function parseArgs(argv) {
  const args = {
    source: DEFAULT_SOURCE,
    target: DEFAULT_TARGET,
    skills: [],
    all: false,
    mode: 'copy',
    relativeLink: false,
    dryRun: false,
    overwrite: false,
    manifest: null,
    list: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`${a} requires a value.`);
      return argv[i];
    };

    if (a === '--source') args.source = next();
    else if (a === '--target') args.target = next();
    else if (a === '--skill' || a === '--skills') {
      args.skills.push(...next().split(',').map((x) => x.trim()).filter(Boolean));
    } else if (a === '--all') args.all = true;
    else if (a === '--mode') args.mode = next();
    else if (a === '--link') args.mode = 'link';
    else if (a === '--relative-link') args.relativeLink = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--overwrite') args.overwrite = true;
    else if (a === '--manifest') args.manifest = next();
    else if (a === '--list') args.list = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a.startsWith('-')) throw new Error(`Unknown option: ${a}`);
    else args.skills.push(a);
  }

  args.skills = [...new Set(args.skills)];
  if (!['copy', 'link'].includes(args.mode)) throw new Error(`Invalid --mode: ${args.mode}. Expected copy or link.`);
  return args;
}

function isSkillDir(dir) {
  try {
    return statSync(dir).isDirectory() && existsSync(join(dir, 'SKILL.md'));
  } catch {
    return false;
  }
}

function parseFrontmatterName(skillMd) {
  const lines = skillMd.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i += 1;
  if (lines[i]?.trim() !== '---') return null;
  for (i += 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '---') return null;
    const m = line.match(/^name:\s*(.+?)\s*$/);
    if (m) return m[1].replace(/^["']|["']$/g, '').trim() || null;
  }
  return null;
}

function listSkills(sourceDir) {
  if (!existsSync(sourceDir)) throw new Error(`Source directory does not exist: ${sourceDir}`);
  const names = readdirSync(sourceDir)
    .filter((name) => !IGNORE_NAMES.has(name) && !name.startsWith('.'))
    .filter((name) => isSkillDir(join(sourceDir, name)))
    .sort((a, b) => a.localeCompare(b));

  return names.map((dirName) => {
    const skillMdPath = join(sourceDir, dirName, 'SKILL.md');
    const md = readFileSync(skillMdPath, 'utf8');
    return {
      dirName,
      frontmatterName: parseFrontmatterName(md),
      sourcePath: join(sourceDir, dirName),
    };
  });
}

function validateRequestedSkills(allSkills, requested) {
  if (!requested.length) return allSkills;
  const byDir = new Map(allSkills.map((s) => [s.dirName, s]));
  const byName = new Map(allSkills.filter((s) => s.frontmatterName).map((s) => [s.frontmatterName, s]));
  const selected = [];
  const missing = [];

  for (const key of requested) {
    const hit = byDir.get(key) || byName.get(key);
    if (hit) selected.push(hit);
    else missing.push(key);
  }

  if (missing.length) {
    const available = allSkills.map((s) => s.dirName).join(', ');
    throw new Error(`Requested skill(s) not found: ${missing.join(', ')}\nAvailable: ${available}`);
  }

  return [...new Map(selected.map((s) => [s.dirName, s])).values()];
}

function shouldCopyFilter(src) {
  return !IGNORE_NAMES.has(src.split(/[\\/]/).pop());
}

function existingLinkTarget(dst) {
  try {
    const st = lstatSync(dst);
    if (!st.isSymbolicLink()) return null;
    return resolve(dirname(dst), readlinkSync(dst));
  } catch {
    return null;
  }
}

function relativeLinkTarget(fromDir, toPath) {
  const rel = relative(fromDir, toPath).split('\\').join('/');
  return rel.startsWith('.') ? rel : `./${rel}`;
}

function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function linkTargetFor(dst, sourcePath, args) {
  if (args.relativeLink || isInside(ROOT, dirname(dst))) {
    return relativeLinkTarget(dirname(dst), sourcePath);
  }
  return sourcePath;
}

function migrateSkill(skill, targetDir, args) {
  const dst = join(targetDir, skill.dirName);
  const existed = existsSync(dst);
  const existingTarget = existingLinkTarget(dst);

  if (existed && !args.overwrite) {
    if (args.mode === 'link' && existingTarget === resolve(skill.sourcePath)) {
      return {
        skill: skill.dirName,
        source: skill.sourcePath,
        target: dst,
        action: 'ok-link',
        reason: 'already-linked',
      };
    }
    return {
      skill: skill.dirName,
      source: skill.sourcePath,
      target: dst,
      action: 'skip',
      reason: 'target-exists',
    };
  }

  if (!args.dryRun) {
    mkdirSync(targetDir, { recursive: true });
    if (existed && args.overwrite) rmSync(dst, { recursive: true, force: true });
    if (args.mode === 'link') {
      symlinkSync(linkTargetFor(dst, skill.sourcePath, args), dst, 'dir');
    } else {
      cpSync(skill.sourcePath, dst, {
        recursive: true,
        errorOnExist: false,
        force: true,
        filter: shouldCopyFilter,
      });
    }
  }

  return {
    skill: skill.dirName,
    source: skill.sourcePath,
    target: dst,
    action: args.mode === 'link'
      ? (existed ? 'relink' : 'link')
      : (existed ? 'overwrite' : 'copy'),
  };
}

function writeManifest(pathLike, manifest) {
  const out = toAbs(pathLike);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return out;
}

function printSkillList(skills, sourceDir) {
  console.log(`Claude Code skills in ${sourceDir}:`);
  for (const s of skills) {
    const alias = s.frontmatterName && s.frontmatterName !== s.dirName ? ` (name: ${s.frontmatterName})` : '';
    console.log(`  - ${s.dirName}${alias}`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  const sourceDir = toAbs(args.source);
  const targetDir = toAbs(args.target);
  const skills = listSkills(sourceDir);

  if (args.list) {
    printSkillList(skills, sourceDir);
    return;
  }

  const selected = validateRequestedSkills(skills, args.skills);
  const results = selected.map((skill) => migrateSkill(skill, targetDir, args));
  const summary = {
    dryRun: args.dryRun,
    mode: args.mode,
    sourceDir,
    targetDir,
    selected: selected.length,
    copied: results.filter((r) => r.action === 'copy').length,
    linked: results.filter((r) => r.action === 'link').length,
    relinked: results.filter((r) => r.action === 'relink').length,
    overwritten: results.filter((r) => r.action === 'overwrite').length,
    alreadyLinked: results.filter((r) => r.action === 'ok-link').length,
    skipped: results.filter((r) => r.action === 'skip').length,
    results,
  };

  const mode = args.dryRun ? 'DRY-RUN' : 'MIGRATE';
  console.log(`[${mode}:${args.mode}] ${relative(ROOT, sourceDir) || sourceDir} -> ${relative(ROOT, targetDir) || targetDir}`);
  for (const r of results) {
    const targetLabel = relative(ROOT, r.target) || r.target;
    const reason = r.reason ? ` (${r.reason})` : '';
    console.log(`  ${r.action.padEnd(9)} ${r.skill} -> ${targetLabel}${reason}`);
  }
  console.log(
    `Summary: ${summary.copied} copied, ${summary.linked} linked, ${summary.relinked} relinked, `
    + `${summary.overwritten} overwritten, ${summary.alreadyLinked} already linked, ${summary.skipped} skipped.`,
  );

  if (args.manifest) {
    const manifestPath = writeManifest(args.manifest, summary);
    console.log(`Manifest: ${manifestPath}`);
  }
}

try {
  main();
} catch (err) {
  console.error(`[migrate-claude-skills] ${err instanceof Error ? err.message : String(err)}`);
  console.error('');
  console.error(usage());
  process.exit(1);
}
