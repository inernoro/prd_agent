/**
 * Tests for JsonStateBackingStore — the extracted file-I/O layer that
 * now sits underneath StateService. These tests pin the three behaviors
 * that used to be inline in state.ts and are the blast radius of the
 * P3 refactor:
 *
 *   1. Atomic write: data on disk after save() is always parseable JSON
 *      (no partial writes from a crashed save).
 *   2. Recovery: a corrupted state.json falls back to the most recent
 *      readable .bak.* snapshot.
 *   3. Rotation: the number of .bak.* files never exceeds MAX_STATE_BACKUPS.
 *
 * These were covered indirectly by state.test.ts; now that the code lives
 * in a dedicated module we test it directly too so regressions surface
 * with a precise failing test.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  JsonStateBackingStore,
  MAX_STATE_BACKUPS,
} from '../../src/infra/state-store/json-backing-store.js';
import type { CdsState } from '../../src/types.js';

function emptyState(): CdsState {
  return {
    routingRules: [],
    buildProfiles: [],
    branches: {},
    nextPortIndex: 0,
    logs: {},
    defaultBranch: null,
    customEnv: {},
    infraServices: [],
    previewMode: 'multi',
  };
}

describe('JsonStateBackingStore', () => {
  let tmpDir: string;
  let filePath: string;
  let store: JsonStateBackingStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-json-store-test-'));
    filePath = path.join(tmpDir, 'state.json');
    store = new JsonStateBackingStore(filePath);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('load', () => {
    it('returns null when no state file and no backups exist', () => {
      expect(store.load()).toBeNull();
    });

    it('returns the persisted state after a save', () => {
      const state = emptyState();
      state.nextPortIndex = 42;
      store.save(state);

      const loaded = store.load();
      expect(loaded?.nextPortIndex).toBe(42);
    });

    it('recovers from the most recent .bak.* when the primary file is corrupt', () => {
      // Save a valid state first (creates a .bak)
      const goodState = emptyState();
      goodState.nextPortIndex = 1;
      store.save(goodState);

      // Save again to ensure at least one rolling backup exists
      goodState.nextPortIndex = 2;
      store.save(goodState);

      // Corrupt the primary file
      fs.writeFileSync(filePath, '{ this is not: valid json');

      const recovered = store.load();
      expect(recovered).not.toBeNull();
      // Recovered snapshot should have the most recent valid value
      expect(recovered?.nextPortIndex).toBe(2);
    });

    it('returns null when every backup is also corrupt', () => {
      // Seed a state file that we'll corrupt
      fs.writeFileSync(filePath, '{corrupt}');
      // Create a corrupt backup so recovery scans it
      fs.writeFileSync(filePath + '.bak.2026-01-01T00-00-00-000Z', '{also corrupt}');

      expect(store.load()).toBeNull();
    });
  });

  describe('save', () => {
    it('writes parseable JSON that round-trips', () => {
      const state = emptyState();
      state.branches = {
        'b1': {
          id: 'b1',
          name: 'feature/x',
          status: 'running',
          serviceStates: {},
          urls: {},
          createdAt: '2026-04-13T00:00:00Z',
          updatedAt: '2026-04-13T00:00:00Z',
          lastAccessed: '2026-04-13T00:00:00Z',
          webPort: 5500,
          apiPort: 5000,
          envVars: {},
        } as any,
      };

      store.save(state);
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      expect(parsed.branches.b1.name).toBe('feature/x');
    });

    it('creates a .bak.<timestamp> snapshot on every save', () => {
      store.save(emptyState());
      const backups = fs
        .readdirSync(tmpDir)
        .filter((f) => f.startsWith('state.json.bak.'));
      expect(backups.length).toBeGreaterThanOrEqual(1);
    });

    it('prunes old backups so no more than MAX_STATE_BACKUPS remain', async () => {
      // Trigger enough saves to overflow the backup window. Sleep 2ms
      // between each so the ISO timestamps in backup filenames differ.
      for (let i = 0; i < MAX_STATE_BACKUPS + 5; i++) {
        const state = emptyState();
        state.nextPortIndex = i;
        store.save(state);
        await new Promise((r) => setTimeout(r, 2));
      }

      const backups = fs
        .readdirSync(tmpDir)
        .filter((f) => f.startsWith('state.json.bak.'));
      expect(backups.length).toBeLessThanOrEqual(MAX_STATE_BACKUPS);
    });

    it('creates the parent directory if it does not exist', () => {
      const deepPath = path.join(tmpDir, 'a', 'b', 'c', 'state.json');
      const deepStore = new JsonStateBackingStore(deepPath);
      deepStore.save(emptyState());
      expect(fs.existsSync(deepPath)).toBe(true);
    });
  });

  describe('kind tag', () => {
    it('reports "json" for log grepping', () => {
      expect(store.kind).toBe('json');
    });
  });
});
