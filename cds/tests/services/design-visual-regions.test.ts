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
