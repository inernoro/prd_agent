/**
 * CommandExecutor Unit Tests
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { CommandExecutor } from '../src/executor/commandExecutor.js';

describe('CommandExecutor', () => {
  let executor;

  afterEach(() => {
    if (executor) {
      executor.cancel();
      executor = null;
    }
  });

  describe('execute()', () => {
    it('should execute simple command successfully', async () => {
      executor = new CommandExecutor({
        jobId: 'test-1',
        command: 'echo',
        args: ['hello', 'world'],
      });

      const result = await executor.execute();

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.exitCode, 0);
      assert.ok(result.duration >= 0);
      assert.ok(result.logs.some(log => log.text.includes('hello world')));
    });

    it('should capture stdout and stderr', async () => {
      executor = new CommandExecutor({
        jobId: 'test-2',
        command: 'sh',
        args: ['-c', 'echo stdout; echo stderr >&2'],
      });

      const result = await executor.execute();

      assert.strictEqual(result.success, true);
      assert.ok(result.logs.some(log => log.stream === 'stdout' && log.text.includes('stdout')));
      assert.ok(result.logs.some(log => log.stream === 'stderr' && log.text.includes('stderr')));
    });

    it('should return failure for non-zero exit code', async () => {
      executor = new CommandExecutor({
        jobId: 'test-3',
        command: 'sh',
        args: ['-c', 'exit 1'],
      });

      const result = await executor.execute();

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.exitCode, 1);
    });

    it('should handle command not found', async () => {
      executor = new CommandExecutor({
        jobId: 'test-4',
        command: 'nonexistent_command_xyz',
        args: [],
      });

      const result = await executor.execute();

      assert.strictEqual(result.success, false);
    });

    it('should respect timeout', async () => {
      executor = new CommandExecutor({
        jobId: 'test-5',
        command: 'sleep',
        args: ['10'],
        timeout: 100,
      });

      const result = await executor.execute();

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.killed, true);
      assert.ok(result.duration < 5000);
    });

    it('should pass environment variables', async () => {
      executor = new CommandExecutor({
        jobId: 'test-6',
        command: 'sh',
        args: ['-c', 'echo $TEST_VAR'],
        env: { TEST_VAR: 'test_value' },
      });

      const result = await executor.execute();

      assert.strictEqual(result.success, true);
      assert.ok(result.logs.some(log => log.text.includes('test_value')));
    });

    it('should use working directory', async () => {
      executor = new CommandExecutor({
        jobId: 'test-7',
        command: 'pwd',
        args: [],
        workDir: '/tmp',
      });

      const result = await executor.execute();

      assert.strictEqual(result.success, true);
      assert.ok(result.logs.some(log => log.text.includes('/tmp')));
    });

    it('should emit output events', async () => {
      executor = new CommandExecutor({
        jobId: 'test-8',
        command: 'echo',
        args: ['event test'],
      });

      const outputs = [];
      executor.on('output', (data) => outputs.push(data));

      await executor.execute();

      assert.ok(outputs.length > 0);
      assert.ok(outputs.some(o => o.text.includes('event test')));
    });
  });

  describe('cancel()', () => {
    it('should cancel running command', async () => {
      executor = new CommandExecutor({
        jobId: 'test-cancel',
        command: 'sleep',
        args: ['30'],
      });

      const executePromise = executor.execute();

      // Wait a bit then cancel
      await new Promise(r => setTimeout(r, 50));
      const cancelled = executor.cancel();

      const result = await executePromise;

      assert.strictEqual(cancelled, true);
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.cancelled, true);
    });

    it('should return false if not running', () => {
      executor = new CommandExecutor({
        jobId: 'test-no-cancel',
        command: 'echo',
        args: ['test'],
      });

      const cancelled = executor.cancel();
      assert.strictEqual(cancelled, false);
    });
  });
});
