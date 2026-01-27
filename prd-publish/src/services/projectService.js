import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { config } from '../config.js';

const PROJECTS_FILE = join(config.paths.dataDir, 'projects.json');

/**
 * Default project structure
 */
const DEFAULT_PROJECT = {
  id: '',
  name: '',
  repoPath: '',
  script: '',
  branch: 'main',
  enabled: true,
  createdAt: '',
  updatedAt: '',
};

/**
 * Initialize projects file with default project from env
 */
async function initProjectsFile() {
  const dir = dirname(PROJECTS_FILE);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }

  // Create default project from environment variables
  const defaultProject = {
    ...DEFAULT_PROJECT,
    id: 'default',
    name: 'Default Project',
    repoPath: config.git.repoPath,
    script: config.exec.script,
    branch: config.git.branch,
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const data = {
    projects: [defaultProject],
  };

  await writeFile(PROJECTS_FILE, JSON.stringify(data, null, 2), 'utf-8');
  return data;
}

/**
 * Load all projects
 * @returns {Promise<object>} Projects data
 */
export async function loadProjects() {
  try {
    if (!existsSync(PROJECTS_FILE)) {
      return await initProjectsFile();
    }
    const content = await readFile(PROJECTS_FILE, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    console.error('Failed to load projects:', error);
    return await initProjectsFile();
  }
}

/**
 * Save projects to file
 * @param {object} data - Projects data
 */
async function saveProjects(data) {
  const dir = dirname(PROJECTS_FILE);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  await writeFile(PROJECTS_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * Get all projects
 * @param {object} [options] - Options
 * @param {boolean} [options.enabledOnly=false] - Only return enabled projects
 * @returns {Promise<Array>} List of projects
 */
export async function getProjects(options = {}) {
  const { enabledOnly = false } = options;
  const data = await loadProjects();
  let projects = data.projects || [];

  if (enabledOnly) {
    projects = projects.filter(p => p.enabled);
  }

  return projects;
}

/**
 * Get a project by ID
 * @param {string} id - Project ID
 * @returns {Promise<object|null>} Project or null
 */
export async function getProject(id) {
  const projects = await getProjects();
  return projects.find(p => p.id === id) || null;
}

/**
 * Create a new project
 * @param {object} projectData - Project data
 * @returns {Promise<object>} Created project
 */
export async function createProject(projectData) {
  const data = await loadProjects();

  // Validate required fields
  if (!projectData.id || !projectData.name || !projectData.repoPath || !projectData.script) {
    throw new Error('Missing required fields: id, name, repoPath, script');
  }

  // Check for duplicate ID
  if (data.projects.some(p => p.id === projectData.id)) {
    throw new Error(`Project with ID "${projectData.id}" already exists`);
  }

  // Validate ID format (alphanumeric, dash, underscore)
  if (!/^[a-zA-Z0-9_-]+$/.test(projectData.id)) {
    throw new Error('Project ID can only contain letters, numbers, dashes, and underscores');
  }

  const project = {
    ...DEFAULT_PROJECT,
    ...projectData,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  data.projects.push(project);
  await saveProjects(data);

  return project;
}

/**
 * Update a project
 * @param {string} id - Project ID
 * @param {object} updates - Fields to update
 * @returns {Promise<object>} Updated project
 */
export async function updateProject(id, updates) {
  const data = await loadProjects();
  const index = data.projects.findIndex(p => p.id === id);

  if (index === -1) {
    throw new Error(`Project "${id}" not found`);
  }

  // Don't allow changing ID
  delete updates.id;
  delete updates.createdAt;

  data.projects[index] = {
    ...data.projects[index],
    ...updates,
    updatedAt: new Date().toISOString(),
  };

  await saveProjects(data);
  return data.projects[index];
}

/**
 * Delete a project
 * @param {string} id - Project ID
 * @returns {Promise<boolean>} Success
 */
export async function deleteProject(id) {
  const data = await loadProjects();
  const index = data.projects.findIndex(p => p.id === id);

  if (index === -1) {
    throw new Error(`Project "${id}" not found`);
  }

  // Don't allow deleting last project
  if (data.projects.length === 1) {
    throw new Error('Cannot delete the last project');
  }

  data.projects.splice(index, 1);
  await saveProjects(data);

  return true;
}

/**
 * Validate project configuration
 * @param {object} project - Project to validate
 * @returns {Promise<object>} Validation result
 */
export async function validateProject(project) {
  const errors = [];

  // Check repo path exists
  if (!existsSync(project.repoPath)) {
    errors.push(`Repository path does not exist: ${project.repoPath}`);
  }

  // Check if it's a git repo
  if (!existsSync(join(project.repoPath, '.git'))) {
    errors.push(`Not a git repository: ${project.repoPath}`);
  }

  // Check script exists
  if (!existsSync(project.script)) {
    // Try relative to prd-publish directory
    const absoluteScript = join(config.paths.baseDir, project.script);
    if (!existsSync(absoluteScript)) {
      errors.push(`Script not found: ${project.script}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Get available scripts from scripts/ directory
 * @returns {Promise<Array>} List of script files
 */
export async function getAvailableScripts() {
  const scriptsDir = join(config.paths.baseDir, 'scripts');

  try {
    const { readdir } = await import('fs/promises');
    const files = await readdir(scriptsDir);
    return files
      .filter(f => f.endsWith('.sh') && !f.startsWith('_'))
      .map(f => ({
        name: f,
        path: `./scripts/${f}`,
      }));
  } catch {
    return [];
  }
}
