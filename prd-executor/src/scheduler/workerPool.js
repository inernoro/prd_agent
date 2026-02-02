import { EventEmitter } from 'events';
import { CommandExecutor } from '../executor/commandExecutor.js';
import { config } from '../config.js';

/**
 * Worker Pool - manages concurrent job execution
 */
export class WorkerPool extends EventEmitter {
  constructor(options = {}) {
    super();
    this.maxConcurrency = options.maxConcurrency || config.concurrency.max;
    this.workers = new Map(); // workerId -> { job, executor, startedAt }
    this.queue = []; // pending jobs
    this.stats = {
      completed: 0,
      failed: 0,
      running: 0,
    };
  }

  /**
   * Submit a job for execution
   * @param {Object} job - Job to execute
   * @returns {Promise<Object>} Execution result
   */
  async submit(job) {
    return new Promise((resolve, reject) => {
      const task = { job, resolve, reject };

      if (this.workers.size < this.maxConcurrency) {
        this._startWorker(task);
      } else {
        this.queue.push(task);
        this.emit('queued', { jobId: job.jobId, position: this.queue.length });
      }
    });
  }

  /**
   * Start a worker for a task
   */
  async _startWorker(task) {
    const { job, resolve } = task;
    const workerId = `worker-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const executor = new CommandExecutor(job);

    this.workers.set(workerId, {
      job,
      executor,
      startedAt: new Date(),
    });

    this.stats.running = this.workers.size;
    this.emit('start', { workerId, jobId: job.jobId });

    // Forward output events
    executor.on('output', (logEntry) => {
      this.emit('output', { workerId, jobId: job.jobId, ...logEntry });
    });

    try {
      const result = await executor.execute();

      // Update stats
      if (result.success) {
        this.stats.completed++;
      } else {
        this.stats.failed++;
      }

      this.emit('complete', { workerId, jobId: job.jobId, result });
      resolve(result);
    } catch (error) {
      this.stats.failed++;
      this.emit('error', { workerId, jobId: job.jobId, error });
      resolve({
        success: false,
        exitCode: -1,
        duration: executor.getDuration(),
        logs: executor.logs,
        error: error.message,
      });
    } finally {
      // Cleanup worker
      this.workers.delete(workerId);
      this.stats.running = this.workers.size;

      // Process next in queue
      this._processQueue();
    }
  }

  /**
   * Process next job in queue
   */
  _processQueue() {
    if (this.queue.length > 0 && this.workers.size < this.maxConcurrency) {
      const task = this.queue.shift();
      this._startWorker(task);
    }
  }

  /**
   * Cancel a running job
   * @param {string} jobId - Job ID to cancel
   * @returns {boolean} Whether cancellation was successful
   */
  cancel(jobId) {
    // Check running workers
    for (const [workerId, worker] of this.workers) {
      if (worker.job.jobId === jobId) {
        worker.executor.kill();
        this.emit('cancelled', { workerId, jobId });
        return true;
      }
    }

    // Check queue
    const queueIndex = this.queue.findIndex((t) => t.job.jobId === jobId);
    if (queueIndex >= 0) {
      const [task] = this.queue.splice(queueIndex, 1);
      task.resolve({
        success: false,
        exitCode: -1,
        duration: 0,
        logs: [],
        cancelled: true,
      });
      this.emit('cancelled', { jobId });
      return true;
    }

    return false;
  }

  /**
   * Get current status
   * @returns {Object} Pool status
   */
  getStatus() {
    const workers = [];
    for (const [workerId, worker] of this.workers) {
      workers.push({
        workerId,
        jobId: worker.job.jobId,
        command: worker.job.command,
        startedAt: worker.startedAt,
        duration: Date.now() - worker.startedAt.getTime(),
      });
    }

    return {
      maxConcurrency: this.maxConcurrency,
      running: this.workers.size,
      pending: this.queue.length,
      workers,
      stats: { ...this.stats },
    };
  }

  /**
   * Update max concurrency
   * @param {number} max - New max concurrency
   */
  setMaxConcurrency(max) {
    this.maxConcurrency = max;
    // Process queue if we increased concurrency
    while (this.workers.size < this.maxConcurrency && this.queue.length > 0) {
      this._processQueue();
    }
  }

  /**
   * Graceful shutdown
   * @returns {Promise<void>}
   */
  async shutdown() {
    // Cancel all queued jobs
    while (this.queue.length > 0) {
      const task = this.queue.shift();
      task.resolve({
        success: false,
        exitCode: -1,
        duration: 0,
        logs: [],
        cancelled: true,
        reason: 'shutdown',
      });
    }

    // Wait for running jobs to complete (with timeout)
    const timeout = 30000;
    const start = Date.now();

    while (this.workers.size > 0) {
      if (Date.now() - start > timeout) {
        // Force kill remaining
        for (const [, worker] of this.workers) {
          worker.executor.kill('SIGKILL');
        }
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

export default WorkerPool;
