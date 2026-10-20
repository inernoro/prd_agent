import { describe, expect, it } from 'vitest';
import workflow from './VersionWorkflowTab.tsx?raw';
import client from '@/services/real/productAgent.ts?raw';

describe('T 申领来源权限由服务端决定', () => {
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
