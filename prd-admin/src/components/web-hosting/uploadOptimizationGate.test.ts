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
    expect(pageSource).toContain("confirmOptimization('optimized')");
    expect(pageSource).toContain('请先等待检查完成，或点击“中止”后再关闭');
  });

  it('上传审查、生成预览和确认保存是三条独立请求', () => {
    expect(serviceSource).toContain('export async function reviewSiteZip');
    expect(serviceSource).toContain('export async function prepareSiteOptimizationPreview');
    expect(serviceSource).toContain('export async function confirmSiteOptimization');
    expect(serviceSource).toContain('export async function cancelSiteOptimization');
  });
});
