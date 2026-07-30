import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url));
const skillRoot = path.join(repositoryRoot, '.claude', 'skills');
const skillNames = [
  'conflict-resolution',
  'task-handoff-checklist',
  'scope-check',
  'doc-writer',
  'acceptance-test-design',
];

const forbiddenCoupling = [
  /prd[-_]agent/i,
  /prd-api|prd-admin|prd-desktop|prd-video/i,
  /review-agent|ReviewAgent/,
  /toolboxStore|AdminMenuCatalog|QUICK_AGENTS/,
  /百宝箱/,
  /miduo\.org/i,
  /map-enterprise/i,
  /Asia\/Shanghai/,
  /origin\/main/,
  /\.claude\/skills/,
  /doc\/rule\.acceptance/i,
];

function listFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(target) : [target];
  });
}

describe('portable general skill packages', () => {
  for (const skillName of skillNames) {
    it(`${skillName} is self-contained and repository-neutral`, () => {
      const directory = path.join(skillRoot, skillName);
      const skillFile = path.join(directory, 'SKILL.md');
      const skillText = fs.readFileSync(skillFile, 'utf8');

      expect(skillText).toMatch(new RegExp(`^name: ${skillName}$`, 'm'));
      expect(skillText).toMatch(/^version: 2\.0\.0$/m);

      const files = listFiles(directory);
      expect(files.length).toBeGreaterThan(0);

      for (const file of files) {
        const content = fs.readFileSync(file, 'utf8');
        for (const pattern of forbiddenCoupling) {
          expect(content, `${path.relative(repositoryRoot, file)} contains ${pattern}`).not.toMatch(pattern);
        }

        for (const match of content.matchAll(/\]\(([^)]+)\)/g)) {
          const reference = match[1].split('#', 1)[0].trim();
          if (!reference || /^(?:https?:|mailto:|\/)/.test(reference)) continue;
          expect(
            fs.existsSync(path.resolve(path.dirname(file), reference)),
            `${path.relative(repositoryRoot, file)} references missing ${reference}`,
          ).toBe(true);
        }
      }
    });
  }
});
