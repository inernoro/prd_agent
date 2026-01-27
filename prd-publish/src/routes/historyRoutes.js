import { Router } from 'express';
import * as historyService from '../services/historyService.js';
import * as deployService from '../services/deployService.js';
import { getProject } from '../services/projectService.js';
import { authMiddleware } from '../middleware/authMiddleware.js';

const router = Router();

// All routes require authentication
router.use(authMiddleware);

/**
 * Get project config from ID or use default
 */
async function getProjectConfig(projectId) {
  if (!projectId || projectId === 'default') {
    const project = await getProject('default');
    return project;
  }
  const project = await getProject(projectId);
  if (!project) {
    throw new Error(`Project "${projectId}" not found`);
  }
  return project;
}

/**
 * GET /api/history
 * Get deployment history
 */
router.get('/', async (req, res) => {
  try {
    const { limit = 20, offset = 0, status, projectId } = req.query;

    const history = await historyService.getHistory({
      limit: parseInt(limit, 10),
      offset: parseInt(offset, 10),
      status,
      projectId,
    });

    const stats = await historyService.getStats(projectId);

    res.json({
      success: true,
      data: history,
      stats,
      pagination: {
        limit: parseInt(limit, 10),
        offset: parseInt(offset, 10),
        hasMore: history.length === parseInt(limit, 10),
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * GET /api/history/:id
 * Get specific history record
 */
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const record = await historyService.getRecord(id);

    if (!record) {
      return res.status(404).json({
        success: false,
        error: '未找到该记录',
      });
    }

    res.json({
      success: true,
      data: record,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * POST /api/history/:id/retry
 * Retry deployment from history
 */
router.post('/:id/retry', async (req, res) => {
  try {
    const { id } = req.params;

    // Get the record first to find the project
    const record = await historyService.getRecord(id);
    if (!record) {
      return res.status(404).json({
        success: false,
        error: '未找到该记录',
      });
    }

    const project = await getProjectConfig(record.projectId);

    const result = await deployService.retryFromHistory(
      id,
      req.user.username,
      project
    );

    res.json({
      success: result.success,
      data: result,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * GET /api/history/last/successful
 * Get last successful deployment
 */
router.get('/last/successful', async (req, res) => {
  try {
    const { projectId } = req.query;
    const record = await historyService.getLastSuccessful(projectId);

    res.json({
      success: true,
      data: record,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

export default router;
