import { describe, expect, it } from 'vitest';
import {
  resolveStateBootstrapMode,
  seedStateFromJsonIfAllowed,
  shouldSeedStateFromJson,
} from '../../src/services/state-bootstrap.js';

describe('state bootstrap mode', () => {
  it('defaults to fresh so old state.json is not imported into a new mongo store', () => {
    const mode = resolveStateBootstrapMode(undefined);

    expect(mode).toBe('fresh');
    expect(shouldSeedStateFromJson(mode)).toBe(false);
  });

  it('allows explicit migrate mode to import legacy state.json', () => {
    const mode = resolveStateBootstrapMode('migrate');

    expect(mode).toBe('migrate');
    expect(shouldSeedStateFromJson(mode)).toBe(true);
  });

  it('normalizes whitespace and case', () => {
    expect(resolveStateBootstrapMode(' Fresh ')).toBe('fresh');
    expect(resolveStateBootstrapMode(' MIGRATE ')).toBe('migrate');
  });

  it('rejects unknown modes before CDS starts', () => {
    expect(() => resolveStateBootstrapMode('auto')).toThrow(/Unknown CDS_STATE_BOOTSTRAP_MODE/);
  });

  it('skips seeding old JSON state in fresh mode', async () => {
    const seeded: unknown[] = [];

    const result = await seedStateFromJsonIfAllowed(
      'fresh',
      { load: () => null, seedIfEmpty: async (state) => { seeded.push(state); } },
      { load: () => ({ branches: { old: {} } }) },
    );

    expect(result).toBe('skipped');
    expect(seeded).toHaveLength(0);
  });

  it('seeds old JSON state only in migrate mode', async () => {
    const seeded: unknown[] = [];
    const legacyState = { branches: { old: {} } };

    const result = await seedStateFromJsonIfAllowed(
      'migrate',
      { load: () => null, seedIfEmpty: async (state) => { seeded.push(state); } },
      { load: () => legacyState },
    );

    expect(result).toBe('seeded');
    expect(seeded).toEqual([legacyState]);
  });

  it('does not seed when the target store already has state', async () => {
    const result = await seedStateFromJsonIfAllowed(
      'migrate',
      { load: () => ({ branches: {} }), seedIfEmpty: async () => { throw new Error('should not seed'); } },
      { load: () => ({ branches: { old: {} } }) },
    );

    expect(result).toBe('target-not-empty');
  });
});
