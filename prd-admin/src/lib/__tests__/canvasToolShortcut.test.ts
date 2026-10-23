import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { resolveCanvasToolShortcut } from '../canvasToolShortcut';

const keyEvent = (overrides: Partial<KeyboardEvent>): KeyboardEvent =>
  ({
    key: '',
    code: '',
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    ...overrides,
  }) as KeyboardEvent;

describe('resolveCanvasToolShortcut', () => {
  it.each([
    [{ key: 'h', code: 'KeyH' }, 'hand'],
    [{ key: 'H', code: 'KeyH' }, 'hand'],
    [{ key: 'v', code: 'KeyV' }, 'select'],
    [{ key: 'V', code: 'KeyV' }, 'select'],
  ] as const)('把 %o 解析为 %s 工具', (event, expected) => {
    expect(resolveCanvasToolShortcut(keyEvent(event))).toBe(expected);
  });

  it('不抢占带系统修饰键的快捷键', () => {
    expect(resolveCanvasToolShortcut(keyEvent({ key: 'h', code: 'KeyH', metaKey: true }))).toBeNull();
    expect(resolveCanvasToolShortcut(keyEvent({ key: 'v', code: 'KeyV', ctrlKey: true }))).toBeNull();
    expect(resolveCanvasToolShortcut(keyEvent({ key: 'h', code: 'KeyH', altKey: true }))).toBeNull();
  });

  it('在视觉画布键盘入口中真正更新 activeTool', () => {
    const source = readFileSync(
      new URL('../../pages/ai-chat/AdvancedVisualAgentTab.tsx', import.meta.url),
      'utf8',
    );

    expect(source).toContain('resolveCanvasToolShortcut(e)');
    expect(source).toContain('setActiveTool(toolShortcut)');
  });
});
