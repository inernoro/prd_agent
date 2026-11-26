import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDesignWorkspaceRouter } from '../../src/routes/design-workspace.js';
import { DesignWorkspaceService, type DesignActor, type DesignWorkspaceCommit } from '../../src/services/design-workspace.js';
import { FileProjectRevisionStore } from '../../src/services/project-revision-store.js';
import { versionedDesignFixture } from '../helpers/versioned-design-fixture.js';

const projectId = 'fixture-v2-framework';
const otherProject = 'fixture-v2-framework-other';
const frameworkId = 'FW-v2-fixture';
const actor: DesignActor = {
  kind: 'human', id: 'fixture-steward', label: 'Fixture steward', steward: true,
  permissions: ['read', 'write', 'propose', 'approve'],
};
const clock = '2026-11-21T09:05:00.000Z';
const establishedMaterial = {
  rules: '# Existing rules\nUse the existing section title.',
  components: '# Existing components\nUse the existing card.',
};
const incomingMaterial = {
  rules: '# Proposed rules\nChange the section title.',
  components: '# Proposed components\nUse the revised card.',
};
const laterMaterial = {
  rules: '# New draft rules\nThese rules are not the implementation baseline.',
  components: '# New draft components\nThese components are still in review.',
};

function charter(example?: { designId: string; version: number }) {
  return {
    status: 'adopted' as const, intent: 'Keep fixture interfaces consistent.',
    problems: ['Separate records use different headers.'], nonGoals: ['Build real application services.'],
    scope: { system: 'Fixture suite', modules: ['navigation', 'cards'] }, owner: actor.id,
    ...(example ? { example } : {}),
  };
}

