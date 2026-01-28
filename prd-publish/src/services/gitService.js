import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import { config } from '../config.js';

const execAsync = promisify(exec);

/**
 * Execute git command in repo directory
 * @param {string} command - Git command (without 'git' prefix)
 * @param {string} [repoPath] - Repository path (defaults to config)
 * @returns {Promise<string>} Command output
 */
export async function execGit(command, repoPath = config.git.repoPath) {
  // Validate repoPath is a local path, not a URL
  if (repoPath.startsWith('http://') || repoPath.startsWith('https://') || repoPath.startsWith('git@')) {
    throw new Error(`repoPath must be a local file path, not a URL: ${repoPath}`);
  }

  // Check if path exists
  if (!existsSync(repoPath)) {
    throw new Error(`Repository path does not exist: ${repoPath}`);
  }

  try {
    const { stdout } = await execAsync(`git ${command}`, {
      cwd: repoPath,
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer
      shell: true, // Use system default shell (zsh on macOS, bash on Linux, cmd on Windows)
    });
    return stdout.trim();
  } catch (error) {
    throw new Error(`Git command failed: ${error.message}`);
  }
}

/**
 * Get remote URL (GitHub/GitLab URL) from local repo
 * @param {string} [repoPath] - Repository path
 * @param {string} [remoteName='origin'] - Remote name
 * @returns {Promise<string|null>} Remote URL or null
 */
export async function getRemoteUrl(repoPath = config.git.repoPath, remoteName = 'origin') {
  try {
    const url = await execGit(`remote get-url ${remoteName}`, repoPath);
    return url || null;
  } catch {
    return null;
  }
}

/**
 * Get list of commits
 * @param {object} options - Options
 * @param {number} [options.limit=50] - Number of commits to fetch
 * @param {number} [options.offset=0] - Offset for pagination
 * @param {string} [options.branch] - Branch name
 * @param {string} [options.search] - Search in commit message
 * @param {string} [options.repoPath] - Repository path
 * @returns {Promise<Array>} List of commits
 */
export async function getCommits(options = {}) {
  const {
    limit = 50,
    offset = 0,
    branch = config.git.branch,
    search = '',
    repoPath = config.git.repoPath,
  } = options;

  // Build git log command
  let command = `log ${branch} --format="%H|%h|%s|%an|%ae|%aI" -n ${limit + offset}`;
  if (search) {
    command += ` --grep="${search.replace(/"/g, '\\"')}"`;
  }

  const output = await execGit(command, repoPath);
  if (!output) return [];

  const lines = output.split('\n').slice(offset);
  const commits = [];

  // Get tags for mapping
  const tagsMap = await getTagsMap(repoPath);

  for (const line of lines) {
    const [hash, shortHash, message, author, email, date] = line.split('|');
    commits.push({
      hash,
      shortHash,
      message,
      author,
      email,
      date,
      tags: tagsMap[hash] || [],
    });
  }

  return commits;
}

/**
 * Get map of commit hash to tags
 * @param {string} [repoPath] - Repository path
 * @returns {Promise<Object>} Map of hash to tags array
 */
export async function getTagsMap(repoPath = config.git.repoPath) {
  try {
    const output = await execGit('show-ref --tags', repoPath);
    const tagsMap = {};

    for (const line of output.split('\n')) {
      if (!line) continue;
      const [hash, ref] = line.split(' ');
      const tag = ref.replace('refs/tags/', '');
      if (!tagsMap[hash]) tagsMap[hash] = [];
      tagsMap[hash].push(tag);
    }

    return tagsMap;
  } catch {
    return {};
  }
}

/**
 * Get list of tags
 * @param {string} [repoPath] - Repository path
 * @returns {Promise<Array>} List of tags with commit info
 */
export async function getTags(repoPath = config.git.repoPath) {
  try {
    const output = await execGit(
      'for-each-ref --sort=-creatordate --format="%(refname:short)|%(objectname:short)|%(creatordate:iso8601)|%(subject)" refs/tags',
      repoPath
    );

    if (!output) return [];

    return output.split('\n').map((line) => {
      const [name, shortHash, date, message] = line.split('|');
      return { name, shortHash, date, message };
    });
  } catch {
    return [];
  }
}

