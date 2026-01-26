import { jest } from '@jest/globals';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { mkdirSync, writeFileSync, chmodSync, rmSync, existsSync } from 'fs';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const testRepoPath = resolve(__dirname, '../fixtures/deploy-test-repo');
const testScript = resolve(testRepoPath, 'exec.sh');
const testHistoryFile = resolve(__dirname, '../fixtures/deploy-history.json');

// Setup test repo with git
function setupTestRepo() {
  if (existsSync(testRepoPath)) {
    rmSync(testRepoPath, { recursive: true });
  }
  mkdirSync(testRepoPath, { recursive: true });

  execSync('git init', { cwd: testRepoPath });
  execSync('git config user.email "test@test.com"', { cwd: testRepoPath });
  execSync('git config user.name "Test User"', { cwd: testRepoPath });
  execSync('echo "test" > test.txt', { cwd: testRepoPath });
  execSync('git add .', { cwd: testRepoPath });
  execSync('git commit -m "Initial commit"', { cwd: testRepoPath });

  // Get commit hash
  const hash = execSync('git rev-parse HEAD', { cwd: testRepoPath }).toString().trim();
  return hash;
}

// Create test exec script
function createTestScript(exitCode = 0, delay = 0) {
  const script = `#!/bin/bash
echo "Deploying version: $2"
echo "Full hash: $1"
echo "Branch: $3"
${delay > 0 ? `sleep ${delay}` : ''}
exit ${exitCode}
`;
  writeFileSync(testScript, script);
  chmodSync(testScript, '755');
}

// Mock config
jest.unstable_mockModule('../../src/config.js', () => ({
  config: {
    git: {
      repoPath: testRepoPath,
      branch: 'main',
    },
    exec: {
      script: testScript,
      timeout: 5000,
    },
    retry: {
      autoRetry: false,
      maxCount: 3,
      delay: 100,
    },
    paths: {
      historyFile: testHistoryFile,
    },
  },
}));

// Clear history mock
jest.unstable_mockModule('../../src/services/historyService.js', () => ({
  addRecord: jest.fn(),
  getRecord: jest.fn(),
  getLastDeploy: jest.fn(),
}));

const {
  isDeploying,
  getCurrentDeploy,
  executeScript,
  shouldAutoRetry,
  deploy,
  cancelDeploy,
  DeployStatus,
  ErrorType,
  _internal,
} = await import('../../src/services/deployService.js');

const historyService = await import('../../src/services/historyService.js');

