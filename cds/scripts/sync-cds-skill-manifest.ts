import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCdsSkillManifest } from '../src/services/cds-skill-manifest.js';

// Run after editing any of the five bundled skills; CI rejects a stale receipt.
const skillsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.claude/skills');
const manifest = await buildCdsSkillManifest(skillsRoot);
await fs.writeFile(path.join(skillsRoot, 'cds/cli/cds-skill-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Updated CDS ${manifest.version} bundle receipt (${Object.keys(manifest.files).length} files)`);
