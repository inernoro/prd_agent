import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../MdToPptAgentPage.tsx', import.meta.url), 'utf8');
const toolbarStart = source.indexOf('data-testid="ppt-preview-toolbar"');
const toolbarEnd = source.indexOf('{/* 编辑模式提示条 */}', toolbarStart);
const toolbar = source.slice(toolbarStart, toolbarEnd);
const mobileStart = source.indexOf('data-testid="md-to-ppt-mobile-desk"');
const mobileEnd = source.indexOf('{/* Main: left chat + right artifact */}', mobileStart);
const mobileDesk = source.slice(mobileStart, mobileEnd);
const presentationStart = source.indexOf('{/* 演示模式（自定义全屏）');
const presentationEnd = source.indexOf('{/* KB picker modal */}', presentationStart);
const presentation = source.slice(presentationStart, presentationEnd);

describe('HTML PPT 预览工具条可访问性', () => {
  it('所有工具条按钮拥有至少 44px 的受控热区', () => {
    expect(toolbarStart).toBeGreaterThanOrEqual(0);
    expect(toolbar).toContain('[&_button]:min-h-11');
    expect(toolbar).toContain('[&_button]:min-w-11');
    expect(toolbar.match(/h-11 w-11/g)?.length).toBeGreaterThanOrEqual(5);
    expect(toolbar.match(/min-h-11 min-w-11/g)?.length).toBeGreaterThanOrEqual(4);
  });

  it('键盘焦点清晰，纯图标按钮都有可读名称', () => {
    expect(toolbar).toContain('[&_button]:focus-visible:ring-2');
    expect(toolbar).toContain('aria-label="上一页"');
    expect(toolbar).toContain('aria-label="下一页"');
    expect(toolbar).toContain('aria-label="关闭风格选择"');
    expect(toolbar).toContain('aria-label="下载独立 HTML"');
    expect(toolbar).toContain('aria-label="全屏演示"');
    expect(toolbar.match(/type="button"/g)?.length).toBeGreaterThanOrEqual(9);
  });

  it('手机完成态可复用演示入口，演示浮层挂载到 body', () => {
    expect(mobileStart).toBeGreaterThanOrEqual(0);
    expect(mobileDesk).toContain('data-testid="mobile-present-button"');
    expect(mobileDesk).toContain('onClick={handleFullscreen}');
    expect(mobileDesk).toContain('min-h-11');
    expect(presentationStart).toBeGreaterThanOrEqual(0);
    expect(presentation).toContain('createPortal(');
    expect(presentation).toContain('document.body');
    expect(presentation).toContain('style={{ height: \'100dvh\', maxHeight: \'100dvh\' }}');
  });
});
