import { v4 as uuidv4 } from 'uuid';
import { config } from './config.js';
import { WorkerPool } from './scheduler/workerPool.js';
import { StreamConsumer } from './receiver/streamConsumer.js';
import { CallbackHandler } from './callback/callbackHandler.js';
import { FileLogger } from './storage/fileLogger.js';
import { MongoLogger } from './storage/mongoLogger.js';
import { createHttpApi } from './receiver/httpReceiver.js';

// ASCII Art Logo
const LOGO = `
\x1b[35m
  ██████╗ ██████╗ ██████╗       ███████╗██╗  ██╗███████╗ ██████╗██╗   ██╗████████╗ ██████╗ ██████╗
  ██╔══██╗██╔══██╗██╔══██╗      ██╔════╝╚██╗██╔╝██╔════╝██╔════╝██║   ██║╚══██╔══╝██╔═══██╗██╔══██╗
  ██████╔╝██████╔╝██║  ██║█████╗█████╗   ╚███╔╝ █████╗  ██║     ██║   ██║   ██║   ██║   ██║██████╔╝
  ██╔═══╝ ██╔══██╗██║  ██║╚════╝██╔══╝   ██╔██╗ ██╔══╝  ██║     ██║   ██║   ██║   ██║   ██║██╔══██╗
  ██║     ██║  ██║██████╔╝      ███████╗██╔╝ ██╗███████╗╚██████╗╚██████╔╝   ██║   ╚██████╔╝██║  ██║
  ╚═╝     ╚═╝  ╚═╝╚═════╝       ╚══════╝╚═╝  ╚═╝╚══════╝ ╚═════╝ ╚═════╝    ╚═╝    ╚═════╝ ╚═╝  ╚═╝
\x1b[0m
\x1b[90m  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m
\x1b[33m  ⚡ Lightweight Command Executor with Queue Support\x1b[0m
\x1b[90m  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m
`;

/**
 * Main Executor - orchestrates all components
 */
class Executor {
  constructor() {
    this.workerPool = new WorkerPool();
    this.streamConsumer = null;
    this.callbackHandler = null;
    this.fileLogger = new FileLogger();
    this.mongoLogger = new MongoLogger();
    this.httpServer = null;
  }

  async start() {
    console.log(LOGO);

    // Connect to MongoDB
    try {
      await this.mongoLogger.connect();
      console.log(`  \x1b[32m●\x1b[0m MongoDB    \x1b[90m→\x1b[0m  Connected`);
    } catch (err) {
      console.error(`  \x1b[31m●\x1b[0m MongoDB    \x1b[90m→\x1b[0m  \x1b[31mFailed: ${err.message}\x1b[0m`);
      console.error(`  \x1b[33m⚠\x1b[0m Running without MongoDB logging`);
    }

    // Initialize stream consumer
    if (config.queue.enabled) {
      this.streamConsumer = new StreamConsumer();
      this.callbackHandler = new CallbackHandler({ streamConsumer: this.streamConsumer });

      try {
        await this.streamConsumer.start((job) => this._handleJob(job));
        console.log(`  \x1b[32m●\x1b[0m Redis      \x1b[90m→\x1b[0m  Connected (Queue enabled)`);
      } catch (err) {
        console.error(`  \x1b[31m●\x1b[0m Redis      \x1b[90m→\x1b[0m  \x1b[31mFailed: ${err.message}\x1b[0m`);
      }
    } else {
      this.callbackHandler = new CallbackHandler();
      console.log(`  \x1b[33m●\x1b[0m Redis      \x1b[90m→\x1b[0m  Queue disabled`);
    }

    // Start HTTP API
    if (config.api.enabled) {
      const app = createHttpApi(this);
      this.httpServer = app.listen(config.api.port, config.api.host, () => {
        console.log(`  \x1b[32m●\x1b[0m API        \x1b[90m→\x1b[0m  \x1b[36mhttp://${config.api.host}:${config.api.port}\x1b[0m`);
      });
    }

    // Worker pool events
    this.workerPool.on('start', ({ workerId, jobId }) => {
      console.log(`  \x1b[36m▶\x1b[0m [${workerId}] Started job ${jobId}`);
    });

    this.workerPool.on('complete', ({ workerId, jobId, result }) => {
      const icon = result.success ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
      console.log(`  ${icon} [${workerId}] Job ${jobId} ${result.success ? 'completed' : 'failed'} (${result.duration}ms)`);
    });

    console.log('');
    console.log(`  \x1b[32m●\x1b[0m Concurrency\x1b[90m→\x1b[0m  ${config.concurrency.max} workers`);
    console.log(`  \x1b[32m●\x1b[0m Logs       \x1b[90m→\x1b[0m  ${config.logs.dir}`);
    console.log('');
    console.log('\x1b[90m  Press Ctrl+C to stop\x1b[0m');
    console.log('');

    // Update status periodically
    setInterval(() => this._updateStatus(), 5000);
  }