/**
 * Get current HEAD commit
 * @param {string} [repoPath] - Repository path
 * @returns {Promise<object>} Current commit info
 */
export async function getCurrentCommit(repoPath = config.git.repoPath) {
  const output = await execGit('log -1 --format="%H|%h|%s|%an|%aI"', repoPath);
  const [hash, shortHash, message, author, date] = output.split('|');
  return { hash, shortHash, message, author, date };
}

/**
 * Get repository status
 * @param {string} [repoPath] - Repository path
 * @returns {Promise<object>} Repository status
 */
export async function getRepoStatus(repoPath = config.git.repoPath) {
  const [currentCommit, statusOutput, branchOutput] = await Promise.all([
    getCurrentCommit(repoPath),
    execGit('status --porcelain', repoPath).catch(() => ''),
    execGit('branch --show-current', repoPath).catch(() => config.git.branch),
  ]);

  const hasChanges = statusOutput.length > 0;
  const changedFiles = hasChanges ? statusOutput.split('\n').filter(Boolean).length : 0;

  return {
    currentCommit,
    branch: branchOutput,
    hasChanges,
    changedFiles,
  };
}

/**
 * Fetch from remote
 * @param {string} [repoPath] - Repository path
 * @returns {Promise<boolean>} True if successful, false if no remote
 */
export async function fetchRemote(repoPath = config.git.repoPath) {
  try {
    await execGit('fetch origin', repoPath);
    return true;
  } catch (error) {
    // Ignore if no remote configured
    if (error.message.includes('does not appear to be a git repository') ||
        error.message.includes('Could not read from remote')) {
      return false;
    }
    throw error;
  }
}

/**
 * Checkout to specific commit (DEPRECATED - not recommended for deploy)
 * Use for reference only, deploy scripts should handle checkout themselves
 * @param {string} commitHash - Commit hash to checkout
 * @param {string} [repoPath] - Repository path
 * @returns {Promise<void>}
 */
export async function checkout(commitHash, repoPath = config.git.repoPath) {
  // Validate commit hash (only allow hex characters)
  if (!/^[a-f0-9]+$/i.test(commitHash)) {
    throw new Error('Invalid commit hash format');
  }

  await execGit(`checkout ${commitHash}`, repoPath);
}

/**
 * Verify commit exists
 * @param {string} commitHash - Commit hash to verify
 * @param {string} [repoPath] - Repository path
 * @returns {Promise<boolean>}
 */
export async function verifyCommit(commitHash, repoPath = config.git.repoPath) {
  try {
    await execGit(`cat-file -t ${commitHash}`, repoPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get commit info by hash
 * @param {string} commitHash - Commit hash
 * @param {string} [repoPath] - Repository path
 * @returns {Promise<object|null>}
 */
export async function getCommitInfo(commitHash, repoPath = config.git.repoPath) {
  try {
    const output = await execGit(
      `log -1 --format="%H|%h|%s|%an|%aI" ${commitHash}`,
      repoPath
    );
    const [hash, shortHash, message, author, date] = output.split('|');
    return { hash, shortHash, message, author, date };
  } catch {
    return null;
  }
}

/**
 * Get list of branches (local and remote)
 * @param {string} [repoPath] - Repository path
 * @returns {Promise<object>} Branches info
 */
export async function getBranches(repoPath = config.git.repoPath) {
  try {
    // Get current branch
    const currentBranch = await execGit('branch --show-current', repoPath).catch(() => 'main');

    // Get local branches
    const localOutput = await execGit('branch --format="%(refname:short)"', repoPath);
    const localBranches = localOutput ? localOutput.split('\n').filter(Boolean) : [];

    // Get remote branches
    const remoteOutput = await execGit('branch -r --format="%(refname:short)"', repoPath).catch(() => '');
    const remoteBranches = remoteOutput
      ? remoteOutput.split('\n')
          .filter(Boolean)
          .filter(b => !b.includes('HEAD'))
          .map(b => b.replace('origin/', ''))
      : [];

    // Merge and dedupe
    const allBranches = [...new Set([...localBranches, ...remoteBranches])];

    return {
      current: currentBranch,
      local: localBranches,
      remote: remoteBranches,
      all: allBranches,
    };
  } catch {
    return {
      current: 'main',
      local: ['main'],
      remote: [],
      all: ['main'],
    };
  }
}
