import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { config } from '../config.js';

const MAX_RECORDS = 100;

/**
 * Read history from file
 * @returns {Promise<Array>} History records
 */
export async function readHistory() {
  const filePath = config.paths.historyFile;

  if (!existsSync(filePath)) {
    return [];
  }

  try {
    const content = await readFile(filePath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return [];
  }
}

/**
 * Write history to file
 * @param {Array} records - History records
 * @returns {Promise<void>}
 */
export async function writeHistory(records) {
  const filePath = config.paths.historyFile;
  await writeFile(filePath, JSON.stringify(records, null, 2), 'utf-8');
}

/**
 * Add a new record to history
 * @param {object} record - Deploy record
 * @returns {Promise<void>}
 */
export async function addRecord(record) {
  const history = await readHistory();

  // Add new record at the beginning
  history.unshift({
    ...record,
    createdAt: new Date().toISOString(),
  });

  // Keep only MAX_RECORDS
  if (history.length > MAX_RECORDS) {
    history.length = MAX_RECORDS;
  }

  await writeHistory(history);
}

/**
 * Get all history records
 * @param {object} [options] - Options
 * @param {number} [options.limit] - Limit number of records
 * @param {number} [options.offset] - Offset for pagination
 * @param {string} [options.status] - Filter by status
 * @param {string} [options.projectId] - Filter by project ID
 * @returns {Promise<Array>} History records
 */
export async function getHistory(options = {}) {
  const { limit = 20, offset = 0, status, projectId } = options;
  let history = await readHistory();

  // Filter by project
  if (projectId) {
    history = history.filter((r) => r.projectId === projectId);
  }

  // Filter by status
  if (status) {
    history = history.filter((r) => r.status === status);
  }

  // Paginate
  return history.slice(offset, offset + limit);
}

/**
 * Get a specific record by ID
 * @param {string} id - Record ID
 * @returns {Promise<object|null>} Record or null
 */
export async function getRecord(id) {
  const history = await readHistory();
  return history.find((r) => r.id === id) || null;
}

/**
 * Get the last successful deployment
 * @param {string} [projectId] - Project ID to filter by
 * @returns {Promise<object|null>} Last successful record or null
 */
export async function getLastSuccessful(projectId) {
  let history = await readHistory();

  if (projectId) {
    history = history.filter((r) => r.projectId === projectId);
  }

  return history.find((r) => r.status === 'success') || null;
}

/**
 * Get the last deployment (any status)
 * @param {string} [projectId] - Project ID to filter by
 * @returns {Promise<object|null>} Last record or null
 */
export async function getLastDeploy(projectId) {
  let history = await readHistory();

  if (projectId) {
    history = history.filter((r) => r.projectId === projectId);
  }

  return history[0] || null;
}

/**
 * Get deployment statistics
 * @param {string} [projectId] - Project ID to filter by
 * @returns {Promise<object>} Statistics
 */
export async function getStats(projectId) {
  let history = await readHistory();

  if (projectId) {
    history = history.filter((r) => r.projectId === projectId);
  }

  const total = history.length;
  const successful = history.filter((r) => r.status === 'success').length;
  const failed = history.filter((r) => r.status === 'failed').length;
  const cancelled = history.filter((r) => r.status === 'cancelled').length;

  const avgDuration =
    history.length > 0
      ? history.reduce((sum, r) => sum + (r.duration || 0), 0) / history.length
      : 0;

  return {
    total,
    successful,
    failed,
    cancelled,
    successRate: total > 0 ? ((successful / total) * 100).toFixed(1) : '0',
    avgDuration: Math.round(avgDuration),
  };
}

/**
 * Clear all history
 * @param {string} [projectId] - Project ID to clear (if not provided, clears all)
 * @returns {Promise<void>}
 */
export async function clearHistory(projectId) {
  if (!projectId) {
    await writeHistory([]);
    return;
  }

  const history = await readHistory();
  const filtered = history.filter((r) => r.projectId !== projectId);
  await writeHistory(filtered);
}