  /**
   * Handle a job from queue or API
   */
  async _handleJob(job) {
    job._startedAt = new Date().toISOString();

    // Log start
    try {
      await this.mongoLogger.logStart(job);
    } catch (err) {
      console.error(`[Executor] Failed to log job start:`, err.message);
    }

    // Callback start
    await this.callbackHandler.onStart(job);

    // Execute
    const result = await this.workerPool.submit(job);

    // Save logs to file
    let logsFile = null;
    if (result.logs.length > 0) {
      try {
        logsFile = await this.fileLogger.writeLogs(job.jobId, result.logs);
      } catch (err) {
        console.error(`[Executor] Failed to write logs:`, err.message);
      }
    }

    // Callback complete
    const callbackResult = await this.callbackHandler.onComplete(job, result, logsFile);

    // Log completion
    try {
      await this.mongoLogger.logComplete(job.jobId, result, callbackResult, logsFile);
    } catch (err) {
      console.error(`[Executor] Failed to log job complete:`, err.message);
    }

    return result;
  }

  /**
   * Submit a job (internal API)
   */
  async submit(job) {
    if (!job.jobId) job.jobId = uuidv4();
    if (!job.createdAt) job.createdAt = new Date().toISOString();

    return this._handleJob(job);
  }

  /**
   * Cancel a job
   */
  async cancel(jobId) {
    const cancelled = this.workerPool.cancel(jobId);
    if (cancelled) {
      try {
        await this.mongoLogger.logCancel(jobId);
      } catch (err) {
        console.error(`[Executor] Failed to log cancel:`, err.message);
      }
    }
    return cancelled;
  }

  /**
   * Get job details
   */
  async getJob(jobId) {
    return this.mongoLogger.getJob(jobId);
  }

  /**
   * List jobs
   */
  async listJobs(filters, options) {
    return this.mongoLogger.listJobs(filters, options);
  }

  /**
   * Get executor status
   */
  async getStatus() {
    const poolStatus = this.workerPool.getStatus();
    return {
      ...poolStatus,
      queue: config.queue.enabled,
      api: config.api.enabled,
    };
  }

  /**
   * Get statistics
   */
  async getStats(source) {
    return this.mongoLogger.getStats(source);
  }

  /**
   * Set max concurrency
   */
  setMaxConcurrency(max) {
    this.workerPool.setMaxConcurrency(max);
  }

  /**
   * Update status in Redis
   */
  async _updateStatus() {
    if (this.streamConsumer) {
      const status = this.workerPool.getStatus();
      await this.streamConsumer.updateStatus(status);
    }
  }

  /**
   * Graceful shutdown
   */
  async shutdown() {
    console.log('\n  Shutting down...');

    if (this.httpServer) {
      await new Promise((r) => this.httpServer.close(r));
    }

    if (this.streamConsumer) {
      await this.streamConsumer.stop();
    }

    await this.workerPool.shutdown();
    await this.mongoLogger.close();

    console.log('  Bye!');
  }
}

// Main
const executor = new Executor();

process.on('SIGTERM', async () => {
  await executor.shutdown();
  process.exit(0);
});

process.on('SIGINT', async () => {
  await executor.shutdown();
  process.exit(0);
});

executor.start().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});

// Export for internal use
export { Executor, executor };
