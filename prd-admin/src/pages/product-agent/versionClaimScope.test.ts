import { describe, expect, it } from 'vitest';
import workflow from './VersionWorkflowTab.tsx?raw';
import client from '@/services/real/productAgent.ts?raw';
import release from './ReleaseWorkflowDetail.tsx?raw';

describe('T 申领来源权限由服务端决定', () => {
  it('历史对照先核查，人工确认绑定当前方案和最新历史候选', () => {
    expect(release.indexOf('await checkReleaseHistory(')).toBeLessThan(release.indexOf('await createRelease('));
    expect(release).toContain('if (checked.data.blocked)');
    expect(release).toContain('historyReview.scope !== historyScope');
    expect(release).toContain('historyReview.check.confirmationToken !== checked.data.confirmationToken');
    expect(release).toContain('历史 T/V 对照人工确认');
    expect(release).toContain('historyScopeRef.current !== historyScope');
  });
  it('读取服务端范围提示，不发送可被伪造的全员开关', () => {
    expect(workflow).toContain('setCanUseAllReviews(res.data.canUseAllReviews)');
    expect(workflow).toContain('申领测试已开启：可选择所有人的已通过方案。');
    expect(workflow).toContain('仅可选择本人提交的已通过方案。');
    expect(workflow).toContain('每个评审方案只能申领一个 T，每个 T 只能申领一个 V。');
    const sourceApi = client.slice(client.indexOf('export function listProductVersionReviewSources()'), client.indexOf('export function parseProductVersionMessage'));
    expect(sourceApi).toContain('canUseAllReviews: boolean');
    expect(sourceApi).toContain("'/api/product/version-workflow/review-sources'");
    expect(sourceApi).not.toContain('?scope=all');
  });
});
