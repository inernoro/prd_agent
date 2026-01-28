import { Router } from 'express';
import * as gitService from '../services/gitService.js';
import { getProject } from '../services/projectService.js';
import { authMiddleware } from '../middleware/authMiddleware.js';

const router = Router();

// All routes require authentication
router.use(authMiddleware);

/**
 * Get project config from query param or use default
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
 * GET /api/commits
 * Get list of commits
 */
router.get('/commits', async (req, res) => {
  try {
    const { limit = 50, offset = 0, branch, search, projectId } = req.query;
    const project = await getProjectConfig(projectId);

    const commits = await gitService.getCommits({
      limit: parseInt(limit, 10),
      offset: parseInt(offset, 10),
      branch: branch || project.branch,
      search,
      repoPath: project.repoPath,
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
    const { projectId } = req.query;
    const project = await getProjectConfig(projectId);

    const tags = await gitService.getTags(project.repoPath);

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
    const { projectId } = req.query;
    const project = await getProjectConfig(projectId);

    const [repoStatus, remoteUrl] = await Promise.all([
      gitService.getRepoStatus(project.repoPath),
      gitService.getRemoteUrl(project.repoPath).catch(() => null),
    ]);

    res.json({
      success: true,
      data: {
        ...repoStatus,
        remoteUrl,
        project: {
          id: project.id,
          name: project.name,
          repoPath: project.repoPath,
        },
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
 * GET /api/commit/:hash
 * Get specific commit info
 */
router.get('/commit/:hash', async (req, res) => {
  try {
    const { hash } = req.params;
    const { projectId } = req.query;
    const project = await getProjectConfig(projectId);

    const commit = await gitService.getCommitInfo(hash, project.repoPath);

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

/**
 * POST /api/fetch
 * Fetch latest from remote
 */
router.post('/fetch', async (req, res) => {
  try {
    const { projectId } = req.body;
    const project = await getProjectConfig(projectId);

    await gitService.fetchRemote(project.repoPath);

    res.json({
      success: true,
      message: 'Fetch completed',
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

export default router;
