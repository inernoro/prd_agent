import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
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
    const anchored = enhanceHtmlReportDocument('<a href="#目标章节">跳转</a><h2>目标章节</h2><p>完整内容</p>', 'light');
    expect(anchored).toContain('id="目标章节"');
    expect(anchored).toContain("target.scrollIntoView({ behavior: 'smooth', block: 'start' })");
  });
  describe('HTML纸面配色与Markdown宿主题', () => {
    let browser: Browser;
    beforeAll(async () => {
      browser = await chromium.launch({ ...(process.env.CDS_CHROMIUM_PATH ? { executablePath: process.env.CDS_CHROMIUM_PATH } : { channel: 'chrome' }), headless: true });
    });
    afterAll(async () => { await browser?.close(); });

    it.each([
      { paper: 'light', authoredLink: false },
      { paper: 'light', authoredLink: true },
      { paper: 'dark', authoredLink: false },
      { paper: 'dark', authoredLink: true },
    ] as const)('HTML纸面 $paper、作者链接配色 $authoredLink：链接与两张图表可读', async ({ paper, authoredLink }) => {
      const page = await browser.newPage();
      try {
        const host = paper === 'light' ? 'dark' : 'light';
        const background = paper === 'light' ? '#fffdf8' : '#17191f';
        const foreground = paper === 'light' ? '#211d18' : '#f1f5f9';
        const link = paper === 'light' ? '#125e36' : '#80cbc4';
        await page.evaluate(() => {
          const state = window as unknown as { mermaid: { initialize: (value: { theme: string }) => void; render: () => Promise<{ svg: string }> } };
          let theme = '';
          state.mermaid = { initialize: value => { theme = value.theme; }, render: async () => ({ svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 80" data-render-theme="${theme}"><text x="10" y="30">图表</text></svg>` }) };
        });
        const original = `<style>body{background:${background};color:${foreground}}${authoredLink ? `a{color:${link}}` : ''}pre.authored-code{background:#18353b;color:#d9f7f1}</style><main class="paper"><h1>报告纸面</h1><a id="paper-link" href="https://example.com">完整证据链接</a><pre id="plain-code"><code>REQUEST-CODE-END：完整代码必须可读</code></pre><pre id="authored-code" class="authored-code"><code>作者自带代码配色</code></pre><pre class="mermaid">flowchart LR\n A[报告] --&gt; B[阅读]</pre><pre class="mermaid">timeline\n 2026-11-12 : 完成</pre></main>`;
        await page.setContent(enhanceHtmlReportDocument(original, host));
        await page.locator('[data-report-diagram] svg').nth(1).waitFor();
        expect(await page.locator('[data-render-theme]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-render-theme')))).toEqual([paper === 'light' ? 'default' : 'dark', paper === 'light' ? 'default' : 'dark']);
        const actual = await page.locator('#paper-link').evaluate(node => ({ color: getComputedStyle(node).color, background: getComputedStyle(document.body).backgroundColor }));
        if (authoredLink) expect(actual.color).toBe(paper === 'light' ? 'rgb(18, 94, 54)' : 'rgb(128, 203, 196)');
        const luminance = (value: string) => value.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(channel => {
          const scaled = channel / 255; return scaled <= .04045 ? scaled / 12.92 : ((scaled + .055) / 1.055) ** 2.4;
        }).reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0);
        const first = luminance(actual.color), second = luminance(actual.background);
        expect((Math.max(first, second) + .05) / (Math.min(first, second) + .05)).toBeGreaterThanOrEqual(4.5);
        const code = await page.locator('#plain-code').evaluate(node => ({ color: getComputedStyle(node).color, background: getComputedStyle(node).backgroundColor, overflow: getComputedStyle(node).overflowX, whiteSpace: getComputedStyle(node).whiteSpace }));
        expect(code.background).toBe('rgba(0, 0, 0, 0)');
        expect(code.color).toBe(paper === 'light' ? 'rgb(33, 29, 24)' : 'rgb(241, 245, 249)');
        expect(code.overflow).toBe('auto'); expect(code.whiteSpace).toBe('pre');
        const codeLuminance = luminance(code.color);
        expect((Math.max(codeLuminance, second) + .05) / (Math.min(codeLuminance, second) + .05)).toBeGreaterThanOrEqual(4.5);
        expect(await page.locator('#authored-code').evaluate(node => ({ color: getComputedStyle(node).color, background: getComputedStyle(node).backgroundColor }))).toEqual({ color: 'rgb(217, 247, 241)', background: 'rgb(24, 53, 59)' });
      } finally { await page.close(); }
    });

    it('Markdown链接仍跟随深色宿主题', async () => {
      const page = await browser.newPage();
      try {
        await page.setContent(buildMarkdownReportDocument('[证据](https://example.com)\n\n```text\n完整代码\n```', 'dark'));
        expect(await page.locator('a').evaluate(node => getComputedStyle(node).color)).toBe('rgb(96, 165, 250)');
        expect(await page.locator('pre').evaluate(node => getComputedStyle(node).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
      } finally { await page.close(); }
    });
  });

  it('实际分享路由返回可读 HTML，而 raw 仍保持 Markdown 下载契约与安全沙箱', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'report-reading-'));
    const state = new StateService(path.join(dir, 'state.json')); state.load();
    const meta = state.createAcceptanceReport({ title: '长标题 <报告> "完整"', content: sample, format: 'md', projectId: null, branchId: null });
    const shareToken = state.enableReportShare(meta.id)!.shareToken!;
    const app = express(); app.use('/api', createReportsRouter({ stateService: state })); app.use('/r', createPublicReportShareRouter({ stateService: state }));
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
    try {
      const raw = await fetch(`${base}/api/reports/${meta.id}/raw`);
      expect(raw.headers.get('content-type')).toContain('text/markdown'); expect(await raw.text()).toBe(sample);
      const response = await fetch(`${base}/r/${shareToken}?theme=dark`); const body = await response.text();
      expect(response.headers.get('content-type')).toContain('text/html');
      expect(response.headers.get('content-security-policy')).toContain('sandbox allow-scripts');
      expect(body).toContain('LAST-COLUMN-LLMGW'); expect(body).toContain('&lt;table&gt;');
      expect(body).toContain('返回'); expect(body).toContain('浅色主题'); expect(body).toContain('重新加载');
      expect(body).not.toContain('allow-same-origin');
      state.disableReportShare(meta.id);
      expect((await fetch(`${base}/r/${shareToken}`)).status).toBe(404);
    } finally { await flushAllJsonStateStores(); await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(dir, {recursive:true,force:true}); }
  });
});
