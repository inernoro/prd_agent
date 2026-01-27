import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { join } from 'path';
import { config } from '../config.js';
import * as gitService from './gitService.js';
import * as historyService from './historyService.js';
import { getTimestamp } from '../utils/timeUtils.js';

// Current deployment state
let currentDeploy = null;
let deployLock = false;

// Event emitter for deployment events
export const deployEvents = new EventEmitter();

/**
 * Deployment status enum
 */
export const DeployStatus = {
  PENDING: 'pending',
  RUNNING: 'running',
  SUCCESS: 'success',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  RETRYING: 'retrying',
};

/**
 * Error types for retry decision
 */
export const ErrorType = {
  TIMEOUT: 'timeout',
  NETWORK: 'network',
  SCRIPT: 'script',
  CANCELLED: 'cancelled',
};

/**
 * Check if deployment is currently running
 * @returns {boolean}
 */
export function isDeploying() {
  return deployLock;
}

/**
 * Get current deployment info
 * @returns {object|null}
 */
export function getCurrentDeploy() {
  return currentDeploy;
}

/**
 * Resolve script path (relative to prd-publish base dir)
 * @param {string} scriptPath - Script path from config
 * @returns {string} Resolved absolute path
 */
function resolveScriptPath(scriptPath) {
  if (scriptPath.startsWith('/')) {
    return scriptPath;
  }
  return join(config.paths.baseDir, scriptPath);
}

/**
 * Execute deployment script
 * @param {object} options - Deploy options
 * @param {string} options.commitHash - Commit hash to deploy
 * @param {string} options.shortHash - Short commit hash
 * @param {string} options.branch - Branch name
 * @param {string} options.operator - Operator username
 * @param {object} options.project - Project configuration
 * @param {Function} [options.onOutput] - Callback for script output
 * @returns {Promise<object>} Deployment result
 */
export async function executeScript(options) {
  const { commitHash, shortHash, branch, operator, project, onOutput } = options;
  const scriptPath = resolveScriptPath(project.script);
  const repoPath = project.repoPath;

  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const logs = [];

    // Spawn process
    const process = spawn(scriptPath, [commitHash, shortHash, branch, project.id], {
      cwd: repoPath,
      shell: true,
      env: {
        ...global.process.env,
        COMMIT_HASH: commitHash,
        SHORT_HASH: shortHash,
        BRANCH: branch,
        PROJECT_ID: project.id,
        PROJECT_NAME: project.name,
        REPO_PATH: repoPath,
      },
    });

    let killed = false;

    // Timeout handler
    const timeoutId = setTimeout(() => {
      killed = true;
      process.kill('SIGTERM');
      setTimeout(() => {
        if (!process.killed) {
          process.kill('SIGKILL');
        }
      }, 5000);
    }, config.exec.timeout);

    // Output handlers
    const handleOutput = (data, stream) => {
      const text = data.toString();
      logs.push({ time: getTimestamp(), stream, text });
      if (onOutput) {
        onOutput({ stream, text });
      }
      deployEvents.emit('output', { stream, text });
    };

    process.stdout.on('data', (data) => handleOutput(data, 'stdout'));
    process.stderr.on('data', (data) => handleOutput(data, 'stderr'));

    process.on('close', (code) => {
      clearTimeout(timeoutId);
      const duration = Date.now() - startTime;

      if (killed) {
        resolve({
          success: false,
          errorType: ErrorType.TIMEOUT,
          code: -1,
          duration,
          logs,
          message: `部署超时（${config.exec.timeout / 1000}秒）`,
        });
      } else if (code === 0) {
        resolve({
          success: true,
          code: 0,
          duration,
          logs,
          message: '部署成功',
        });
      } else {
        resolve({
          success: false,
          errorType: ErrorType.SCRIPT,
          code,
          duration,
          logs,
          message: `脚本执行失败，退出码: ${code}`,
        });
      }
    });

    process.on('error', (error) => {
      clearTimeout(timeoutId);
      const duration = Date.now() - startTime;
      resolve({
        success: false,
        errorType: ErrorType.SCRIPT,
        code: -1,
        duration,
        logs,
        message: `执行错误: ${error.message}`,
      });
    });

    // Store process reference for cancellation
    currentDeploy = {
      ...currentDeploy,
      process,
    };
  });
}

/**
 * Should auto retry based on error type
 * @param {string} errorType - Error type
 * @returns {boolean}
 */
export function shouldAutoRetry(errorType) {
  return errorType === ErrorType.TIMEOUT || errorType === ErrorType.NETWORK;
}

/**
 * Deploy to specific commit
 * @param {object} options - Deploy options
 * @param {string} options.commitHash - Commit hash
 * @param {string} options.operator - Operator username
 * @param {object} options.project - Project configuration
 * @param {Function} [options.onOutput] - Output callback
 * @param {Function} [options.onStatus] - Status change callback
 * @returns {Promise<object>} Deployment result
 */
