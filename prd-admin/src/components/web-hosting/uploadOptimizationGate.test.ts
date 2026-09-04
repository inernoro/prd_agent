import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pageSource = readFileSync(new URL('../../pages/WebPagesPage.tsx', import.meta.url), 'utf8');
const serviceSource = readFileSync(new URL('../../services/real/webPages.ts', import.meta.url), 'utf8');

describe('网页托管 ZIP 优化确认门', () => {
  it('只让 ZIP 进入审查式上传，不改变其他文件类型的原路径', () => {
    expect(pageSource).toContain("const isZip = file?.name.toLowerCase().endsWith('.zip') ?? false");
    expect(pageSource).toContain('if (file && isZip)');
    expect(pageSource).toContain('reviewSiteZip({');
    expect(pageSource).toContain('reuploadSite(');
    expect(pageSource).toContain('uploadSite({');
  });

  it('命中建议时停在决策态，优化版本必须先预览再确认', () => {
    expect(pageSource).toContain("reviewed.data.outcome === 'optimization-recommended'");
    expect(pageSource).toContain('setOptimization(reviewed.data)');
    expect(pageSource).toContain('optimizationPreview ? (');
    expect(pageSource).toContain('title="优化版本预览"');
    expect(pageSource).toContain('sandbox={DIRECT_PREVIEW_SANDBOX}');
    expect(pageSource).toContain("confirmOptimization('optimized')");
    expect(pageSource).toContain('请先等待检查完成，或点击“中止”后再关闭');
  });

  it('大 ZIP 使用分片上传和后台轮询，生成预览与确认保存仍是独立请求', () => {
    expect(serviceSource).toContain('export async function reviewSiteZip');
    expect(serviceSource).toContain('optimizationUploads()');
    expect(serviceSource).toContain('optimizationUploadChunk(');
    expect(serviceSource).toContain('optimizationUploadComplete(');
    expect(serviceSource).toContain('optimizationUploadStatus(');
    expect(serviceSource).toContain("status.data.status === 'failed'");
    expect(serviceSource).toContain('export async function prepareSiteOptimizationPreview');
    expect(serviceSource).toContain('export async function confirmSiteOptimization');
    expect(serviceSource).toContain('export async function cancelSiteOptimization');
    expect(pageSource).toContain('onStage: setOptimizationStage');
  });

  it('后台检查没有固定超时，重新打开上传窗口可以恢复待处理会话', () => {
    expect(serviceSource).toContain("const PENDING_OPTIMIZATION_SESSION_KEY = 'web-pages:pending-optimization-session'");
    expect(serviceSource).toContain('rememberPendingOptimizationSession(sessionId)');
    expect(serviceSource).toContain('export async function resumePendingSiteOptimization');
    expect(serviceSource).not.toContain('Date.now() + 15 * 60 * 1000');
    expect(pageSource).toContain('resumePendingSiteOptimization({');
  });
});
