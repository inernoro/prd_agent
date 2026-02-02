import { createWriteStream, mkdirSync, existsSync, readdirSync, statSync, unlinkSync, rmdirSync } from 'fs';
import { dirname, join } from 'path';
import { config } from '../config.js';

/**
 * File Logger - writes execution logs to files
 */
export class FileLogger {
  constructor(options = {}) {
    this.baseDir = options.baseDir || config.logs.dir;
    this.retentionDays = options.retentionDays || config.logs.retentionDays;
  }

  /**
   * Get log file path for a job
   * @param {string} jobId - Job ID
   * @param {Date} date - Date for organizing logs
   * @returns {string} File path
   */
  getFilePath(jobId, date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');

    return join(this.baseDir, String(year), month, day, `${jobId}.log`);
  }

  /**
   * Create a log writer for a job
   * @param {string} jobId - Job ID
   * @returns {Object} Writer object with write() and close() methods
   */
  createWriter(jobId) {
    const filePath = this.getFilePath(jobId);
    const dir = dirname(filePath);

    // Ensure directory exists
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const stream = createWriteStream(filePath, { flags: 'a' });

    return {
      filePath,
      write(entry) {
        // Write as JSONL
        stream.write(JSON.stringify(entry) + '\n');
      },
      close() {
        return new Promise((resolve) => stream.end(resolve));
      },
    };
  }

  /**
   * Write all logs for a job at once
   * @param {string} jobId - Job ID
   * @param {Array} logs - Log entries
   * @returns {string} File path
   */
  async writeLogs(jobId, logs) {
    const writer = this.createWriter(jobId);

    for (const entry of logs) {
      writer.write(entry);
    }

    await writer.close();
    return writer.filePath;
  }

  /**
   * Clean up old logs
   * @returns {Object} Cleanup stats
   */
  async cleanup() {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - this.retentionDays);

    let deletedFiles = 0;
    let deletedDirs = 0;

    const cleanDir = (dir, depth = 0) => {
      if (!existsSync(dir)) return;

      const entries = readdirSync(dir);

      for (const entry of entries) {
        const fullPath = join(dir, entry);
        const stat = statSync(fullPath);

        if (stat.isDirectory()) {
          cleanDir(fullPath, depth + 1);

          // Remove empty directories
          if (readdirSync(fullPath).length === 0) {
            rmdirSync(fullPath);
            deletedDirs++;
          }
        } else if (stat.isFile() && stat.mtime < cutoffDate) {
          unlinkSync(fullPath);
          deletedFiles++;
        }
      }
    };

    cleanDir(this.baseDir);

    return { deletedFiles, deletedDirs };
  }
}

export default FileLogger;
