import { Router } from 'express';
import { authMiddleware } from '../middleware/authMiddleware.js';
import {
  getProjects,
  getProject,
  createProject,
  updateProject,
  deleteProject,
  validateProject,
  getAvailableScripts,
} from '../services/projectService.js';

const router = Router();

// All routes require authentication
router.use(authMiddleware);

/**
 * GET /api/projects
 * Get all projects
 */
router.get('/projects', async (req, res) => {
  try {
    const { enabledOnly } = req.query;
    const projects = await getProjects({
      enabledOnly: enabledOnly === 'true',
    });

    res.json({
      success: true,
      data: projects,
    });
  } catch (error) {
    console.error('Get projects error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * GET /api/projects/scripts
 * Get available deploy scripts
 */
router.get('/projects/scripts', async (req, res) => {
  try {
    const scripts = await getAvailableScripts();
    res.json({
      success: true,
      data: scripts,
    });
  } catch (error) {
    console.error('Get scripts error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * GET /api/projects/:id
 * Get a specific project
 */
router.get('/projects/:id', async (req, res) => {
  try {
    const project = await getProject(req.params.id);

    if (!project) {
      return res.status(404).json({
        success: false,
        error: 'Project not found',
      });
    }

    res.json({
      success: true,
      data: project,
    });
  } catch (error) {
    console.error('Get project error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * POST /api/projects
 * Create a new project
 */
router.post('/projects', async (req, res) => {
  try {
    const project = await createProject(req.body);

    res.status(201).json({
      success: true,
      data: project,
    });
  } catch (error) {
    console.error('Create project error:', error);
    res.status(400).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * PUT /api/projects/:id
 * Update a project
 */
router.put('/projects/:id', async (req, res) => {
  try {
    const project = await updateProject(req.params.id, req.body);

    res.json({
      success: true,
      data: project,
    });
  } catch (error) {
    console.error('Update project error:', error);
    res.status(400).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * DELETE /api/projects/:id
 * Delete a project
 */
router.delete('/projects/:id', async (req, res) => {
  try {
    await deleteProject(req.params.id);

    res.json({
      success: true,
      message: 'Project deleted',
    });
  } catch (error) {
    console.error('Delete project error:', error);
    res.status(400).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * POST /api/projects/:id/validate
 * Validate a project configuration
 */
router.post('/projects/:id/validate', async (req, res) => {
  try {
    const project = await getProject(req.params.id);

    if (!project) {
      return res.status(404).json({
        success: false,
        error: 'Project not found',
      });
    }

    const result = await validateProject(project);

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    console.error('Validate project error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

export default router;
