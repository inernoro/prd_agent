import { MongoClient } from 'mongodb';
import { config } from '../config.js';

/**
 * MongoDB Logger - stores job records for auditing
 */
export class MongoLogger {
  constructor(options = {}) {
    this.uri = options.uri || config.mongodb.uri;
    this.collectionName = options.collection || config.mongodb.collection;
    this.client = null;
    this.db = null;
    this.collection = null;
  }

  /**
   * Connect to MongoDB
   */
  async connect() {
    this.client = new MongoClient(this.uri);
    await this.client.connect();

    const dbName = this.uri.split('/').pop().split('?')[0];
    this.db = this.client.db(dbName);
    this.collection = this.db.collection(this.collectionName);

    // Create indexes
    await this.collection.createIndex({ jobId: 1 }, { unique: true });
    await this.collection.createIndex({ source: 1, createdAt: -1 });
    await this.collection.createIndex({ status: 1 });
    await this.collection.createIndex({ createdAt: -1 });

    console.log(`[MongoLogger] Connected to ${dbName}/${this.collectionName}`);
  }

  /**
   * Log job start
   * @param {Object} job - Job object
   */
  async logStart(job) {
    const doc = {
      jobId: job.jobId,
      source: job.source || 'unknown',

      command: job.command,
      args: job.args || [],
      workDir: job.workDir,
      timeout: job.timeout,

      status: 'running',
      exitCode: null,
      duration: null,

      createdAt: job.createdAt ? new Date(job.createdAt) : new Date(),
      startedAt: new Date(),
      completedAt: null,

      callbackUrl: job.callback?.url,
      callbackStatus: null,
      callbackError: null,

      metadata: job.metadata || {},

      logsFile: null,
      logsSize: null,
    };

    await this.collection.insertOne(doc);
  }

  /**
   * Log job completion
   * @param {string} jobId - Job ID
   * @param {Object} result - Execution result
   * @param {Object} callbackResult - Callback result
   * @param {string} logsFile - Path to logs file
   */
  async logComplete(jobId, result, callbackResult, logsFile) {
    const update = {
      status: result.success ? 'completed' : result.killed ? 'timeout' : 'failed',
      exitCode: result.exitCode,
      duration: result.duration,
      completedAt: new Date(),

      callbackStatus: callbackResult?.success
        ? 'success'
        : callbackResult?.stored
          ? 'stored'
          : callbackResult?.skipped
            ? 'skipped'
            : 'failed',
      callbackError: callbackResult?.error,

      logsFile,
    };

    await this.collection.updateOne({ jobId }, { $set: update });
  }

  /**
   * Log job cancellation
   * @param {string} jobId - Job ID
   */
  async logCancel(jobId) {
    await this.collection.updateOne(
      { jobId },
      {
        $set: {
          status: 'cancelled',
          completedAt: new Date(),
        },
      }
    );
  }

  /**
   * Get job by ID
   * @param {string} jobId - Job ID
   * @returns {Object|null} Job document
   */
  async getJob(jobId) {
    return this.collection.findOne({ jobId });
  }

  /**
   * List jobs with filters
   * @param {Object} filters - Query filters
   * @param {Object} options - Query options
   * @returns {Array} Jobs
   */
  async listJobs(filters = {}, options = {}) {
    const { limit = 50, offset = 0, sort = { createdAt: -1 } } = options;

    const query = {};

    if (filters.source) query.source = filters.source;
    if (filters.status) query.status = filters.status;
    if (filters.since) query.createdAt = { $gte: new Date(filters.since) };

    return this.collection.find(query).sort(sort).skip(offset).limit(limit).toArray();
  }

  /**
   * Get statistics
   * @param {string} source - Optional source filter
   * @returns {Object} Stats
   */
  async getStats(source) {
    const match = source ? { source } : {};

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [total, todayStats] = await Promise.all([
      this.collection.countDocuments(match),
      this.collection
        .aggregate([
          { $match: { ...match, createdAt: { $gte: today } } },
          {
            $group: {
              _id: '$status',
              count: { $sum: 1 },
            },
          },
        ])
        .toArray(),
    ]);

    const stats = {
      total,
      today: {
        completed: 0,
        failed: 0,
        running: 0,
        cancelled: 0,
      },
    };

    for (const item of todayStats) {
      if (item._id in stats.today) {
        stats.today[item._id] = item.count;
      }
    }

    return stats;
  }

  /**
   * Close connection
   */
  async close() {
    if (this.client) {
      await this.client.close();
    }
  }
}

export default MongoLogger;
