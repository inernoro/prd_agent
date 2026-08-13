import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./WebPagesPage.tsx', import.meta.url), 'utf8');
const handleSave = source.slice(
  source.indexOf('const handleSave = async () => {'),
  source.indexOf('const inputStyle = {'),
);

describe('WebPagesPage upload feedback contract', () => {
  it('surfaces backend failures for create, reupload, and metadata save', () => {
    expect(handleSave).toContain("toast.error('上传失败', res.error?.message || '请稍后重试')");
    expect(handleSave).toContain("toast.error('重新上传失败', res.error?.message || '请稍后重试')");
    expect(handleSave).toContain("toast.error('保存失败', res.error?.message || '请稍后重试')");
  });

  it('always releases the busy state after rejected requests', () => {
    expect(handleSave).toContain('} catch (error) {');
    expect(handleSave).toContain("error instanceof Error ? error.message : '网络异常，请稍后重试'");
    expect(handleSave).toContain('} finally {\n      setSaving(false);');
  });
});
