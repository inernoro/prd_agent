import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const page = fs.readFileSync(path.join(dir, 'McpConsolePage.tsx'), 'utf8');
const css = fs.readFileSync(path.join(dir, 'mcp-console.css'), 'utf8');

describe('接入管理响应式安全边界', () => {
  it('手机端保留自然高度，长列表的内部滚动仅在宽屏启用', () => {
    expect(page).toContain('min-h-full flex-col lg:h-full lg:min-h-0');
    expect(page).not.toMatch(/className="[^"]*(?<!:)\boverflow-y-auto\b/);
    expect(page).toContain('lg:overflow-y-auto');
    expect(css).not.toMatch(/min-width:\s*720px/);
  });
  it('移动端保留管理入口，紧凑页头横滚而不堆叠', () => {
    expect(css).toContain('@media(max-width:639px)');
    expect(css).toMatch(/\.mcp-header\s*\{[^}]*overflow-x:\s*auto/);
    expect(page).toContain('aria-label={`管理 ${client.name} ${client.keyPrefix}`}');
  });
  it('图标刷新按钮有无障碍名称', () => {
    expect(page).toContain("aria-label={refreshing ? '正在刷新' : '刷新'}");
  });
  it('用户文案不依赖会随断点变化的屏幕方位', () => {
    const files = fs.readdirSync(dir).filter(f => /\.(ts|tsx)$/.test(f));
    for (const file of files) expect(fs.readFileSync(path.join(dir,file),'utf8')).not.toMatch(/右上角|左上角|右下角|左下角|右侧栏|左侧栏/);
  });
});
