import { expect, it } from 'vitest';
import { ApiError } from '../../web/src/lib/api';
import { canRevokeReleaseApproval, chooseReleaseWorkbenchBranch, releaseApprovalPath, releaseApprovalReadFailure, releaseApprovalState, releaseApprovalWorkbenchPath, releaseWorkbenchCommit } from '../../web/src/lib/releaseApproval';

it('uses an exact approval link and hides live actions whenever a pending or approved window expires', () => {
  expect(releaseApprovalPath('ra_one')).toBe('/release-center/approval?request=ra_one');
  expect(releaseApprovalPath('ra_one', { projectId:'p',targetId:'a' })).toBe('/release-center/approval?request=ra_one&project=p&target=a');
  const expiresAt = '2026-11-18T00:55:32.000Z';
  const deadline = Date.parse(expiresAt);
  expect(releaseApprovalState({ status: 'pending', expiresAt }, deadline - 1)).toBe('pending');
  expect(releaseApprovalState({ status: 'pending', expiresAt }, deadline)).toBe('expired');
  expect(releaseApprovalState({ status: 'approved', expiresAt }, deadline + 1)).toBe('expired');
  expect(releaseApprovalState({ status: 'approved', expiresAt, consumedBy:'run' }, deadline)).toBe('used');
  expect(releaseApprovalState({ status: 'revoked', expiresAt }, deadline)).toBe('revoked');
  expect(releaseApprovalState({ status: 'pending', expiresAt:'invalid' }, deadline)).toBe('expired');
});


it('carries the approved branch and target to single-target workbench without fallback to a different branch', () => {
  expect(releaseApprovalWorkbenchPath({ projectId:'p',targetId:'target-a',branchId:'b' }))
    .toBe('/release-console?project=p&target=target-a&mode=single&branch=b');
  const branches = [{ id:'main' }, { id:'b' }];
  expect(chooseReleaseWorkbenchBranch(branches, '', 'b')).toBe('b');
  expect(chooseReleaseWorkbenchBranch(branches, '', 'unavailable')).toBe('');
  expect(chooseReleaseWorkbenchBranch(branches, '', '')).toBe('main');
});

it('carries the pinned revision even when the branch listing has older GitHub metadata', () => {
  const branch = { pinnedCommit: 'approved-second', githubCommitSha: 'older', commitSha: 'older' };
  expect(releaseWorkbenchCommit(branch)).toBe('approved-second');
  expect(releaseWorkbenchCommit({ githubCommitSha: 'older' })).toBe('older');
  expect(releaseWorkbenchCommit({ commitSha: 'legacy-release' })).toBe('legacy-release');
});

it('keeps a consumed approval revocable for an accepted run and excludes ended decisions', () => {
  const record = { status: 'approved', expiresAt: '2026-11-18T00:55:32.000Z', consumedBy: 'connecting-run' } as const;
  expect(releaseApprovalState(record, Date.parse(record.expiresAt))).toBe('used');
  expect(canRevokeReleaseApproval(record)).toBe(true);
  expect(canRevokeReleaseApproval({ status: 'revoked' })).toBe(false);
  expect(canRevokeReleaseApproval({ status: 'rejected' })).toBe(false);
});

it('retains approval records through temporary failures for the same target only', () => {
  const lastRead = { key: 'target-a', result: ['approval-a'] };
  const outage = new ApiError(503, {}, 'upstream timeout');
  expect(releaseApprovalReadFailure(lastRead, 'target-a', outage, '刷新失败')).toEqual({ ...lastRead, error: '刷新失败' });
  expect(releaseApprovalReadFailure(lastRead, 'target-b', outage, '刷新失败').result).toBeUndefined();
  for (const status of [401, 403, 404]) {
    expect(releaseApprovalReadFailure(lastRead, 'target-a', new ApiError(status, {}, 'unavailable'), '无法读取').result).toBeUndefined();
  }
});
