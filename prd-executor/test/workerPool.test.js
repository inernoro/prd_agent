/**
 * WorkerPool Unit Tests
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { WorkerPool } from '../src/scheduler/workerPool.js';

describe('WorkerPool', () => {
  let pool;

  beforeEach(() => {
    pool = new WorkerPool({ maxConcurrency: 2 });
  });

  afterEach(async () => {
    if (pool) {
      await pool.shutdown();
      pool = null;
    }
  });

  describe('submit()', () => {
    it('should execute job and return result', async () => {
      const job = {
        jobId: 'pool-test-1',
        command: 'echo',
        args: ['hello'],
      };

      const result = await pool.submit(job);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.jobId, 'pool-test-1');
    });

    it('should respect concurrency limit', async () => {
      const startTimes = [];
      const jobs = [];

      for (let i = 0; i < 4; i++) {
        jobs.push({
          jobId: `concurrent-${i}`,
          command: 'sleep',
          args: ['0.1'],
        });
      }

      pool.on('start', ({ jobId }) => {
        startTimes.push({ jobId, time: Date.now() });
      });

      // Submit all jobs
      const results = await Promise.all(jobs.map(job => pool.submit(job)));

      assert.strictEqual(results.length, 4);
      assert.ok(results.every(r => r.success));

      // Check that max 2 jobs started within first 50ms
      const firstBatchCount = startTimes.filter(
        s => s.time - startTimes[0].time < 50
      ).length;
      assert.ok(firstBatchCount <= 2, 'Should respect concurrency limit');
    });

    it('should emit start and complete events', async () => {
      const events = [];

      pool.on('start', (data) => events.push({ type: 'start', ...data }));
      pool.on('complete', (data) => events.push({ type: 'complete', ...data }));

      await pool.submit({
        jobId: 'event-test',
        command: 'echo',
        args: ['test'],
      });

      assert.ok(events.some(e => e.type === 'start' && e.jobId === 'event-test'));
      assert.ok(events.some(e => e.type === 'complete' && e.jobId === 'event-test'));
    });
  });

  describe('cancel()', () => {
    it('should cancel running job', async () => {
      const job = {
        jobId: 'cancel-test',
        command: 'sleep',
        args: ['30'],
      };

      const submitPromise = pool.submit(job);

      // Wait for job to start
      await new Promise(r => setTimeout(r, 50));

      const cancelled = pool.cancel('cancel-test');
      assert.strictEqual(cancelled, true);

      const result = await submitPromise;
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.cancelled, true);
    });

    it('should cancel queued job', async () => {
      // Fill workers
      const longJobs = [
        pool.submit({ jobId: 'long-1', command: 'sleep', args: ['5'] }),
        pool.submit({ jobId: 'long-2', command: 'sleep', args: ['5'] }),
      ];

      // Queue a job
      const queuedPromise = pool.submit({ jobId: 'queued', command: 'echo', args: ['test'] });

      // Wait a bit for queue
      await new Promise(r => setTimeout(r, 50));

      // Cancel the queued job
      const cancelled = pool.cancel('queued');
      assert.strictEqual(cancelled, true);

      const result = await queuedPromise;
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.cancelled, true);

      // Clean up long jobs
      pool.cancel('long-1');
      pool.cancel('long-2');
      await Promise.all(longJobs);
    });

    it('should return false for unknown job', () => {
      const cancelled = pool.cancel('unknown-job');
      assert.strictEqual(cancelled, false);
    });
  });

  describe('getStatus()', () => {
    it('should return current status', async () => {
      const status = pool.getStatus();

      assert.strictEqual(status.maxConcurrency, 2);
      assert.strictEqual(status.activeWorkers, 0);
      assert.strictEqual(status.queuedJobs, 0);
    });

    it('should reflect running jobs', async () => {
      const longJob = pool.submit({
        jobId: 'status-test',
        command: 'sleep',
        args: ['5'],
      });

      // Wait for job to start
      await new Promise(r => setTimeout(r, 50));

      const status = pool.getStatus();
      assert.strictEqual(status.activeWorkers, 1);

      pool.cancel('status-test');
      await longJob;
    });
  });

  describe('setMaxConcurrency()', () => {
    it('should update max concurrency', () => {
      pool.setMaxConcurrency(5);
      const status = pool.getStatus();
      assert.strictEqual(status.maxConcurrency, 5);
    });

    it('should process queued jobs when concurrency increases', async () => {
      // Create pool with concurrency 1
      pool = new WorkerPool({ maxConcurrency: 1 });

      const results = [];

      // Submit 3 jobs (1 will run, 2 will queue)
      const jobs = [
        pool.submit({ jobId: 'inc-1', command: 'echo', args: ['1'] }),
        pool.submit({ jobId: 'inc-2', command: 'echo', args: ['2'] }),
        pool.submit({ jobId: 'inc-3', command: 'echo', args: ['3'] }),
      ];

      // Increase concurrency
      pool.setMaxConcurrency(3);

      const allResults = await Promise.all(jobs);
      assert.strictEqual(allResults.length, 3);
      assert.ok(allResults.every(r => r.success));
    });
  });

  describe('shutdown()', () => {
    it('should cancel all jobs on shutdown', async () => {
      const jobs = [
        pool.submit({ jobId: 'shutdown-1', command: 'sleep', args: ['30'] }),
        pool.submit({ jobId: 'shutdown-2', command: 'sleep', args: ['30'] }),
      ];

      // Wait for jobs to start
      await new Promise(r => setTimeout(r, 50));

      await pool.shutdown();

      const results = await Promise.all(jobs);
      assert.ok(results.every(r => !r.success));
    });
  });
});