export async function deploy(options) {
  const { commitHash, operator, project, onOutput, onStatus } = options;

  // Check lock
  if (deployLock) {
    throw new Error('另一个部署正在进行中');
  }

  // Validate commit
  const commitInfo = await gitService.getCommitInfo(commitHash, project.repoPath);
  if (!commitInfo) {
    throw new Error('无效的 commit hash');
  }

  // Acquire lock
  deployLock = true;
  const deployId = `deploy_${Date.now()}`;

  currentDeploy = {
    id: deployId,
    projectId: project.id,
    projectName: project.name,
    commitHash: commitInfo.hash,
    shortHash: commitInfo.shortHash,
    message: commitInfo.message,
    operator,
    status: DeployStatus.RUNNING,
    startTime: getTimestamp(),
    retryCount: 0,
    logs: [],
  };

  deployEvents.emit('start', currentDeploy);
  if (onStatus) onStatus(DeployStatus.RUNNING, currentDeploy);

  try {
    // Fetch latest (optional, may fail if no remote)
    const fetched = await gitService.fetchRemote(project.repoPath);
    if (fetched) {
      if (onOutput) onOutput({ stream: 'system', text: '已获取最新代码\n' });
    } else {
      if (onOutput) onOutput({ stream: 'system', text: '跳过远程获取（无远程仓库）\n' });
    }

    // Get branch info
    const repoStatus = await gitService.getRepoStatus(project.repoPath);
    const branch = repoStatus.branch || project.branch;

    // Checkout the commit
    if (onOutput) onOutput({ stream: 'system', text: `切换到版本 ${commitInfo.shortHash}...\n` });
    await gitService.checkout(commitInfo.hash, project.repoPath);

    // Execute deployment with retry
    let result;
    let retryCount = 0;
    const maxRetries = config.retry.autoRetry ? config.retry.maxCount : 0;

    do {
      if (retryCount > 0) {
        currentDeploy.status = DeployStatus.RETRYING;
        currentDeploy.retryCount = retryCount;
        deployEvents.emit('retry', { retryCount, maxRetries });
        if (onStatus) onStatus(DeployStatus.RETRYING, { retryCount, maxRetries });
        if (onOutput) {
          onOutput({
            stream: 'system',
            text: `重试中 (${retryCount}/${maxRetries})，等待 ${config.retry.delay / 1000} 秒...\n`,
          });
        }

        // Wait before retry
        await new Promise((resolve) => setTimeout(resolve, config.retry.delay));
      }

      result = await executeScript({
        commitHash: commitInfo.hash,
        shortHash: commitInfo.shortHash,
        branch,
        operator,
        project,
        onOutput,
      });

      retryCount++;
    } while (
      !result.success &&
      shouldAutoRetry(result.errorType) &&
      retryCount <= maxRetries
    );

    // Update deploy state
    const finalStatus = result.success ? DeployStatus.SUCCESS : DeployStatus.FAILED;
    currentDeploy.status = finalStatus;
    currentDeploy.endTime = getTimestamp();
    currentDeploy.duration = result.duration;
    currentDeploy.result = result;
    currentDeploy.retryCount = retryCount - 1;

    // Save to history
    await historyService.addRecord({
      id: deployId,
      projectId: project.id,
      projectName: project.name,
      commitHash: commitInfo.hash,
      shortHash: commitInfo.shortHash,
      message: commitInfo.message,
      operator,
      status: finalStatus,
      startTime: currentDeploy.startTime,
      endTime: currentDeploy.endTime,
      duration: result.duration,
      retryCount: currentDeploy.retryCount,
      logs: result.logs,
    });

    deployEvents.emit('complete', currentDeploy);
    if (onStatus) onStatus(finalStatus, currentDeploy);

    return {
      success: result.success,
      deployId,
      ...currentDeploy,
    };
  } catch (error) {
    currentDeploy.status = DeployStatus.FAILED;
    currentDeploy.error = error.message;
    deployEvents.emit('error', error);
    if (onStatus) onStatus(DeployStatus.FAILED, { error: error.message });
    throw error;
  } finally {
    deployLock = false;
  }
}

/**
 * Cancel current deployment
 * @returns {boolean} Whether cancellation was successful
 */
export function cancelDeploy() {
  if (!currentDeploy || !currentDeploy.process) {
    return false;
  }

  try {
    currentDeploy.process.kill('SIGTERM');
    currentDeploy.status = DeployStatus.CANCELLED;
    deployEvents.emit('cancelled', currentDeploy);
    return true;
  } catch {
    return false;
  }
}

/**
 * Retry deployment from history
 * @param {string} historyId - History record ID
 * @param {string} operator - Operator username
 * @param {object} project - Project configuration
 * @param {Function} [onOutput] - Output callback
 * @param {Function} [onStatus] - Status callback
 * @returns {Promise<object>} Deployment result
 */
export async function retryFromHistory(historyId, operator, project, onOutput, onStatus) {
  const record = await historyService.getRecord(historyId);
  if (!record) {
    throw new Error('未找到历史记录');
  }

  return deploy({
    commitHash: record.commitHash,
    operator,
    project,
    onOutput,
    onStatus,
  });
}

// Export for testing
export const _internal = {
  resetState: () => {
    currentDeploy = null;
    deployLock = false;
  },
};
