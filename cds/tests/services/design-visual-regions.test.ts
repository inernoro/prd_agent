import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compareDesignObservations, measureDesignPage } from '../../src/services/design-acceptance-observations.js';

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true,
    ...(process.env.CDS_CHROMIUM_PATH ? { executablePath: process.env.CDS_CHROMIUM_PATH } : { channel: 'chrome' }) });
});

afterAll(async () => { await browser?.close(); });

async function observe({ stripWidth = 640, secondTabOffset = 0 } = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, offline: true, serviceWorkers: 'block' });
  try {
    await page.setContent(`<!doctype html><meta charset="utf-8"><style>
      * { box-sizing: border-box; }
      body { margin: 20px; }
      .dw-head--draft { width: 1100px; height: 44px; }
      .dw-tablinks { display: flex; width: ${stripWidth}px; height: 44px; gap: 12px; overflow-x: auto; }
      .dw-tab { width: 60px; flex: none; }
      .dw-tab:nth-child(2) { transform: translateX(${secondTabOffset}px); }
    </style><header class="dw-head--draft">
      <nav class="dw-tablinks" aria-label="稿件标签">
        <button class="dw-tab" type="button" aria-current="true">交付</button>
        <button class="dw-tab" type="button">验收</button>
        <button class="dw-tab" type="button">记录</button>
      </nav>
    </header><main class="dw-workspace">正文</main>`);
    return await measureDesignPage(page);
  } finally {
    await page.close();
  }
}

describe('V-01 tab geometry', () => {
  it('measures unchanged controls independently of unused strip width', async () => {
    const reference = await observe({ stripWidth: 640 });
    const implementation = await observe({ stripWidth: 595 });
    expect(compareDesignObservations(reference, implementation, 0)['V-01']).toMatchObject({
      status: 'passed', evidence: expect.stringContaining('标签偏差 0 px'),
    });
  });

  it('detects a moved middle tab with an unchanged strip and adjacent tabs', async () => {
    const reference = await observe();
    const implementation = await observe({ secondTabOffset: 5 });
    expect(compareDesignObservations(reference, implementation, 0)['V-01']).toMatchObject({
      status: 'failed', evidence: expect.stringContaining('标签偏差 5 px'),
    });
  });
});

async function observeDialog({ infoOffset = 0, dialogOffset = 0 } = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, offline: true, serviceWorkers: 'block' });
  try {
    await page.setContent(`<!doctype html><meta charset="utf-8"><style>
      * { box-sizing: border-box; }
      body { margin: 20px; }
      .dw-info-panel { position: fixed; left: ${920 + infoOffset}px; top: 100px; width: 280px; height: 400px; }
      [role=dialog] { position: fixed; z-index: 40; left: ${420 + dialogOffset}px; top: 220px; width: 440px; height: 360px; }
    </style><body data-scroll-locked="1">
      <main class="dw-workspace" aria-hidden="true">
        <header class="dw-head--draft">
          <details open><summary>稿件信息</summary><div class="dw-info-panel">稿件元数据</div></details>
        </header>
        <p>正文</p>
      </main>
      <div role="dialog" aria-modal="true" aria-label="定为实施基线" data-state="open">
        <p class="dw-consequences">原基线的验收记录会保留</p>
      </div>
    </body>`);
    return await measureDesignPage(page);
  } finally {
    await page.close();
  }
}

describe('V-01 active dialog geometry', () => {
  it('excludes geometry of an underlying open info panel', async () => {
    const reference = await observeDialog();
    const implementation = await observeDialog({ infoOffset: 30 });
    expect(compareDesignObservations(reference, implementation, 0)['V-01']).toMatchObject({
      status: 'passed', evidence: expect.stringContaining('浮层偏差 0 px'),
    });
  });

  it('detects a shifted active confirmation above the same info panel', async () => {
    const reference = await observeDialog();
    const implementation = await observeDialog({ dialogOffset: 8 });
    expect(compareDesignObservations(reference, implementation, 0)['V-01']).toMatchObject({
      status: 'failed', evidence: expect.stringContaining('浮层偏差 8 px'),
    });
  });
});
