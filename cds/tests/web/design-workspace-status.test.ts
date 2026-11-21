import { describe, expect, it } from 'vitest';
import { designStatus } from '../../web/src/pages/design-workspace/design-ui';
import type { DesignEntry, DesignRun, DesignVersion } from '../../src/shared/design-workspace.js';

const at = '2026-11-21T09:05:00.000Z';
const first: DesignVersion = { version: 1, title: 'Fixture', sourceCommit: 'a'.repeat(40), sha256: '1'.repeat(64),
  prototypeId: 'fixture-prototype', createdAt: at, publisher: { id: 'author', label: 'Author' }, rationale: 'Fixture',
  screens: [], acceptance: [], spec: {}, tags: [], decisionIds: [], resolves: {} };
const signed: DesignRun = { id: 'first-run', version: 1, pullRequest: 7, commit: 'a'.repeat(40), previewUrl: 'https://fixture.test/',
  createdAt: at, cells: [], verdict: 'passed', signed: { by: 'reviewer', at, verdict: 'passed' }, issues: {} };
const entry: DesignEntry = { id: 'DSN-fixture', projectId: 'fixture', versions: [first], frozen: 1, pullRequest: 7, comments: [], runs: [signed] };

describe('design board signatures', () => {
  it('only displays a signature for the current draft, frozen version and linked PR', () => {
    expect(designStatus(entry)).toBe('signed');
    const second = { ...first, version: 2 };
    expect(designStatus({ ...entry, versions: [first, second] })).toBe('active');
    expect(designStatus({ ...entry, versions: [first, second], frozen: 2 })).toBe('active');
    expect(designStatus({ ...entry, pullRequest: 8 })).toBe('active');
    expect(designStatus({ ...entry, pullRequest: undefined })).toBe('frozen');
    expect(designStatus({ ...entry, currentSignoffRunId: null })).toBe('active');
    expect(designStatus({ ...entry, currentSignoffRunId: signed.id })).toBe('signed');
  });

  it('keeps the latest run authoritative for the currently linked PR', () => {
    const open = { ...signed, id: 'new-run', signed: undefined, verdict: 'needs_evidence' as const };
    expect(designStatus({ ...entry, runs: [signed, open] })).toBe('active');
    expect(designStatus({ ...entry, runs: [signed, { ...open, pullRequest: 8 }] })).toBe('signed');
  });
});
