import { config } from '../config.js';

/**
 * Callback Handler - sends results back to callers
 */
export class CallbackHandler {
  constructor(options = {}) {
    this.timeout = options.timeout || config.callback.timeout;
    this.retries = options.retries || config.callback.retries;
    this.streamConsumer = options.streamConsumer; // For storing failed results
  }

  /**
   * Send callback to URL
   * @param {string} url - Callback URL
   * @param {Object} data - Data to send
   * @param {Object} headers - Optional headers
   * @returns {Promise<{ success: boolean, error?: string }>}
   */
  async send(url, data, headers = {}) {
    let lastError = null;

    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeout);

        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...headers,
          },
          body: JSON.stringify(data),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (response.ok) {
          return { success: true };
        }

        lastError = `HTTP ${response.status}: ${response.statusText}`;
      } catch (err) {
        lastError = err.message;
      }

      // Wait before retry (exponential backoff)
      if (attempt < this.retries) {
        await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 1000));
      }
    }

    return { success: false, error: lastError };
  }

  /**
   * Handle job start callback
   * @param {Object} job - Job object
   */
  async onStart(job) {
    if (!job.callback?.url || job.callback?.onStart === false) {
      return;
    }

    const data = {
      type: 'start',
      jobId: job.jobId,
      startedAt: new Date().toISOString(),
      metadata: job.metadata,
    };

    await this.send(job.callback.url, data, job.callback.headers);
  }

  /**
   * Handle job output callback (streaming)
   * @param {Object} job - Job object
   * @param {Object} output - Output entry
   */
  async onOutput(job, output) {
    if (!job.callback?.url || !job.callback?.onOutput) {
      return;
    }

    const data = {
      type: 'output',
      jobId: job.jobId,
      stream: output.stream,
      text: output.text,
      timestamp: output.ts,
    };

    // Don't retry for output (too much volume)
    await this.send(job.callback.url, data, job.callback.headers);
  }

  /**
   * Handle job complete callback
   * @param {Object} job - Job object
   * @param {Object} result - Execution result
   * @param {string} logsFile - Path to logs file
   */
  async onComplete(job, result, logsFile) {
    const data = {
      type: 'complete',
      jobId: job.jobId,
      success: result.success,
      exitCode: result.exitCode,
      duration: result.duration,
      startedAt: job._startedAt,
      completedAt: new Date().toISOString(),
      logsFile,
      logsPreview: result.logs.slice(-20), // Last 20 lines
      metadata: job.metadata,
      error: result.error,
    };

    // If no callback URL, store result
    if (!job.callback?.url) {
      if (this.streamConsumer && job.source) {
        await this.streamConsumer.storeResult(data, job.source);
      }
      return { success: true, stored: true };
    }

    if (job.callback?.onComplete === false) {
      return { success: true, skipped: true };
    }

    const callbackResult = await this.send(job.callback.url, data, job.callback.headers);

    // If callback failed, store result for later retrieval
    if (!callbackResult.success && this.streamConsumer && job.source) {
      await this.streamConsumer.storeResult(data, job.source);
      return { success: false, error: callbackResult.error, stored: true };
    }

    return callbackResult;
  }
}

export default CallbackHandler;
