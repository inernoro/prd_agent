import Redis from 'ioredis';
import { config } from '../config.js';

/**
 * Redis Stream Consumer - consumes jobs from Redis Streams
 */
export class StreamConsumer {
  constructor(options = {}) {
    this.redis = new Redis(config.redis.url);
    this.prefix = config.redis.prefix;
    this.priorities = options.priorities || config.queue.priorities;
    this.blockTimeout = options.blockTimeout || config.queue.blockTimeout;
    this.running = false;
    this.onJob = null;
  }

  /**
   * Get stream key for priority
   */
  _getStreamKey(priority) {
    return `${this.prefix}:jobs:${priority}`;
  }

  /**
   * Get result stream key for source
   */
  _getResultKey(source) {
    return `${this.prefix}:results:${source}`;
  }

  /**
   * Start consuming jobs
   * @param {Function} handler - Job handler function
   */
  async start(handler) {
    this.onJob = handler;
    this.running = true;

    console.log(`[StreamConsumer] Starting, priorities: ${this.priorities.join(', ')}`);

    // Ensure streams exist
    for (const priority of this.priorities) {
      const key = this._getStreamKey(priority);
      try {
        await this.redis.xgroup('CREATE', key, 'executor', '0', 'MKSTREAM');
      } catch (err) {
        if (!err.message.includes('BUSYGROUP')) {
          console.error(`[StreamConsumer] Failed to create group for ${key}:`, err.message);
        }
      }
    }

    // Start consuming
    this._consumeLoop();
  }

  /**
   * Main consume loop
   */
  async _consumeLoop() {
    const consumerId = `consumer-${process.pid}`;

    while (this.running) {
      try {
        // Build XREADGROUP args for all priorities
        const streams = this.priorities.map((p) => this._getStreamKey(p));
        const ids = this.priorities.map(() => '>');

        const results = await this.redis.xreadgroup(
          'GROUP',
          'executor',
          consumerId,
          'COUNT',
          1,
          'BLOCK',
          this.blockTimeout,
          'STREAMS',
          ...streams,
          ...ids
        );

        if (results) {
          for (const [stream, messages] of results) {
            for (const [messageId, fields] of messages) {
              const job = this._parseJob(fields);
              job._messageId = messageId;
              job._stream = stream;

              try {
                await this.onJob(job);
                // Acknowledge message
                await this.redis.xack(stream, 'executor', messageId);
              } catch (err) {
                console.error(`[StreamConsumer] Job handler error:`, err.message);
                // Don't ack - will be redelivered
              }
            }
          }
        }
      } catch (err) {
        if (this.running) {
          console.error(`[StreamConsumer] Consume error:`, err.message);
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    }
  }

  /**
   * Parse job from Redis fields
   */
  _parseJob(fields) {
    const job = {};
    for (let i = 0; i < fields.length; i += 2) {
      const key = fields[i];
      let value = fields[i + 1];

      // Try to parse JSON values
      if (key === 'args' || key === 'env' || key === 'callback' || key === 'metadata') {
        try {
          value = JSON.parse(value);
        } catch {
          // Keep as string
        }
      } else if (key === 'timeout') {
        value = parseInt(value, 10);
      }

      job[key] = value;
    }
    return job;
  }

  /**
   * Add a job to the queue
   * @param {Object} job - Job to add
   * @param {string} priority - Priority level
   * @returns {string} Message ID
   */
  async addJob(job, priority = 'normal') {
    const key = this._getStreamKey(priority);

    const fields = [];
    for (const [k, v] of Object.entries(job)) {
      fields.push(k);
      fields.push(typeof v === 'object' ? JSON.stringify(v) : String(v));
    }

    return this.redis.xadd(key, '*', ...fields);
  }

  /**
   * Store result for failed callback (let caller fetch)
   * @param {Object} result - Execution result
   * @param {string} source - Source identifier
   */
  async storeResult(result, source) {
    const key = this._getResultKey(source);

    const fields = [];
    for (const [k, v] of Object.entries(result)) {
      fields.push(k);
      fields.push(typeof v === 'object' ? JSON.stringify(v) : String(v));
    }

    // Add with max length to prevent unbounded growth
    await this.redis.xadd(key, 'MAXLEN', '~', 1000, '*', ...fields);
  }

  /**
   * Update executor status in Redis
   * @param {Object} status - Status object
   */
  async updateStatus(status) {
    const key = `${this.prefix}:status`;
    await this.redis.hmset(key, {
      running: status.running,
      maxConcurrency: status.maxConcurrency,
      pending: status.pending,
      updatedAt: new Date().toISOString(),
    });
  }

  /**
   * Stop consuming
   */
  async stop() {
    this.running = false;
    await this.redis.quit();
  }
}

export default StreamConsumer;
