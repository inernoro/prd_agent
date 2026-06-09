import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearBundledCdsCliVersionCache, readBundledCdsCliVersion } from '../../src/services/cdscli-version.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');

function readSkillFrontmatterVersion(): string | null {
  const skillMd = fs.readFileSync(path.join(repoRoot, '.claude', 'skills', 'cds', 'SKILL.md'), 'utf-8');
  const frontmatter = skillMd.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatter) return null;
  const version = frontmatter[1].match(/^version:\s*(.+?)\s*$/m);
  return version ? version[1].trim().replace(/^["']|["']$/g, '') : null;
}

describe('cdscli bundled version', () => {
  it('reads cdscli.py VERSION from the repository skill bundle', () => {
    clearBundledCdsCliVersionCache();

    expect(readBundledCdsCliVersion(repoRoot)).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('keeps cds SKILL.md version aligned with cdscli.py VERSION', () => {
    clearBundledCdsCliVersionCache();

    expect(readSkillFrontmatterVersion()).toBe(readBundledCdsCliVersion(repoRoot));
  });
});
