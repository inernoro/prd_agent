/**
 * HTTP Receiver Unit Tests
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { createHttpApi } from '../src/receiver/httpReceiver.js';

// Mock executor for testing
function createMockExecutor() {
  const jobs = new Map();
  let concurrency = 3;

  return {
    async submit(job) {
      jobs.set(job.jobId, { ...job, status: 'completed', success: true });
      return { success: true, jobId: job.jobId, duration: 100 };
    },
    async cancel(jobId) {
      if (jobs.has(jobId)) {
        jobs.get(jobId).status = 'cancelled';
        return true;
      }
      return false;
    },
    async getJob(jobId) {
      return jobs.get(jobId) || null;
    },
    async listJobs() {
      return { jobs: Array.from(jobs.values()), total: jobs.size };
    },
    async getStatus() {
      return { activeWorkers: 0, queuedJobs: 0, maxConcurrency: concurrency };
    },
    async getStats() {
      return { total: jobs.size, success: jobs.size, failed: 0 };
    },
    setMaxConcurrency(max) {
      concurrency = max;
    },
  };
}

describe('HTTP Receiver', () => {
  let app;
  let server;
  let baseUrl;
  let executor;

  beforeEach(async () => {
    executor = createMockExecutor();
    app = createHttpApi(executor);

    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const { port } = server.address();
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  describe('POST /jobs', () => {
    it('should submit job synchronously', async () => {
      const response = await fetch(`${baseUrl}/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          command: 'echo',
          args: ['test'],
        }),
      });

      assert.strictEqual(response.status, 200);
      const data = await response.json();
      assert.ok(data.jobId);
      assert.strictEqual(data.success, true);
    });

    it('should reject missing command', async () => {
      const response = await fetch(`${baseUrl}/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ args: ['test'] }),
      });

      assert.strictEqual(response.status, 400);
      const data = await response.json();
      assert.ok(data.error.includes('command'));
    });
  });

  describe('POST /jobs/async', () => {
    it('should submit job asynchronously', async () => {
      const response = await fetch(`${baseUrl}/jobs/async`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          command: 'echo',
          args: ['test'],
        }),
      });

      assert.strictEqual(response.status, 202);
      const data = await response.json();
      assert.ok(data.jobId);
      assert.strictEqual(data.status, 'queued');
    });
  });

  describe('DELETE /jobs/:jobId', () => {
    it('should cancel job', async () => {
      // First submit a job
      const submitRes = await fetch(`${baseUrl}/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: 'echo', args: ['test'] }),
      });
      const { jobId } = await submitRes.json();

      // Then cancel it
      const response = await fetch(`${baseUrl}/jobs/${jobId}`, {
        method: 'DELETE',
      });

      assert.strictEqual(response.status, 200);
    });

    it('should return 404 for unknown job', async () => {
      const response = await fetch(`${baseUrl}/jobs/unknown-id`, {
        method: 'DELETE',
      });

      assert.strictEqual(response.status, 404);
    });
  });

  describe('GET /jobs/:jobId', () => {
    it('should get job details', async () => {
      // First submit a job
      const submitRes = await fetch(`${baseUrl}/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: 'echo', args: ['test'] }),
      });
      const { jobId } = await submitRes.json();

      // Then get its details
      const response = await fetch(`${baseUrl}/jobs/${jobId}`);

      assert.strictEqual(response.status, 200);
      const data = await response.json();
      assert.strictEqual(data.jobId, jobId);
    });

    it('should return 404 for unknown job', async () => {
      const response = await fetch(`${baseUrl}/jobs/unknown-id`);
      assert.strictEqual(response.status, 404);
    });
  });

  describe('GET /jobs', () => {
    it('should list jobs', async () => {
      const response = await fetch(`${baseUrl}/jobs`);

      assert.strictEqual(response.status, 200);
      const data = await response.json();
      assert.ok(Array.isArray(data.jobs));
      assert.ok(typeof data.total === 'number');
    });
  });

  describe('GET /status', () => {
    it('should return executor status', async () => {
      const response = await fetch(`${baseUrl}/status`);

      assert.strictEqual(response.status, 200);
      const data = await response.json();
      assert.ok('activeWorkers' in data);
      assert.ok('maxConcurrency' in data);
    });
  });

  describe('GET /stats', () => {
    it('should return statistics', async () => {
      const response = await fetch(`${baseUrl}/stats`);

      assert.strictEqual(response.status, 200);
      const data = await response.json();
      assert.ok('total' in data);
    });
  });

  describe('PUT /config/concurrency', () => {
    it('should update concurrency', async () => {
      const response = await fetch(`${baseUrl}/config/concurrency`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ max: 5 }),
      });

      assert.strictEqual(response.status, 200);
      const data = await response.json();
      assert.strictEqual(data.maxConcurrency, 5);
    });

    it('should reject invalid concurrency', async () => {
      const response = await fetch(`${baseUrl}/config/concurrency`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ max: 0 }),
      });

      assert.strictEqual(response.status, 400);
    });
  });

  describe('GET /health', () => {
    it('should return health status', async () => {
      const response = await fetch(`${baseUrl}/health`);

      assert.strictEqual(response.status, 200);
      const data = await response.json();
      assert.strictEqual(data.status, 'ok');
    });
  });
});
