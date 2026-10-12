import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { runBrowserWorker } from '../src/quality/browser-worker.js';

const roots: string[] = [];

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function workspace(html: string): { workspaceDir: string; evidenceDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-quality-sample-'));
  roots.push(root);
  const workspaceDir = path.join(root, 'workspace');
  const evidenceDir = path.join(root, 'evidence');
  fs.mkdirSync(workspaceDir);
  fs.writeFileSync(path.join(workspaceDir, 'index.html'), html);
  return { workspaceDir, evidenceDir };
}

describe('isolated Chromium quality measurements', () => {
  it('detects every deterministic hard-gate category from a fixed broken sample', async () => {
    const sample = workspace(`<!doctype html><html><head><style>
      body{margin:0}.wide{width:1600px}.cta{position:absolute;left:1500px;background:#111;color:#fff}
      h1{color:rgb(119,119,119);background:rgb(119,119,119)}
      table{width:900px;table-layout:fixed}td{width:20px}
      @media(max-width:500px){nav a{display:none}}
    </style></head><body>
      <nav><a href="#section">Section</a></nav>
      <main class="wide"><h1>Invisible heading</h1><a href="">Empty</a><a href="#missing">Missing</a>
        <button class="cta">Primary action</button><table><tr><td>A</td><td>B</td></tr></table>
        <section id="section">Content</section></main>
    </body></html>`);

    const result = await runBrowserWorker({ ...sample, repairAttempt: 0 });
    const codes = new Set(result.measurements.flatMap((measurement) => measurement.issues.map((issue) => issue.issueCode)));

    expect(codes).toEqual(new Set([
      'horizontal_overflow',
      'main_content_clipped',
      'primary_cta_clipped',
      'empty_link',
      'broken_fragment_target',
      'mobile_navigation_unusable',
      'table_unreadable',
      'key_text_contrast_low',
    ]));
    expect(result.measurements.map((measurement) => measurement.viewport)).toEqual(['desktop', 'mobile']);
    expect(result.measurements.every((measurement) => fs.existsSync(path.join(sample.evidenceDir, path.basename(measurement.screenshotPath))))).toBe(true);
  }, 30_000);

  it('keeps desktop and mobile measurements separate for responsive failures', async () => {
    const sample = workspace(`<!doctype html><html><head><style>
      body{margin:0;color:#111;background:#fff}.content{width:700px;max-width:none}a{color:#111}
    </style></head><body><main class="content"><h1>Responsive sample</h1><a href="#ok">Action</a><section id="ok">Ready</section></main></body></html>`);

    const result = await runBrowserWorker({ ...sample, repairAttempt: 0 });
    const desktop = result.measurements.find((measurement) => measurement.viewport === 'desktop')!;
    const mobile = result.measurements.find((measurement) => measurement.viewport === 'mobile')!;

    expect(desktop.issues.map((issue) => issue.issueCode)).not.toContain('horizontal_overflow');
    expect(mobile.issues.map((issue) => issue.issueCode)).toContain('horizontal_overflow');
  }, 30_000);

  it('detects content clipped by an overflow ancestor and treats an empty fragment as an empty link', async () => {
    const sample = workspace(`<!doctype html><html><head><style>
      body{margin:0;color:#111;background:#fff}.frame{width:220px;height:120px;overflow:hidden}
      main{width:600px;height:300px}.cta{background:#111;color:#fff;margin-left:400px}
    </style></head><body><div class="frame"><main><h1>Clipped sample</h1><a href="#">Empty anchor</a>
      <button class="cta">Primary action</button></main></div></body></html>`);

    const result = await runBrowserWorker({ ...sample, repairAttempt: 0 });
    const codes = new Set(result.measurements.flatMap((measurement) => measurement.issues.map((issue) => issue.issueCode)));

    expect(codes).toContain('main_content_clipped');
    expect(codes).toContain('primary_cta_clipped');
    expect(codes).toContain('empty_link');
  }, 30_000);
});
