import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./SiteEditPanel.tsx', import.meta.url), 'utf8');

describe('网页微调执行器事实接线', () => {
  it('展示实际执行归属和隔离边界，并保留未就绪原因', () => {
    expect(source).toContain('执行器事实');
    expect(source).toContain("activeRuntime.executionOwner === 'cds-remote-agent'");
    expect(source).toContain("activeRuntime.isolationMode === 'session-container'");
    expect(source).toContain("item.reason || '未启用'");
  });

  it('只有已启用执行器可以进入选择框', () => {
    expect(source).toContain('const enabledRuntimes = capabilities.filter((item) => item.enabled)');
    expect(source).toContain('{enabledRuntimes.map((item) => (');
  });
});
