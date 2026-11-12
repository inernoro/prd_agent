import { describe, expect, it } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';
import { StateService } from '../../src/services/state.js';
import { createReportsRouter, createPublicReportShareRouter } from '../../src/routes/reports.js';
import { buildMarkdownReportDocument, enhanceHtmlReportDocument } from '../../src/shared/report-document.js';

const sample = fs.readFileSync(new URL('../fixtures/report-reading.md', import.meta.url), 'utf8');

describe('报告入口内容一致性', () => {
  it('保留宽表格末列、代码、图表源码、图片及长链接，并提供阅读恢复工具', () => {
    for (const theme of ['light', 'dark'] as const) {
      const html = buildMarkdownReportDocument(sample, theme);
      for (const marker of ['LAST-COLUMN-CDS', 'LAST-COLUMN-LLMGW', 'REQUEST-CODE-END', 'language-mermaid', 'timeline', 'fixture.svg', 'example.com/?report=', 'READING-END']) expect(html).toContain(marker);
      expect(html).toContain('重新加载图片');
      expect(html).toContain('重新渲染图表');
      expect(html).toContain('overflow:auto');
      expect(html).toContain('color-scheme:' + theme);
    }
  });
  it('HTML 保留作者结构、样式与内容，补 viewport，禁止自动跳出正文', () => {
    const html = enhanceHtmlReportDocument('<html><head><meta http-equiv="refresh" content="0;url=https://example.com"><style>.paper{background:white;color:black}</style></head><body><div class="paper"><table><tr><td>完整单元格</td></tr></table></div></body></html>', 'dark');
    expect(html).toContain('.paper{background:white;color:black}');
    expect(html).toContain('完整单元格');
    expect(html).toContain('name="viewport"');
    expect(html).not.toContain('http-equiv="refresh"');
  });
  it('实际分享路由返回可读 HTML，而 raw 仍保持 Markdown 下载契约与安全沙箱', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'report-reading-'));
    const state = new StateService(path.join(dir, 'state.json')); state.load();
    const meta = state.createAcceptanceReport({ title: '长标题 <报告> "完整"', content: sample, format: 'md', projectId: null, branchId: null });
    const shared = state.enableReportShare(meta.id)!;
    const app = express(); app.use('/api', createReportsRouter({ stateService: state })); app.use('/r', createPublicReportShareRouter({ stateService: state }));
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
    try {
      const raw = await fetch(`${base}/api/reports/${meta.id}/raw`);
      expect(raw.headers.get('content-type')).toContain('text/markdown'); expect(await raw.text()).toBe(sample);
      const response = await fetch(`${base}/r/${shared.shareToken}?theme=dark`); const body = await response.text();
      expect(response.headers.get('content-type')).toContain('text/html');
      expect(response.headers.get('content-security-policy')).toContain('sandbox allow-scripts');
      expect(body).toContain('LAST-COLUMN-LLMGW'); expect(body).toContain('&lt;table&gt;');
      expect(body).toContain('返回'); expect(body).toContain('浅色主题'); expect(body).toContain('重新加载');
      expect(body).not.toContain('allow-same-origin');
      state.disableReportShare(meta.id);
      expect((await fetch(`${base}/r/${shared.shareToken}`)).status).toBe(404);
    } finally { await flushAllJsonStateStores(); await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(dir, {recursive:true,force:true}); }
  });
});
