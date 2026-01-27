import { Router } from 'express';
import * as deployService from '../services/deployService.js';
import * as historyService from '../services/historyService.js';
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
 * POST /api/deploy
 * Start deployment to specific commit
 */
router.post('/', async (req, res) => {
  const { commitHash, projectId } = req.body;

  if (!commitHash) {
    return res.status(400).json({
      success: false,
      error: 'commitHash 不能为空',
    });
  }

  // Validate commit hash format
  if (!/^[a-f0-9]+$/i.test(commitHash)) {
    return res.status(400).json({
      success: false,
      error: '无效的 commit hash 格式',
    });
  }

  // Check if already deploying
  if (deployService.isDeploying()) {
    return res.status(409).json({
      success: false,
      error: '另一个部署正在进行中',
      currentDeploy: deployService.getCurrentDeploy(),
    });
  }

  try {
    const project = await getProjectConfig(projectId);

    const result = await deployService.deploy({
      commitHash,
      operator: req.user.username,
      project,
    });

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
 * GET /api/deploy/stream
 * SSE stream for deployment logs
 */
router.get('/stream', (req, res) => {
  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  // Send initial status
  const currentDeploy = deployService.getCurrentDeploy();
  if (currentDeploy) {
    res.write(`data: ${JSON.stringify({ type: 'status', data: currentDeploy })}\n\n`);
  }

  // Listen for events
  const onOutput = (data) => {
    res.write(`data: ${JSON.stringify({ type: 'output', data })}\n\n`);
  };

  const onStatus = (status, data) => {
    res.write(`data: ${JSON.stringify({ type: 'status', status, data })}\n\n`);
  };

  const onComplete = (data) => {
    res.write(`data: ${JSON.stringify({ type: 'complete', data })}\n\n`);
  };

  const onError = (error) => {
    res.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`);
  };

  deployService.deployEvents.on('output', onOutput);
  deployService.deployEvents.on('start', onStatus);
  deployService.deployEvents.on('retry', onStatus);
  deployService.deployEvents.on('complete', onComplete);
  deployService.deployEvents.on('error', onError);

  // Heartbeat
  const heartbeat = setInterval(() => {
    res.write(`data: ${JSON.stringify({ type: 'heartbeat' })}\n\n`);
  }, 30000);

  // Cleanup on close
  req.on('close', () => {
    clearInterval(heartbeat);
    deployService.deployEvents.off('output', onOutput);
    deployService.deployEvents.off('start', onStatus);
    deployService.deployEvents.off('retry', onStatus);
    deployService.deployEvents.off('complete', onComplete);
    deployService.deployEvents.off('error', onError);
  });
});

/**
 * POST /api/deploy/cancel
 * Cancel current deployment
 */
router.post('/cancel', (req, res) => {
  if (!deployService.isDeploying()) {
    return res.status(400).json({
      success: false,
      error: '当前没有正在进行的部署',
    });
  }

  const cancelled = deployService.cancelDeploy();

  res.json({
    success: cancelled,
    message: cancelled ? '已发送取消信号' : '取消失败',
  });
});

/**
 * POST /api/deploy/retry
 * Retry last failed deployment
 */
router.post('/retry', async (req, res) => {
  try {
    const { projectId } = req.body;
    const project = await getProjectConfig(projectId);

    const lastDeploy = await historyService.getLastDeploy(projectId);

    if (!lastDeploy) {
      return res.status(404).json({
        success: false,
        error: '没有可重试的部署记录',
      });
    }

    if (lastDeploy.status === 'success') {
      return res.status(400).json({
        success: false,
        error: '上次部署已成功，无需重试',
      });
    }

    const result = await deployService.deploy({
      commitHash: lastDeploy.commitHash,
      operator: req.user.username,
      project,
    });

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
 * GET /api/deploy/current
 * Get current deployment status
 */
router.get('/current', (req, res) => {
  const currentDeploy = deployService.getCurrentDeploy();
  const isDeploying = deployService.isDeploying();

  res.json({
    success: true,
    isDeploying,
    data: currentDeploy,
  });
});

export default router;
