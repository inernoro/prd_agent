import { Router } from 'express';
import * as gitService from '../services/gitService.js';
import { authMiddleware } from '../middleware/authMiddleware.js';

const router = Router();

// All routes require authentication
router.use(authMiddleware);

/**
 * GET /api/commits
 * Get list of commits
 */
router.get('/commits', async (req, res) => {
  try {
    const { limit = 50, offset = 0, branch, search } = req.query;

    const commits = await gitService.getCommits({
      limit: parseInt(limit, 10),
      offset: parseInt(offset, 10),
      branch,
      search,
    });

    res.json({
      success: true,
      data: commits,
      pagination: {
        limit: parseInt(limit, 10),
        offset: parseInt(offset, 10),
        hasMore: commits.length === parseInt(limit, 10),
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
 * GET /api/tags
 * Get list of tags
 */
router.get('/tags', async (req, res) => {
  try {
    const tags = await gitService.getTags();

    res.json({
      success: true,
      data: tags,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * GET /api/status
 * Get repository status and current version
 */
router.get('/status', async (req, res) => {
  try {
    const repoStatus = await gitService.getRepoStatus();

    res.json({
      success: true,
      data: repoStatus,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * GET /api/commit/:hash
 * Get specific commit info
 */
router.get('/commit/:hash', async (req, res) => {
  try {
    const { hash } = req.params;
    const commit = await gitService.getCommitInfo(hash);

    if (!commit) {
      return res.status(404).json({
        success: false,
        error: '未找到该 commit',
      });
    }

    res.json({
      success: true,
      data: commit,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

export default router;
