import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config.js';

/**
 * HTTP API Receiver - accepts jobs via HTTP
 */
export function createHttpApi(executor) {
  const app = express();

  app.use(express.json());

  /**
   * POST /jobs - Submit a new job
   */
  app.post('/jobs', async (req, res) => {
    try {
      const job = {
        jobId: req.body.jobId || uuidv4(),
        source: req.body.source || 'api',
        command: req.body.command,
        args: req.body.args || [],
        env: req.body.env || {},
        workDir: req.body.workDir,
        timeout: req.body.timeout || config.execution.defaultTimeout,
        callback: req.body.callback,
        metadata: req.body.metadata || {},
        createdAt: new Date().toISOString(),
      };

      if (!job.command) {
        return res.status(400).json({
          success: false,
          error: 'command is required',
        });
      }

      // Submit to executor
      const result = await executor.submit(job);

      res.json({
        success: true,
        jobId: job.jobId,
        result,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  });

  /**
   * POST /jobs/async - Submit a job without waiting for result
   */
  app.post('/jobs/async', async (req, res) => {
    try {
      const job = {
        jobId: req.body.jobId || uuidv4(),
        source: req.body.source || 'api',
        command: req.body.command,
        args: req.body.args || [],
        env: req.body.env || {},
        workDir: req.body.workDir,
        timeout: req.body.timeout || config.execution.defaultTimeout,
        callback: req.body.callback,
        metadata: req.body.metadata || {},
        createdAt: new Date().toISOString(),
      };

      if (!job.command) {
        return res.status(400).json({
          success: false,
          error: 'command is required',
        });
      }

      // Submit without waiting
      executor.submit(job).catch((err) => {
        console.error(`[HttpApi] Async job ${job.jobId} failed:`, err.message);
      });

      res.json({
        success: true,
        jobId: job.jobId,
        message: 'Job submitted',
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  });

  /**
   * DELETE /jobs/:jobId - Cancel a job
   */
  app.delete('/jobs/:jobId', async (req, res) => {
    try {
      const { jobId } = req.params;
      const cancelled = await executor.cancel(jobId);

      res.json({
        success: cancelled,
        message: cancelled ? 'Job cancelled' : 'Job not found or already completed',
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  });

  /**
   * GET /jobs/:jobId - Get job details
   */
  app.get('/jobs/:jobId', async (req, res) => {
    try {
      const { jobId } = req.params;
      const job = await executor.getJob(jobId);

      if (!job) {
        return res.status(404).json({
          success: false,
          error: 'Job not found',
        });
      }

      res.json({
        success: true,
        data: job,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  });

  /**
   * GET /jobs - List jobs
   */
  app.get('/jobs', async (req, res) => {
    try {
      const { source, status, since, limit, offset } = req.query;
      const jobs = await executor.listJobs(
        { source, status, since },
        {
          limit: parseInt(limit || '50', 10),
          offset: parseInt(offset || '0', 10),
        }
      );

      res.json({
        success: true,
        data: jobs,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  });

  /**
   * GET /status - Get executor status
   */
  app.get('/status', async (req, res) => {
    try {
      const status = await executor.getStatus();
      res.json({
        success: true,
        data: status,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  });

  /**
   * PUT /config/concurrency - Update max concurrency
   */
  app.put('/config/concurrency', async (req, res) => {
    try {
      const { max } = req.body;
      if (!max || max < 1 || max > 100) {
        return res.status(400).json({
          success: false,
          error: 'max must be between 1 and 100',
        });
      }

      executor.setMaxConcurrency(max);

      res.json({
        success: true,
        maxConcurrency: max,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  });

  /**
   * GET /stats - Get statistics
   */
  app.get('/stats', async (req, res) => {
    try {
      const { source } = req.query;
      const stats = await executor.getStats(source);

      res.json({
        success: true,
        data: stats,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  });

  /**
   * GET /health - Health check
   */
  app.get('/health', (req, res) => {
    res.json({
      success: true,
      status: 'healthy',
      timestamp: new Date().toISOString(),
    });
  });

  return app;
}

export default createHttpApi;
