import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(__dirname, '..', 'DocumentStorePage.tsx'), 'utf8');

describe('移动端知识阅读器的设计生成入口', () => {
  it('在沉浸阅读隐藏桌面顶栏后仍从更多菜单提供智能生成', () => {
    const readerMenuStart = source.indexOf('readerMenuExtra={isMobile ?');
    const readerMenuEnd = source.indexOf('tagColors=', readerMenuStart);
    const readerMenu = source.slice(readerMenuStart, readerMenuEnd);

    expect(readerMenuStart).toBeGreaterThan(-1);
    expect(readerMenuEnd).toBeGreaterThan(readerMenuStart);
    expect(readerMenu).toContain('selectedDocEntry');
    expect(readerMenu).toContain('setShowDesignLauncher(true)');
    expect(readerMenu).toContain('智能生成');
  });
});
