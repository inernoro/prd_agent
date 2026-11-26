import { describe, expect, it } from 'vitest';
import { findCurrentDeploymentRunId } from '../../web/src/lib/deploymentMeta.js';

const branch = { status: 'running', currentVersionId: 'version-current', runningCommitSha: 'a'.repeat(40) };
const currentRun = { id: 'run-current', status: 'running', versionId: branch.currentVersionId, commitSha: branch.runningCommitSha };

describe('部署账本当前运行记录', () => {
  it('新部署等镜像、CI 失败或取消时仍标记正在服务的成功记录', () => {
    for (const status of ['queued', 'failed', 'cancelled']) {
      const newerRun = { ...currentRun, id: `run-${status}`, status };
      expect(findCurrentDeploymentRunId([newerRun, currentRun], branch)).toBe(currentRun.id);
    }
  });

  it('同一提交的不同版本只标记当前版本，同版本重用时取最近的成功记录', () => {
    const newerOtherVersion = { ...currentRun, id: 'run-other-version', versionId: 'version-other' };
    const olderSameVersion = { ...currentRun, id: 'run-before-version-reuse' };
    expect(findCurrentDeploymentRunId([newerOtherVersion, currentRun, olderSameVersion], branch)).toBe(currentRun.id);
  });

  it('分支已停止、缺少当前版本或运行提交不符时不标记历史记录', () => {
    expect(findCurrentDeploymentRunId([currentRun], { ...branch, status: 'idle' })).toBeUndefined();
    expect(findCurrentDeploymentRunId([currentRun], { ...branch, currentVersionId: undefined })).toBeUndefined();
    expect(findCurrentDeploymentRunId([currentRun], { ...branch, runningCommitSha: 'b'.repeat(40) })).toBeUndefined();
  });
});
