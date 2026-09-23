import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('滚动列的客户端卡片不能被 flex 挤成条带', () => {
  const source = readFileSync(fileURLToPath(new URL('../McpConsolePage.tsx', import.meta.url)), 'utf8');
  expect(source).toContain('className="flex shrink-0 overflow-hidden rounded-[13px]"');
});
