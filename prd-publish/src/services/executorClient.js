/**
 * Executor Client - communicates with prd-executor service
 * Can work via HTTP API or Redis Stream
 */
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config.js';

// Mode: 'http' | 'redis' | 'local'
const EXECUTOR_MODE = process.env.EXECUTOR_MODE || 'local';
const EXECUTOR_URL = process.env.EXECUTOR_URL || 'http://localhost:3940';

// Redis client (lazy init)
let redisClient = null;

/**
 * Get Redis client
 */
async function getRedis() {
  if (!redisClient) {
    const Redis = (await import('ioredis')).default;
    redisClient = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
  }
  return redisClient;
}

/**
 * Submit job via HTTP API
 */
async function submitViaHttp(job, options = {}) {
  const endpoint = options.async ? '/jobs/async' : '/jobs';
  const response = await fetch(`${EXECUTOR_URL}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(job),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  return response.json();
}

/**
 * Submit job via Redis Stream
 */
async function submitViaRedis(job, options = {}) {
  const redis = await getRedis();
  const streamKey = process.env.EXECUTOR_STREAM || 'prd-executor:jobs';
  const priority = options.priority || 'normal';

  // Add to stream
  await redis.xadd(
    streamKey,
    '*',
    'job', JSON.stringify(job),
    'priority', priority
  );

  // For async mode, just return the job ID
  if (options.async) {
    return { jobId: job.jobId, status: 'queued' };
  }

  // For sync mode, wait for result
  const resultKey = `prd-executor:result:${job.jobId}`;
  const timeout = job.timeout || 300000;
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    const result = await redis.get(resultKey);
    if (result) {
      await redis.del(resultKey);
      return JSON.parse(result);
    }
    await new Promise(r => setTimeout(r, 500));
  }

  throw new Error('Job execution timeout');
}

/**
 * Submit a deployment job to executor
 * @param {object} options - Job options
 * @param {string} options.command - Command to execute
 * @param {string[]} [options.args] - Command arguments
 * @param {string} [options.workDir] - Working directory
 * @param {object} [options.env] - Environment variables
 * @param {number} [options.timeout] - Timeout in ms
 * @param {string} [options.callbackUrl] - Callback URL for results
 * @param {object} [options.metadata] - Additional metadata
 * @returns {Promise<object>} Job result or job info
 */
export async function submitJob(options) {
  const job = {
    jobId: uuidv4(),
    command: options.command,
    args: options.args || [],
    workDir: options.workDir || process.cwd(),
    env: options.env || {},
    timeout: options.timeout || config.exec.timeout,
    callbackUrl: options.callbackUrl,
    metadata: {
      source: 'prd-publish',
      ...options.metadata,
    },
    createdAt: new Date().toISOString(),
  };

  switch (EXECUTOR_MODE) {
    case 'http':
      return submitViaHttp(job, { async: options.async });

    case 'redis':
      return submitViaRedis(job, { async: options.async, priority: options.priority });

    case 'local':
    default:
      // Local mode - execute directly (for backwards compatibility)
      return null;
  }
}

/**
 * Submit a deploy script job
 * @param {object} options - Deploy options
 * @param {string} options.scriptPath - Path to deploy script
 * @param {string} options.commitHash - Commit hash
 * @param {string} options.shortHash - Short hash
 * @param {string} options.branch - Branch name
 * @param {object} options.project - Project config
 * @param {string} options.operator - Operator name
 * @param {string} [options.callbackUrl] - Callback URL
 * @returns {Promise<object>} Job result
 */
export async function submitDeployJob(options) {
  const { scriptPath, commitHash, shortHash, branch, project, operator, callbackUrl } = options;

  return submitJob({
    command: scriptPath,
    args: [commitHash, shortHash, branch, project.id],
    workDir: project.repoPath,
    env: {
      COMMIT_HASH: commitHash,
      SHORT_HASH: shortHash,
      BRANCH: branch,
      PROJECT_ID: project.id,
      PROJECT_NAME: project.name,
      REPO_PATH: project.repoPath,
    },
    timeout: config.exec.timeout,
    callbackUrl,
    async: true,
    metadata: {
      type: 'deploy',
      projectId: project.id,
      projectName: project.name,
      commitHash,
      shortHash,
      operator,
    },
  });
}

/**
 * Cancel a job
 * @param {string} jobId - Job ID
 * @returns {Promise<boolean>}
 */
export async function cancelJob(jobId) {
  if (EXECUTOR_MODE === 'http') {
    const response = await fetch(`${EXECUTOR_URL}/jobs/${jobId}`, {
      method: 'DELETE',
    });
    return response.ok;
  }

  if (EXECUTOR_MODE === 'redis') {
    const redis = await getRedis();
    await redis.publish('prd-executor:cancel', jobId);
    return true;
  }

  return false;
}

/**
 * Get job status
 * @param {string} jobId - Job ID
 * @returns {Promise<object|null>}
 */
export async function getJobStatus(jobId) {
  if (EXECUTOR_MODE === 'http') {
    const response = await fetch(`${EXECUTOR_URL}/jobs/${jobId}`);
    if (!response.ok) return null;
    return response.json();
  }

  if (EXECUTOR_MODE === 'redis') {
    const redis = await getRedis();
    const result = await redis.get(`prd-executor:result:${jobId}`);
    if (result) return JSON.parse(result);

    // Check if job is still pending
    const pending = await redis.get(`prd-executor:pending:${jobId}`);
    if (pending) return JSON.parse(pending);

    return null;
  }

  return null;
}

/**
 * Get executor status
 * @returns {Promise<object>}
 */
export async function getExecutorStatus() {
  if (EXECUTOR_MODE === 'http') {
    const response = await fetch(`${EXECUTOR_URL}/status`);
    if (!response.ok) throw new Error('Executor unavailable');
    return response.json();
  }

  if (EXECUTOR_MODE === 'redis') {
    const redis = await getRedis();
    const status = await redis.get('prd-executor:status');
    return status ? JSON.parse(status) : { available: false };
  }

  return { mode: 'local', available: true };
}

/**
 * Check if executor mode is enabled
 * @returns {boolean}
 */
export function isExecutorEnabled() {
  return EXECUTOR_MODE !== 'local';
}

/**
 * Get current executor mode
 * @returns {string}
 */
export function getExecutorMode() {
  return EXECUTOR_MODE;
}

/**
 * Close connections
 */
export async function close() {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
  }
}
