import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { CDS_SKILL_KEYS } from '../shared/agent-setup.js';

/** One distribution receipt for both anonymous installation and authenticated updates. */
export async function buildCdsSkillManifest(skillsRoot: string) {
  const cli = await fs.readFile(path.join(skillsRoot, 'cds/cli/cdscli.py'), 'utf8');
  const version = cli.match(/^VERSION\s*=\s*"(\d+\.\d+\.\d+)"/m)?.[1];
  if (!version) throw new Error('CDS skill bundle has no valid CLI version');
  const files: Record<string, string> = {};
  const walk = async (relative: string): Promise<void> => {
    for (const entry of (await fs.readdir(path.join(skillsRoot, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '__pycache__' || entry.name === '.DS_Store' || entry.name.endsWith('.pyc')) continue;
      const name = `${relative}/${entry.name}`;
      if (name === 'cds/cli/cds-skill-manifest.json') continue;
      if (entry.isDirectory()) await walk(name);
      else if (entry.isFile()) files[name] = createHash('sha256').update(await fs.readFile(path.join(skillsRoot, name))).digest('hex');
      else throw new Error('CDS skill bundle contains an unsupported file type');
    }
  };
  for (const skill of CDS_SKILL_KEYS) {
    await walk(skill);
    if (!files[`${skill}/SKILL.md`]) throw new Error(`CDS skill bundle is missing ${skill}/SKILL.md`);
  }
  return { format: 'agent-skills', version, skills: [...CDS_SKILL_KEYS], files, generatedAt: new Date().toISOString() };
}
