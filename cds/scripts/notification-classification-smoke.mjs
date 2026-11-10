/** Local browser regression for the actual editor, parent state and API serialization. */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
const base = process.argv[2] || 'http://127.0.0.1:8870';
if (!/^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(base)) throw Error('Only a local fixture server is allowed');
const web = fileURLToPath(new URL('../web', import.meta.url));
const report = { id: 'classification-fixture', title: '交叉分类保存回归', format: 'md', projectId: null, folderId: null,
  sizeBytes: 32, createdAt: '2026-11-11T00:00:00Z', updatedAt: '2026-11-11T00:00:00Z' };
const bundled = await build({ stdin: { contents: `import React from 'react';import{createRoot}from'react-dom/client';import{ClassificationSummary}from'./src/components/ReportClassification';function Fixture(){const[r,set]=React.useState(${JSON.stringify(report)});return <ClassificationSummary report={r} onSaved={set}/>};createRoot(document.getElementById('root')).render(<Fixture/>);`,
  resolveDir: web, loader: 'tsx' }, tsconfig: path.join(web, 'tsconfig.json'), bundle: true, write: false, format: 'iife',
  jsx: 'automatic', platform: 'browser', define: { 'process.env.NODE_ENV': '"production"' } });
const css = (await fs.readdir(path.join(web, 'dist/assets'))).find(x => x.endsWith('.css'));
assert(css, 'Build the actual web assets before this regression');
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 940 } });
const saved = [], errors = [];
await context.route(base + '/classification-fixture', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html data-theme="light"><head><link rel="stylesheet" href="/assets/${css}"></head><body><div id="root"></div><script>${bundled.outputFiles[0].text.replaceAll('</script>', '<\\/script>')}</script></body></html>` }));
await context.route('**/api/**', async route => {
  const p = new URL(route.request().url()).pathname.replace(/^\/_cds/, '');
  assert.equal(p, `/api/reports/${report.id}`);
  assert.equal(route.request().method(), 'PATCH');
  const input = route.request().postDataJSON();
  // Express parses a JSON string as a string, which has no classification field.
  if (typeof input !== 'object' || !input.classification) return route.fulfill({ status: 400, json: { error: 'nothing_to_update' } });
  saved.push(input); Object.assign(report, input);
  return route.fulfill({ json: { report } });
});
try {
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto(base + '/classification-fixture');
  await page.getByRole('button', { name: '编辑交叉分类', exact: true }).click();
  const dialog = page.getByRole('dialog');
  for (const name of ['功能结果', '上游依赖', 'MAP', 'LLMGW', '正式', '测试', '环境待确认']) await dialog.getByRole('button', { name, exact: true }).click();
  await dialog.getByRole('button', { name: '保存分类', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0].classification, { categories: ['result', 'upstream'], primarySystem: 'map', relatedSystems: ['llmgw'], environments: ['production', 'test'] });
  const summary = await page.locator('[aria-label="报告交叉分类"]').innerText();
  assert(summary.includes('关联 LLMGW')); assert(summary.includes('正式、测试')); assert(!summary.includes('系统待确认'));
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: 'pass', request: 'raw object serialized once', crossClassificationSaved: true, relatedSystemPreserved: true }));
} finally { await browser.close(); }
