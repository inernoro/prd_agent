import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { CDS_SKILL_KEYS } from '../../src/shared/agent-setup.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const workflow = yaml.load(fs.readFileSync(path.join(repoRoot, '.github/workflows/cds-prebuilt.yml'), 'utf8')) as {
  on: { push: { paths: string[] } };
  jobs: Record<string, { steps: Array<{ name?: string; run?: string }> }>;
};

describe('preview image bundled skill inputs', () => {
  const staging = workflow.jobs['build-and-push'].steps.find(step => step.name === 'Stage canonical CDS onboarding skills');
  const bundledSkills = staging?.run?.match(/for skill in ([^;]+); do/)?.[1].trim().split(/\s+/) ?? [];

  it('stages every skill exposed by the anonymous onboarding contract', () => {
    expect([...bundledSkills].sort()).toEqual([...CDS_SKILL_KEYS].sort());
  });

  it.each(CDS_SKILL_KEYS)('rebuilds the image for CLI, instructions and nested references in %s', skill => {
    expect(bundledSkills).toContain(skill);
    expect(workflow.on.push.paths).toContain(`.claude/skills/${skill}/**`);
  });

  it.each(['cds.yml', 'ci.yml'])('runs the build-input contract when a guarded input changes (%s)', name => {
    const ci = yaml.load(fs.readFileSync(path.join(repoRoot, '.github/workflows', name), 'utf8')) as {
      jobs: { changes: { steps: Array<{ with?: { filters?: string } }> } };
    };
    const filterStep = ci.jobs.changes.steps.find(step => step.with?.filters);
    const filters = yaml.load(filterStep!.with!.filters!) as { cds: string[] };
    expect(filters.cds).toContain('.github/workflows/cds-prebuilt.yml');
    for (const skill of CDS_SKILL_KEYS) expect(filters.cds).toContain(`.claude/skills/${skill}/**`);
  });
});
