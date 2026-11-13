import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ciImageNotice } from '../../web/src/lib/ci-image-notice.js';
import { CiImageNotice } from '../../web/src/components/branch/CiImageNotice.js';

describe('CI 原因与入口统一展示', () => {
  it('旧 cancelled 数据也显示取消，而非要求修复代码', () => {
    const html = renderToStaticMarkup(createElement(CiImageNotice, { branch: { ciImageStatus: 'failed', ciWorkflowConclusion: 'cancelled',
      githubRepoFullName: 'owner/repo', branch: 'feature/test' }, expanded: true }));
    expect(html).toContain('CI 已取消');
    expect(html).toContain('查看 Actions');
    expect(html).not.toContain('修复代码');
  });

  it('超时数据不能假称 GitHub 没有 run', () => {
    expect(ciImageNotice({ ciWorkflowConclusion: 'timed_out_no_run' }).title).toBe('CI 状态待核对');
  });

  it('等待和失败都能展示可用构建入口', () => {
    for (const ciImageStatus of ['waiting', 'failed']) {
      const html = renderToStaticMarkup(createElement(CiImageNotice, { branch: { ciImageStatus,
        ciWorkflowRunUrl: 'https://github.com/owner/repo/actions/runs/42' } }));
      expect(html).toContain('查看构建');
      expect(html).toContain('/actions/runs/42');
    }
  });

  it('旧目标诊断不覆盖新提交，并拒绝脚本链接', () => {
    const notice = ciImageNotice({ ciImageStatus: 'waiting', ciTargetSha: 'new', ciWorkflowRunUrl: 'javascript:alert(1)',
      ciDiagnosis: { code: 'cancelled', title: '旧取消原因', message: 'old', targetSha: 'old', checkedAt: '', actionUrl: '', actionLabel: '' } });
    expect(notice.title).toBe('等待 CI 镜像');
    expect(notice.actionUrl).toBe('');
  });
});