describe('DeployService', () => {
  let testCommitHash;

  beforeAll(() => {
    testCommitHash = setupTestRepo();
  });

  beforeEach(() => {
    _internal.resetState();
    jest.clearAllMocks();
    createTestScript(0, 0);
  });

  afterAll(() => {
    if (existsSync(testRepoPath)) {
      rmSync(testRepoPath, { recursive: true });
    }
    if (existsSync(testHistoryFile)) {
      rmSync(testHistoryFile);
    }
  });

  describe('isDeploying', () => {
    it('should return false when not deploying', () => {
      expect(isDeploying()).toBe(false);
    });
  });

  describe('getCurrentDeploy', () => {
    it('should return null when not deploying', () => {
      expect(getCurrentDeploy()).toBeNull();
    });
  });

  describe('DeployStatus', () => {
    it('should have correct status values', () => {
      expect(DeployStatus.PENDING).toBe('pending');
      expect(DeployStatus.RUNNING).toBe('running');
      expect(DeployStatus.SUCCESS).toBe('success');
      expect(DeployStatus.FAILED).toBe('failed');
      expect(DeployStatus.CANCELLED).toBe('cancelled');
      expect(DeployStatus.RETRYING).toBe('retrying');
    });
  });

  describe('ErrorType', () => {
    it('should have correct error types', () => {
      expect(ErrorType.TIMEOUT).toBe('timeout');
      expect(ErrorType.NETWORK).toBe('network');
      expect(ErrorType.SCRIPT).toBe('script');
      expect(ErrorType.CANCELLED).toBe('cancelled');
    });
  });

  describe('shouldAutoRetry', () => {
    it('should return true for timeout errors', () => {
      expect(shouldAutoRetry(ErrorType.TIMEOUT)).toBe(true);
    });

    it('should return true for network errors', () => {
      expect(shouldAutoRetry(ErrorType.NETWORK)).toBe(true);
    });

    it('should return false for script errors', () => {
      expect(shouldAutoRetry(ErrorType.SCRIPT)).toBe(false);
    });

    it('should return false for cancelled', () => {
      expect(shouldAutoRetry(ErrorType.CANCELLED)).toBe(false);
    });
  });

  describe('executeScript', () => {
    it('should execute script successfully', async () => {
      createTestScript(0, 0);

      const result = await executeScript({
        commitHash: testCommitHash,
        shortHash: testCommitHash.slice(0, 7),
        branch: 'main',
        operator: 'test',
      });

      expect(result.success).toBe(true);
      expect(result.code).toBe(0);
      expect(result.logs.length).toBeGreaterThan(0);
    });

    it('should handle script failure', async () => {
      createTestScript(1, 0);

      const result = await executeScript({
        commitHash: testCommitHash,
        shortHash: testCommitHash.slice(0, 7),
        branch: 'main',
        operator: 'test',
      });

      expect(result.success).toBe(false);
      expect(result.code).toBe(1);
      expect(result.errorType).toBe(ErrorType.SCRIPT);
    });

    it('should call onOutput callback', async () => {
      createTestScript(0, 0);
      const outputs = [];

      await executeScript({
        commitHash: testCommitHash,
        shortHash: testCommitHash.slice(0, 7),
        branch: 'main',
        operator: 'test',
        onOutput: (data) => outputs.push(data),
      });

      expect(outputs.length).toBeGreaterThan(0);
    });
  });

  describe('deploy', () => {
    it('should deploy successfully', async () => {
      createTestScript(0, 0);

      const result = await deploy({
        commitHash: testCommitHash,
        operator: 'testuser',
      });

      expect(result.success).toBe(true);
      expect(result.status).toBe(DeployStatus.SUCCESS);
      expect(historyService.addRecord).toHaveBeenCalled();
    });

    it('should reject invalid commit hash format', async () => {
      await expect(deploy({
        commitHash: 'invalid!hash',
        operator: 'testuser',
      })).rejects.toThrow();
    });

    it('should handle deployment failure', async () => {
      createTestScript(1, 0);

      const result = await deploy({
        commitHash: testCommitHash,
        operator: 'testuser',
      });

      expect(result.success).toBe(false);
      expect(result.status).toBe(DeployStatus.FAILED);
    });

    it('should prevent concurrent deployments', async () => {
      createTestScript(0, 1); // 1 second delay

      // Start first deployment (don't await)
      const firstDeploy = deploy({
        commitHash: testCommitHash,
        operator: 'testuser',
      });

      // Small delay to ensure first deploy starts
      await new Promise(resolve => setTimeout(resolve, 100));

      // Try second deployment
      await expect(deploy({
        commitHash: testCommitHash,
        operator: 'testuser2',
      })).rejects.toThrow('另一个部署正在进行中');

      // Wait for first to complete
      await firstDeploy;
    });

    it('should call status callbacks', async () => {
      createTestScript(0, 0);
      const statuses = [];

      await deploy({
        commitHash: testCommitHash,
        operator: 'testuser',
        onStatus: (status) => statuses.push(status),
      });

      expect(statuses).toContain(DeployStatus.RUNNING);
      expect(statuses).toContain(DeployStatus.SUCCESS);
    });
  });

  describe('cancelDeploy', () => {
    it('should return false when not deploying', () => {
      expect(cancelDeploy()).toBe(false);
    });
  });
});
