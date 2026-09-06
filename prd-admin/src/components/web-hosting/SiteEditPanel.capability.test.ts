import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./SiteEditPanel.tsx', import.meta.url), 'utf8');

describe('网页微调执行器事实接线', () => {
  it('展示实际执行归属和隔离边界，并保留未就绪原因', () => {
    expect(source).toContain('执行器与限制');
    expect(source).toContain('<details className="group');
    expect(source).toContain("activeRuntime.executionOwner === 'cds-remote-agent'");
    expect(source).toContain("activeRuntime.isolationMode === 'session-container'");
    expect(source).toContain("item.reason || '未启用'");
  });

  it('只有已启用执行器可以进入选择框', () => {
    expect(source).toContain('const enabledRuntimes = capabilities.filter((item) => item.enabled)');
    expect(source).toContain('{enabledRuntimes.map((item) => (');
  });

  it('只提交知识身份并由服务端校验正文和容量', () => {
    expect(source).not.toContain('getDocumentContent');
    expect(source).not.toContain('.slice(0, 20_000)');
    expect(source).toContain('entryId: entry.id');
    expect(source).toContain('storeId: entry.storeId');
  });

  it('在开始前明示首版自包含输入边界', () => {
    expect(source).toContain('首版仅支持声明式自包含 HTML，含脚本、外链或 ZIP 资源会在任务创建前提示。');
  });

  it('版本图标操作具有明确名称和不小于 36px 的点击热区', () => {
    expect(source).toContain('aria-label="刷新版本记录"');
    expect(source).toContain('aria-label="预览这个版本"');
    expect(source).toContain('aria-label="把这个版本重新发布为最新版"');
    expect(source.match(/inline-flex h-9 w-9 items-center justify-center/g)).toHaveLength(4);
  });
});