describe('CDS V2 framework contract', () => {
  let directory: string;
  let server: Server;
  let store: FileProjectRevisionStore<DesignWorkspaceCommit>;
  let api: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'cds-design-v2-framework-'));
    store = new FileProjectRevisionStore<DesignWorkspaceCommit>(directory);
    const service = new DesignWorkspaceService(store, { now: () => new Date(clock) });
    const app = express();
    app.use('/api', createDesignWorkspaceRouter({ service, resolveAccess: (_request, project) =>
      project === projectId || project === otherProject ? actor : null,
    }));
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture server');
    api = `http://127.0.0.1:${address.port}/api/projects`;
  });

  afterEach(async () => {
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  function endpoint(project: string) {
    return `${api}/${project}/design`;
  }

  function command(type: string, fields: object, project = projectId) {
    return fetch(`${endpoint(project)}/commands`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, requestId: randomUUID(), ...fields }),
    });
  }

  async function workspace(project = projectId) {
    const response = await fetch(endpoint(project));
    expect(response.status).toBe(200);
    return response.json();
  }

  async function publish(project: string, material: typeof establishedMaterial, priorId?: string) {
    const manifest = { project, title: 'Fixture implementation sample', frameworkDraft: 'spec/',
      acceptance: [{ id: 'A-01', how: 'measure', screenId: 'sample', rule: 'The example opens', expected: '检查：示例标题可见。' }],
      screens: [{ id: 'sample', name: 'Fixture sample', route: '#/sample', viewport: 'desktop', themes: ['light', 'dark'],
        impl: '/sample/', entryReadySelector: 'h1' }],
      ...(priorId ? { id: priorId } : {}) };
    const archive = versionedDesignFixture(manifest, 'Verify the stored implementation baseline.', [
      { name: 'dist/index.html', data: '<!doctype html><html lang="en"><body><h1>Fixture</h1></body></html>' },
      { name: 'spec/rules.md', data: material.rules },
      { name: 'spec/components.md', data: material.components },
    ], priorId ? { commit: 'a'.repeat(40) } : undefined);
    const query = new URLSearchParams({ requestId: randomUUID(), sourceCommit: (priorId ? 'b' : 'a').repeat(40),
      sourceMode: 'private', sourcePath: 'design/v2-fixture',
      ...(priorId ? { intent: 'revise', designId: priorId, expectedVersion: '1' }
        : { intent: 'create', designKey: 'fixture/sample' }),
    });
    const response = await fetch(`${endpoint(project)}/packages?${query}`, {
      method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: new Uint8Array(archive),
    });
    const body = await response.json();
    expect(response.status, body.message).toBe(201);
    return body.result.designId as string;
  }

  async function adoptedFixture() {
    const designId = await publish(projectId, incomingMaterial);
    expect((await command('design.freeze', { designId, version: 1 })).status).toBe(201);
    expect(await publish(projectId, laterMaterial, designId)).toBe(designId);
    const revision = {
      version: 1, title: 'Fixture adopted framework', sourceCommit: 'c'.repeat(40),
      at: clock, by: actor.id, material: establishedMaterial, charter: charter(),
    };
    const commits = await store.read(projectId, 0);
    // Public import is tested independently. Seed an already-adopted revision so a
    // missing import implementation cannot prevent the extraction test from running.
    expect(await store.append({ projectId, revision: commits.length + 1,
      request: { key: 'fixture-adopted', fingerprint: 'fixture-adopted',
        result: { type: 'framework.import', frameworkId, version: 1 } },
      framework: { id: frameworkId, projectId, versions: [revision] },
    })).toBe(true);
    return { revision, fields: { designId, version: 1, frameworkId, expectedVersion: 1, keys: ['rules', 'components'] } };
  }

  it('stores charters per framework revision and rejects missing or cross-project example versions', async () => {
    const local = await publish(projectId, incomingMaterial);
    const foreign = await publish(otherProject, incomingMaterial);
    const fields = { frameworkId, expectedVersion: 0, sourceCommit: 'c'.repeat(40),
      title: 'Fixture framework', material: establishedMaterial };
    for (const example of [
      { designId: local, version: 99 },
      { designId: 'DSN-missing-example', version: 1 },
      { designId: foreign, version: 1 },
    ]) {
      expect([400, 404, 409]).toContain((await command('framework.import', { ...fields, charter: charter(example) })).status);
    }
    expect((await workspace()).frameworks).toEqual([]);
    const first = charter({ designId: local, version: 1 });
    const imported = await command('framework.import', { ...fields, charter: first });
    const receipt = await imported.json();
    expect(imported.status, receipt.message).toBe(201);
    expect(receipt.result).toMatchObject({ type: 'framework.import', frameworkId, version: 1 });
    const second = { ...first, intent: 'Retain the explicit version pin after updating guidance.' };
    expect((await command('framework.import', { ...fields, expectedVersion: 1, sourceCommit: 'd'.repeat(40),
      charter: second,
    })).status).toBe(201);
    expect((await workspace()).frameworks).toEqual([expect.objectContaining({
      id: frameworkId, projectId, versions: [
        expect.objectContaining({ version: 1, charter: first }),
        expect.objectContaining({ version: 2, charter: second }),
      ],
    })]);
  });

  it('rejects missing or incomplete conflict choices without publishing a revision of an adopted framework', async () => {
    const { revision, fields } = await adoptedFixture();
    const before = (await store.read(projectId, 0)).length;
    for (const selection of [{}, { resolutions: { rules: 'keep' } }]) {
      const response = await command('framework.extract', { ...fields, ...selection });
      expect([400, 409], 'conflicting changes require a choice for every selected material').toContain(response.status);
    }
    expect((await store.read(projectId, 0)).length).toBe(before);
    expect((await workspace()).frameworks[0].versions).toEqual([expect.objectContaining(revision)]);
  });

  it('publishes only selected adopted material from the frozen source and preserves the prior framework revision', async () => {
    const { revision, fields } = await adoptedFixture();
    const resolutions = { rules: 'keep', components: 'adopt' };
    const response = await command('framework.extract', { ...fields, resolutions });
    const receipt = await response.json();
    expect(response.status, receipt.message).toBe(201);
    expect(receipt.result).toMatchObject({ type: 'framework.extract', frameworkId, version: 2 });
    const read = await workspace();
    expect(read.designs).toEqual([expect.objectContaining({
      id: fields.designId, frozen: 1, versions: [
        expect.objectContaining({ version: 1 }), expect.objectContaining({ version: 2 }),
      ],
    })]);
    expect(read.frameworks[0].versions).toEqual([
      expect.objectContaining(revision),
      expect.objectContaining({ version: 2, from: { designId: fields.designId, version: 1 },
        material: { rules: establishedMaterial.rules, components: incomingMaterial.components } }),
    ]);
    expect((await command('framework.extract', { ...fields, resolutions })).status).toBe(409);
    expect((await workspace()).frameworks[0].versions).toHaveLength(2);
  });
});
