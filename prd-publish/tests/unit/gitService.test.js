import { jest } from '@jest/globals';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const testRepoPath = resolve(__dirname, '../fixtures/test-repo');

// Mock config
jest.unstable_mockModule('../../src/config.js', () => ({
  config: {
    git: {
      repoPath: testRepoPath,
      branch: 'main',
    },
  },
}));

const {
  execGit,
  getCommits,
  getTags,
  getCurrentCommit,
  getRepoStatus,
  verifyCommit,
  getCommitInfo,
} = await import('../../src/services/gitService.js');

describe('GitService', () => {
  beforeAll(() => {
    // Create test repository
    if (existsSync(testRepoPath)) {
      rmSync(testRepoPath, { recursive: true });
    }
    mkdirSync(testRepoPath, { recursive: true });

    // Initialize git repo
    execSync('git init', { cwd: testRepoPath });
    execSync('git config user.email "test@test.com"', { cwd: testRepoPath });
    execSync('git config user.name "Test User"', { cwd: testRepoPath });

    // Create initial commit
    execSync('echo "initial" > README.md', { cwd: testRepoPath });
    execSync('git add .', { cwd: testRepoPath });
    execSync('git commit -m "Initial commit"', { cwd: testRepoPath });

    // Rename default branch to main
    try {
      execSync('git branch -M main', { cwd: testRepoPath });
    } catch (e) {
      // Branch might already be named main
    }

    // Create more commits
    execSync('echo "feature 1" > feature1.txt', { cwd: testRepoPath });
    execSync('git add .', { cwd: testRepoPath });
    execSync('git commit -m "feat: Add feature 1"', { cwd: testRepoPath });

    execSync('echo "feature 2" > feature2.txt', { cwd: testRepoPath });
    execSync('git add .', { cwd: testRepoPath });
    execSync('git commit -m "feat: Add feature 2"', { cwd: testRepoPath });

    // Create a tag
    execSync('git tag v1.0.0 -m "Version 1.0.0"', { cwd: testRepoPath });
  });

  afterAll(() => {
    // Clean up test repository
    if (existsSync(testRepoPath)) {
      rmSync(testRepoPath, { recursive: true });
    }
  });

  describe('execGit', () => {
    it('should execute git command', async () => {
      const output = await execGit('status', testRepoPath);
      expect(output.match(/main|master/)).toBeTruthy();
    });

    it('should throw error for invalid command', async () => {
      await expect(execGit('invalid-command', testRepoPath)).rejects.toThrow();
    });
  });

  describe('getCommits', () => {
    it('should return list of commits', async () => {
      const commits = await getCommits({ repoPath: testRepoPath });
      expect(commits.length).toBeGreaterThan(0);
    });

    it('should include commit details', async () => {
      const commits = await getCommits({ repoPath: testRepoPath });
      const commit = commits[0];

      expect(commit.hash).toBeTruthy();
      expect(commit.shortHash).toBeTruthy();
      expect(commit.message).toBeTruthy();
      expect(commit.author).toBeTruthy();
      expect(commit.date).toBeTruthy();
    });

    it('should respect limit parameter', async () => {
      const commits = await getCommits({ limit: 1, repoPath: testRepoPath });
      expect(commits).toHaveLength(1);
    });

    it('should search by message', async () => {
      const commits = await getCommits({ search: 'feature 1', repoPath: testRepoPath });
      expect(commits.some(c => c.message.includes('feature 1'))).toBe(true);
    });
  });

  describe('getTags', () => {
    it('should return list of tags', async () => {
      const tags = await getTags(testRepoPath);
      expect(tags.length).toBeGreaterThan(0);
    });

    it('should include tag details', async () => {
      const tags = await getTags(testRepoPath);
      const tag = tags[0];

      expect(tag.name).toBe('v1.0.0');
      expect(tag.shortHash).toBeTruthy();
    });
  });

  describe('getCurrentCommit', () => {
    it('should return current HEAD commit', async () => {
      const commit = await getCurrentCommit(testRepoPath);

      expect(commit.hash).toBeTruthy();
      expect(commit.shortHash).toBeTruthy();
      expect(commit.message).toBeTruthy();
    });
  });

  describe('getRepoStatus', () => {
    it('should return repository status', async () => {
      const status = await getRepoStatus(testRepoPath);

      expect(status.currentCommit).toBeTruthy();
      expect(['main', 'master']).toContain(status.branch);
      expect(typeof status.hasChanges).toBe('boolean');
    });
  });

  describe('verifyCommit', () => {
    it('should return true for valid commit', async () => {
      const commits = await getCommits({ limit: 1, repoPath: testRepoPath });
      const valid = await verifyCommit(commits[0].hash, testRepoPath);
      expect(valid).toBe(true);
    });

    it('should return false for invalid commit', async () => {
      const valid = await verifyCommit('0000000000000000000000000000000000000000', testRepoPath);
      expect(valid).toBe(false);
    });
  });

  describe('getCommitInfo', () => {
    it('should return commit info for valid hash', async () => {
      const commits = await getCommits({ limit: 1, repoPath: testRepoPath });
      const info = await getCommitInfo(commits[0].hash, testRepoPath);

      expect(info).toBeTruthy();
      expect(info.hash).toBe(commits[0].hash);
    });

    it('should return null for invalid hash', async () => {
      const info = await getCommitInfo('invalid', testRepoPath);
      expect(info).toBeNull();
    });
  });
});
