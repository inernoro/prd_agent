/**
 * FileLogger Unit Tests
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { FileLogger } from '../src/storage/fileLogger.js';
import { existsSync, rmSync, readFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('FileLogger', () => {
  let logger;
  let testDir;

  beforeEach(() => {
    testDir = join(tmpdir(), `prd-executor-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    logger = new FileLogger({ logsDir: testDir });
  });

  afterEach(() => {
    if (testDir && existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('writeLogs()', () => {
    it('should write logs to file', async () => {
      const logs = [
        { time: '2024-01-01T00:00:00Z', stream: 'stdout', text: 'Hello' },
        { time: '2024-01-01T00:00:01Z', stream: 'stderr', text: 'World' },
      ];

      const filePath = await logger.writeLogs('test-job-1', logs);

      assert.ok(existsSync(filePath));

      const content = readFileSync(filePath, 'utf-8');
      const lines = content.trim().split('\n').map(JSON.parse);

      assert.strictEqual(lines.length, 2);
      assert.strictEqual(lines[0].text, 'Hello');
      assert.strictEqual(lines[1].text, 'World');
    });

    it('should create date-based directories', async () => {
      const logs = [{ time: '2024-01-01T00:00:00Z', stream: 'stdout', text: 'Test' }];

      const filePath = await logger.writeLogs('test-job-2', logs);

      // Should contain date path
      assert.ok(filePath.includes('2024'));
    });

    it('should handle empty logs', async () => {
      const filePath = await logger.writeLogs('test-job-3', []);

      assert.ok(existsSync(filePath));
      const content = readFileSync(filePath, 'utf-8');
      assert.strictEqual(content, '');
    });

    it('should escape special characters in job ID', async () => {
      const logs = [{ time: '2024-01-01T00:00:00Z', stream: 'stdout', text: 'Test' }];

      // Job ID with special characters
      const filePath = await logger.writeLogs('test/job:4', logs);

      assert.ok(existsSync(filePath));
      assert.ok(!filePath.includes('test/job:4'));
    });
  });

  describe('readLogs()', () => {
    it('should read logs from file', async () => {
      const originalLogs = [
        { time: '2024-01-01T00:00:00Z', stream: 'stdout', text: 'Line 1' },
        { time: '2024-01-01T00:00:01Z', stream: 'stdout', text: 'Line 2' },
      ];

      const filePath = await logger.writeLogs('read-test', originalLogs);
      const readLogs = await logger.readLogs(filePath);

      assert.strictEqual(readLogs.length, 2);
      assert.strictEqual(readLogs[0].text, 'Line 1');
      assert.strictEqual(readLogs[1].text, 'Line 2');
    });

    it('should return empty array for non-existent file', async () => {
      const logs = await logger.readLogs('/nonexistent/path/file.jsonl');
      assert.deepStrictEqual(logs, []);
    });
  });

  describe('deleteLogs()', () => {
    it('should delete log file', async () => {
      const logs = [{ time: '2024-01-01T00:00:00Z', stream: 'stdout', text: 'Test' }];
      const filePath = await logger.writeLogs('delete-test', logs);

      assert.ok(existsSync(filePath));

      const deleted = await logger.deleteLogs(filePath);
      assert.strictEqual(deleted, true);
      assert.ok(!existsSync(filePath));
    });

    it('should return false for non-existent file', async () => {
      const deleted = await logger.deleteLogs('/nonexistent/file.jsonl');
      assert.strictEqual(deleted, false);
    });
  });

  describe('getLogsSize()', () => {
    it('should return file size', async () => {
      const logs = [
        { time: '2024-01-01T00:00:00Z', stream: 'stdout', text: 'Hello World' },
      ];
      const filePath = await logger.writeLogs('size-test', logs);

      const size = await logger.getLogsSize(filePath);
      assert.ok(size > 0);
    });

    it('should return 0 for non-existent file', async () => {
      const size = await logger.getLogsSize('/nonexistent/file.jsonl');
      assert.strictEqual(size, 0);
    });
  });
});
