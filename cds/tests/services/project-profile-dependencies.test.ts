import { describe, expect, it } from 'vitest';
import { normalizeProjectProfileDependencies } from '../../src/services/project-profile-dependencies.js';
import { topoSortLayers } from '../../src/services/topo-sort.js';
import type { BuildProfile } from '../../src/types.js';

function profile(id: string, dependsOn?: string[]): BuildProfile {
  return {
    id,
    projectId: 'project-a',
    name: id,
    dockerImage: 'node:20-slim',
    workDir: '.',
    command: 'node server.js',
    containerPort: 8080,
    dependsOn,
  };
}

describe('normalizeProjectProfileDependencies', () => {
  it('rewrites only dependencies that resolve to a scoped application profile', () => {
    const profiles = [
      profile('api-project-a'),
      profile('web-project-a', ['api', 'mongodb']),
    ];

    const normalized = normalizeProjectProfileDependencies(profiles, '-project-a');

    expect(normalized[1].dependsOn).toEqual(['api-project-a', 'mongodb']);
  });

  it('preserves dependencies that are already scoped', () => {
    const profiles = [
      profile('api-project-a'),
      profile('web-project-a', ['api-project-a']),
    ];

    expect(normalizeProjectProfileDependencies(profiles, '-project-a')).toBe(profiles);
  });

  it('leaves the default project unchanged', () => {
    const profiles = [profile('api'), profile('web', ['api', 'redis'])];

    expect(normalizeProjectProfileDependencies(profiles, '')).toBe(profiles);
  });

  it('restores separate startup layers for persisted unscoped dependencies', () => {
    const profiles = [
      profile('console-project-a'),
      profile('serving-project-a'),
      profile('web-project-a', ['console', 'serving']),
    ];
    const normalized = normalizeProjectProfileDependencies(profiles, '-project-a');

    const result = topoSortLayers(
      normalized,
      (item) => item.id,
      (item) => item.dependsOn || [],
    );

    expect(result.warnings).toEqual([]);
    expect(result.layers.map((layer) => layer.items.map((item) => item.id))).toEqual([
      ['console-project-a', 'serving-project-a'],
      ['web-project-a'],
    ]);
  });
});
