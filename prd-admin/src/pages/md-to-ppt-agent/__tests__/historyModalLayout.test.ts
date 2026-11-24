import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../MdToPptAgentPage.tsx', import.meta.url), 'utf8');
const start = source.indexOf('{/* History modal');
const end = source.indexOf('{/* 演示模式', start);
const historyModal = source.slice(start, end);

describe('MD to PPT history modal layout', () => {
  it('keeps the dialog inside a 390px touch viewport and outside page clipping ancestors', () => {
    expect(historyModal).toContain('showHistory && createPortal(');
    expect(historyModal).toContain('document.body');
    expect(historyModal).toContain("width: 'min(560px, calc(100vw - 32px))'");
    expect(historyModal).toContain("maxWidth: 'calc(100vw - 32px)'");
    expect(historyModal).toContain("maxHeight: 'min(72vh, calc(100dvh - 32px))'");
    expect(historyModal).not.toContain('w-[560px]');
  });

  it('preserves a bounded scroll region and accessible dialog controls', () => {
    expect(historyModal).toContain('role="dialog"');
    expect(historyModal).toContain('aria-modal="true"');
    expect(historyModal).toContain('aria-label="关闭历史生成"');
    expect(historyModal).toContain("minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain'");
  });
});
