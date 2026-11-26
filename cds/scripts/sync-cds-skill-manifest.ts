import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCdsSkillManifest } from '../src/services/cds-skill-manifest.js';

// Run after editing any of the five bundled skills; CI rejects a stale receipt.
const skillsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.claude/skills');
for (const name of ['design-acceptance-policy.json', 'design-acceptance-standard.mjs']) {
  await fs.copyFile(new URL('../src/shared/' + name, import.meta.url), path.join(skillsRoot, 'cds/cli', name));
}
const manifest = await buildCdsSkillManifest(skillsRoot);
await fs.writeFile(path.join(skillsRoot, 'cds/cli/cds-skill-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Updated CDS ${manifest.version} bundle receipt (${Object.keys(manifest.files).length} files)`);
