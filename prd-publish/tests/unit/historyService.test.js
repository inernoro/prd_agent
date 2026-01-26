import { jest } from '@jest/globals';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { existsSync, unlinkSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const testHistoryFile = resolve(__dirname, '../fixtures/test-history.json');

// Mock config
jest.unstable_mockModule('../../src/config.js', () => ({
  config: {
    paths: {
      historyFile: testHistoryFile,
    },
  },
}));

const {
  readHistory,
  writeHistory,
  addRecord,
  getHistory,
  getRecord,
  getLastSuccessful,
  getLastDeploy,
  getStats,
  clearHistory,
} = await import('../../src/services/historyService.js');

describe('HistoryService', () => {
  beforeEach(async () => {
    // Clean up test file
    if (existsSync(testHistoryFile)) {
      unlinkSync(testHistoryFile);
    }
  });

  afterAll(async () => {
    // Clean up
    if (existsSync(testHistoryFile)) {
      unlinkSync(testHistoryFile);
    }
  });

  describe('readHistory', () => {
    it('should return empty array when file does not exist', async () => {
      const history = await readHistory();
      expect(history).toEqual([]);
    });

    it('should read existing history', async () => {
      await writeHistory([{ id: 'test1' }]);
      const history = await readHistory();
      expect(history).toHaveLength(1);
      expect(history[0].id).toBe('test1');
    });
  });

  describe('writeHistory', () => {
    it('should write history to file', async () => {
      await writeHistory([{ id: 'test1' }, { id: 'test2' }]);
      const history = await readHistory();
      expect(history).toHaveLength(2);
    });
  });

  describe('addRecord', () => {
    it('should add record to beginning of history', async () => {
      await addRecord({ id: 'record1', status: 'success' });
      await addRecord({ id: 'record2', status: 'failed' });

      const history = await readHistory();
      expect(history[0].id).toBe('record2');
      expect(history[1].id).toBe('record1');
    });

    it('should add createdAt timestamp', async () => {
      await addRecord({ id: 'record1' });
      const history = await readHistory();
      expect(history[0].createdAt).toBeTruthy();
    });

    it('should limit history to 100 records', async () => {
      for (let i = 0; i < 110; i++) {
        await addRecord({ id: `record${i}` });
      }
      const history = await readHistory();
      expect(history).toHaveLength(100);
    });
  });

  describe('getHistory', () => {
    beforeEach(async () => {
      await writeHistory([
        { id: 'r1', status: 'success' },
        { id: 'r2', status: 'failed' },
        { id: 'r3', status: 'success' },
        { id: 'r4', status: 'cancelled' },
        { id: 'r5', status: 'success' },
      ]);
    });

    it('should return paginated history', async () => {
      const history = await getHistory({ limit: 2 });
      expect(history).toHaveLength(2);
    });

    it('should support offset', async () => {
      const history = await getHistory({ limit: 2, offset: 2 });
      expect(history[0].id).toBe('r3');
    });

    it('should filter by status', async () => {
      const history = await getHistory({ status: 'success' });
      expect(history.every(r => r.status === 'success')).toBe(true);
    });
  });

  describe('getRecord', () => {
    it('should find record by id', async () => {
      await writeHistory([
        { id: 'r1', status: 'success' },
        { id: 'r2', status: 'failed' },
      ]);

      const record = await getRecord('r2');
      expect(record).toBeTruthy();
      expect(record.id).toBe('r2');
    });

    it('should return null for non-existent id', async () => {
      await writeHistory([{ id: 'r1' }]);
      const record = await getRecord('nonexistent');
      expect(record).toBeNull();
    });
  });

  describe('getLastSuccessful', () => {
    it('should return last successful deployment', async () => {
      await writeHistory([
        { id: 'r1', status: 'failed' },
        { id: 'r2', status: 'success' },
        { id: 'r3', status: 'failed' },
      ]);

      const record = await getLastSuccessful();
      expect(record.id).toBe('r2');
    });

    it('should return null if no successful deployments', async () => {
      await writeHistory([
        { id: 'r1', status: 'failed' },
        { id: 'r2', status: 'cancelled' },
      ]);

      const record = await getLastSuccessful();
      expect(record).toBeNull();
    });
  });

  describe('getLastDeploy', () => {
    it('should return most recent deployment', async () => {
      await writeHistory([
        { id: 'r1', status: 'success' },
        { id: 'r2', status: 'failed' },
      ]);

      const record = await getLastDeploy();
      expect(record.id).toBe('r1');
    });

    it('should return null for empty history', async () => {
      const record = await getLastDeploy();
      expect(record).toBeNull();
    });
  });

  describe('getStats', () => {
    it('should calculate statistics', async () => {
      await writeHistory([
        { id: 'r1', status: 'success', duration: 1000 },
        { id: 'r2', status: 'failed', duration: 2000 },
        { id: 'r3', status: 'success', duration: 3000 },
        { id: 'r4', status: 'cancelled', duration: 500 },
      ]);

      const stats = await getStats();
      expect(stats.total).toBe(4);
      expect(stats.successful).toBe(2);
      expect(stats.failed).toBe(1);
      expect(stats.cancelled).toBe(1);
      expect(stats.successRate).toBe('50.0');
      expect(stats.avgDuration).toBe(1625);
    });

    it('should handle empty history', async () => {
      const stats = await getStats();
      expect(stats.total).toBe(0);
      expect(stats.successRate).toBe('0');
    });
  });

  describe('clearHistory', () => {
    it('should clear all history', async () => {
      await writeHistory([{ id: 'r1' }, { id: 'r2' }]);
      await clearHistory();
      const history = await readHistory();
      expect(history).toEqual([]);
    });
  });
});
