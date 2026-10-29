import { describe, expect, it } from 'vitest';
import { getWebHostingUploadError } from './webHostingUploadLimits';

describe('网页托管容量', () => {
  it.each([600, 5000])('允许 %s MB 的 ZIP 包', mb => {
    expect(getWebHostingUploadError({ name: 'site.ZIP', size: mb * 1024 * 1024 })).toBeNull();
  });
  it('拒绝超过 5000 MB 的 ZIP 包', () => {
    expect(getWebHostingUploadError({ name: 'site.zip', size: 5000 * 1024 * 1024 + 1 })).toContain('5000 MB');
  });
  it('保留单个媒体文件的 500 MB 边界', () => {
    expect(getWebHostingUploadError({ name: 'lesson.mp4', size: 500 * 1024 * 1024 })).toBeNull();
    expect(getWebHostingUploadError({ name: 'lesson.mp4', size: 500 * 1024 * 1024 + 1 })).toContain('500 MB');
  });
});
