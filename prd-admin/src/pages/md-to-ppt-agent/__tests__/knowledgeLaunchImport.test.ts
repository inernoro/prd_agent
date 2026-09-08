import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../MdToPptAgentPage.tsx', import.meta.url), 'utf8');

// 接线守卫；延迟正文、失败重试与真实请求三元组另由实际组件浏览器用例验证。
describe('HTML PPT 知识导入发送接线', () => {
  it('首帧即阻断未完成导入，桌面和手机按钮共用处理器同一判据', () => {
    expect(source).toContain('const launchImportBlocked = Boolean(context.launch && !launchImported)');
    expect(source.match(/disabled=\{!input.trim\(\) \|\| isProcessing \|\| launchImportBlocked\}/g)).toHaveLength(2);
    const handler = source.slice(source.indexOf('const handleSend ='), source.indexOf('const handlePublish ='));
    expect(handler).toContain('if (!text || isProcessing || launchImportBlocked) return;');
    expect(handler.indexOf('launchImportBlocked) return')).toBeLessThan(handler.indexOf("setInput('')"));
    expect(handler).toContain('[input, isProcessing, launchImportBlocked,');
    expect(source.match(/onClick=\{handleSend\}/g)).toHaveLength(2);
    expect(source.match(/e.preventDefault\(\);\s+handleSend\(\);/g)).toHaveLength(2);
  });

  it('两端显示同一加载/失败提示，失败可重试且旧异步响应失效', () => {
    expect(source.match(/\{launchImportNotice\}/g)).toHaveLength(2);
    expect(source).toContain('role={launchImportFailed ? \'alert\' : \'status\'}');
    expect(source).toContain('重试带入');
    expect(source).toContain('setLaunchImportAttempt((attempt) => attempt + 1)');
    expect(source).toContain('[context.launch, launchImported, launchImportAttempt]');
    expect(source).toContain('if (active) setLaunchImportFailed(true)');
    expect(source).toContain('return () => { active = false; }');
  });

  it('知识去重带库身份，引用加入后才标记完成；保留会话恢复字段', () => {
    expect(source).toContain('item.storeId === launch.sourceStoreId && item.entryId === launch.sourceEntryId');
    const effect = source.slice(source.indexOf('const launch = context.launch;'), source.indexOf('// 两端共用同一状态'));
    expect(effect.indexOf('setPendingKbRefs')).toBeLessThan(effect.indexOf('setLaunchImported(true)'));
    expect(source).toContain('savedSession?.launchImported ?? false');
    expect(source).toContain('savedSession?.pendingKbRefs ?? []');
  });
});
