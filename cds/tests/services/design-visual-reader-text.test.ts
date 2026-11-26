import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compareDesignObservations, measureDesignPage } from '../../src/services/design-acceptance-observations.js';

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true,
    ...(process.env.CDS_CHROMIUM_PATH ? { executablePath: process.env.CDS_CHROMIUM_PATH } : { channel: 'chrome' }),
  });
});

afterAll(async () => { await browser?.close(); });

async function scanReader(body: string, portal = '') {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
  try {
    await page.setContent(`<!doctype html><meta charset="utf-8"><main><article class="dw-dl-contents">${body}</article></main>${portal}`);
    const observation = await measureDesignPage(page);
    return { observation, check: compareDesignObservations(observation, observation, 0)['V-05'] };
  } finally {
    await page.close();
  }
}

describe('V-05 visible reader text evidence', () => {
  const readerNoise = [
    ['原样 Markdown 链接', 'Markdown', 'FIXTURE_LINK_CANARY', '详见 [交付说明](https://example.invalid/FIXTURE_LINK_CANARY)。'],
    ['原样 Markdown 加粗', 'Markdown', 'FIXTURE_STRONG_CANARY', '当前结论是 **FIXTURE_STRONG_CANARY**。'],
    ['原样 Markdown 行内代码', 'Markdown', 'FIXTURE_BACKTICK_CANARY', '打开 `FIXTURE_BACKTICK_CANARY` 查看。'],
    ['转义 HTML', 'HTML', 'FIXTURE_TAG_CANARY', '可以看到 &lt;button type="button"&gt;FIXTURE_TAG_CANARY&lt;/button&gt;。'],
    ['行内原样 JSON', 'JSON', 'FIXTURE_JSON_CANARY', '接口结果 {"title":"FIXTURE_JSON_CANARY"}。'],
  ];

  it.each(readerNoise)('只记类别和数量，当正文误露%s', async (_description, category, canary, line) => {
    const { observation, check } = await scanReader(`<p>${line}</p>`);
    expect(check).toMatchObject({ status: 'failed', evidence: expect.stringContaining(category) });
    expect(check?.evidence).toMatch(/\d/);
    expect(JSON.stringify({ observation, check })).not.toContain(canary);
  });

  it('报告源码示例内的疑似凭据，即使它在主内容外的可见弹窗里', async () => {
    const canary = 'synthetic-fixture-bearer-canary-000000000000';
    const portal = `<div role="dialog" aria-label="示例全文"><pre><code>curl -H 'Authorization: Bearer ${canary}'</code></pre></div>`;
    const { observation, check } = await scanReader('<p>交付说明</p>', portal);
    expect(check).toMatchObject({ status: 'failed', evidence: expect.stringContaining('凭据') });
    expect(check?.evidence).toMatch(/\d/);
    expect(JSON.stringify({ observation, check })).not.toContain(canary);
  });

  it('语义化读者页面和合法的验收编号不产生原样文本故障', async () => {
    const { check } = await scanReader(`<h2>交付说明</h2>
      <p>查阅 <a href="https://example.invalid/guide">指南</a>，<strong>复核规则</strong> <code>A-01</code>，误差 &lt; 1 px。</p>`);
    expect(check).toMatchObject({ status: 'missing' });
  });

  it('源码区有意展示的 Markdown 和 JSON 保留，隐藏内容不计入读者视图', async () => {
    const { check } = await scanReader(`<p>下面是示例源码。</p><pre><code>### 示例
[指南](https://example.invalid/code)
{"title":"示例"}</code></pre><p hidden>### 读者看不到的标题</p>`);
    expect(check).toMatchObject({ status: 'missing' });
  });
});
