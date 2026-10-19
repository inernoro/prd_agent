import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { CDS_SKILL_KEYS } from '../../src/shared/agent-setup.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const workflow = yaml.load(fs.readFileSync(path.join(repoRoot, '.github/workflows/cds-prebuilt.yml'), 'utf8')) as {
  on: { push: { paths: string[] } };
  jobs: Record<string, { steps: Array<{
    name?: string;
    run?: string;
    if?: string;
    with?: Record<string, unknown>;
    'continue-on-error'?: boolean;
  }> }>;
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

  it('loads the preview candidate locally without publishing its commit tag', () => {
    const steps = workflow.jobs['build-and-push'].steps;
    const build = steps.find(step => step.with?.file === './cds/Dockerfile.preview');
    expect(build?.with).toMatchObject({ push: false, load: true });
    expect(build?.with?.tags).toBe('ghcr.io/${{ github.repository_owner }}/${{ github.event.repository.name }}/cds-preview:sha-${{ github.sha }}');
  });

  it('publishes the same local image only after the required runtime smoke succeeds', () => {
    const steps = workflow.jobs['build-and-push'].steps;
    const buildIndex = steps.findIndex(step => step.with?.file === './cds/Dockerfile.preview');
    const smokeIndex = steps.findIndex(step => step.name === 'Smoke CDS preview runtime');
    const publishIndex = steps.findIndex(step => step.name === 'Publish verified CDS preview runtime');
    const image = steps[buildIndex].with!.tags;
    expect(smokeIndex).toBeGreaterThan(buildIndex);
    expect(publishIndex).toBeGreaterThan(smokeIndex);
    expect(steps[smokeIndex].run).toContain('docker run --pull=never');
    expect(steps[smokeIndex].run).toContain(image);
    expect(steps[smokeIndex].run).toContain('python3 cds/scripts/smoke-preview-runtime.py');
    expect(steps[smokeIndex]['continue-on-error']).not.toBe(true);
    expect(steps[publishIndex].if).toBe('success()');
    expect(steps[publishIndex].run).toBe(`docker push ${image}`);
  });
});
