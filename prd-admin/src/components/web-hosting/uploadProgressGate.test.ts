import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { showsUploadProgress, buildUploadProgress } from './uploadProgress';

/**
 * 重传（编辑既有站点 + 选了新文件）此前拿不到进度那一屏。
 *
 * 断的是行为不是写法：`saving && !isEdit` 与 `showsUploadProgress` 都能编译、都能通过
 * 类型检查，全量测试也都是绿的——差别只有「重传时屏幕上有没有东西在动」。
 */
describe('showsUploadProgress', () => {
  it('重传（编辑 + 选了文件）必须显示进度屏', () => {
    expect(showsUploadProgress({ saving: true, isEdit: true, hasFile: true })).toBe(true);
  });

  it('新建上传显示进度屏', () => {
    expect(showsUploadProgress({ saving: true, isEdit: false, hasFile: true })).toBe(true);
  });

  it('纯改元信息没有文件要传，不占用这一屏', () => {
    expect(showsUploadProgress({ saving: true, isEdit: true, hasFile: false })).toBe(false);
  });

  it('没在提交就不显示', () => {
    for (const isEdit of [true, false]) {
      for (const hasFile of [true, false]) {
        expect(showsUploadProgress({ saving: false, isEdit, hasFile })).toBe(false);
      }
    }
  });

  it('重传这条链路端到端接得上：帧进得来、门放得过、算得出在动的内容', () => {
    // 重传走 fetch，拿不到 XHR progress，loaded/total 恒为 0——
    // 唯一的信号是服务端解包帧。
    const view = buildUploadProgress(0, 0, 4200, {
      doneFiles: 3, totalFiles: 10, currentPath: 'assets/app.js', currentSize: 2048,
    });
    expect(showsUploadProgress({ saving: true, isEdit: true, hasFile: true })).toBe(true);
    expect(view.phase).toBe('processing');
    expect(view.ratio).toBeCloseTo(0.3, 5);
    // 屏幕上必须有随帧变化的内容，而不是一个不动的字
    expect(view.steps.length).toBeGreaterThan(0);
  });
});

describe('页面确实走了这个判据（接线守卫）', () => {
  it('WebPagesPage 用 showsUploadProgress 决定进度屏，而不是自己再写一遍条件', () => {
    const src = readFileSync(
      new URL('../../pages/WebPagesPage.tsx', import.meta.url), 'utf8');
    expect(src).toContain('showsUploadProgress({');
    // 抄回一份等价条件就会让上面那些行为断言变成空转
    expect(src).not.toContain('saving && !isEdit');
  });
});
